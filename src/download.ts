import AXIOS from 'axios';
import ZIP from 'adm-zip';
import PLIMIT from 'p-limit';
import PATH from 'path';
import FSE from 'fs-extra';
import CROWDIN from '@crowdin/crowdin-api-client';
import * as ACTIONS from '@actions/core';

import STRINGS from './strings';
import { wait, exec, normalize } from './utils';
import { PROJECT_ID, CROWDIN_PAT, JEST_RUN } from './constants';

if (!CROWDIN_PAT && !JEST_RUN) {
	ACTIONS.error('Environment variable CROWDIN_PAT not provided, skipping action');
	process.exit(0);
}

const { reportsApi, translationsApi, usersApi, projectsGroupsApi, sourceFilesApi, sourceStringsApi, translationStatusApi } = new CROWDIN({
	token: CROWDIN_PAT || ''
});

/**
 * Retrieves submodules with translatable files.
 * @returns A list of submodules with translataable files.
 */
async function getSubmodules(): Promise<string[]> {
	const submodules = [];
	for (const line of exec('git config --file .gitmodules --get-regexp path').trimEnd().split('\n')) {
		const submodulePath = line.split(' ')[1];
		if (await FSE.pathExists(`${submodulePath}/data/locale/en-US.ini`)) {
			submodules.push(submodulePath.split('/')[1]);
		}
	}
	return submodules;
}

/**
 * Remove all translations to prevent keeping dropped languages.
 * @param sourceFilePaths List of soure file export paths.
 */
export async function removePreviousTranslations(sourceFilePaths: string[]): Promise<void> {
	let pathsToClear: string[] = ['frontend/data/locale', 'plugins/mac-virtualcam/src/obs-plugin/data/locale'];
	for (const pluginRootDir of ['plugins', 'frontend/plugins']) {
		if (!(await FSE.pathExists(pluginRootDir))) {
			continue;
		}
		for (const pluginDir of await FSE.readdir(pluginRootDir)) {
			pathsToClear.push(`${pluginRootDir}/${pluginDir}/data/locale`);
		}
	}
	for (const path of pathsToClear) {
		if (!(await FSE.pathExists(path))) {
			continue;
		}
		for (const file of await FSE.readdir(path)) {
			if (file !== `${STRINGS.englishLanguage.locale}.ini` && sourceFilePaths.includes(path)) {
				await FSE.remove(`${path}/${file}`);
			}
		}
	}
}

/**
 * Finds submodules uneven with the main repository and checkouts `master` branch.
 * @param submodules A list of submodules.
 * @returns List of detached submodules in the repository.
 */
function getDetachedSubmodules(submodules: string[]): string[] {
	const detachedSubmodules: string[] = [];
	for (const submodule of submodules) {
		process.chdir(`plugins/${submodule}`);
		if (exec('git diff master HEAD').length !== 0) {
			detachedSubmodules.push(submodule);
		}
		exec('git checkout master');
		process.chdir('../..');
	}
	return detachedSubmodules;
}

/**
 * Mappes file ids to their export paths.
 * @returns File ids mapped to their export path.
 */
export async function getFilePaths(): Promise<Map<number, string>> {
	const filePaths = new Map<number, string>();
	for (const { data: file } of (await sourceFilesApi.withFetchAll().listProjectFiles(PROJECT_ID)).data) {
		const fileName = file.name;
		const exportPattern = file.exportOptions.exportPattern.replace('%file_name%', fileName.substring(0, fileName.indexOf('.')));
		filePaths.set(file.id, exportPattern.substring(1, exportPattern.lastIndexOf('/')));
	}
	return filePaths;
}

/**
 * Maps source file ids to source string keys and source text.
 * @param filePaths File ids mapped to their export path.
 * @returns Source file ids mapped to source string keys and source text.
 */
export async function getSourceFiles(filePaths: Map<number, string>): Promise<Map<number, Map<string, string>>> {
	const sourceFiles = new Map<number, Map<string, string>>();
	let currentFileId;
	let currentFileStrings: Map<string, string> | undefined;
	for (const { data: sourceString } of (await sourceStringsApi.withFetchAll().listProjectStrings(PROJECT_ID)).data) {
		const { fileId } = sourceString;
		const filePath = filePaths.get(fileId);
		const rootDir = filePath?.substring(0, filePath.indexOf('/'));
		if (filePaths.has(fileId) && !['frontend', 'plugins'].includes(rootDir!)) {
			continue;
		}
		if (fileId !== currentFileId) {
			if (typeof currentFileId !== 'undefined') {
				sourceFiles.set(currentFileId, currentFileStrings!);
			}
			currentFileId = fileId;
			if (sourceFiles.has(currentFileId)) {
				currentFileStrings = sourceFiles.get(currentFileId);
			} else {
				currentFileStrings = new Map<string, string>();
			}
		}
		currentFileStrings!.set(sourceString.identifier, sourceString.text as string);
	}
	return sourceFiles;
}

/**
 * Build the final string to be saved to the AUTHORS file.
 * @param gitContributors Output of getGitContributors()
 * @param translators Output of getTranslators()
 */
async function generateAuthors(gitContributors: string, translators: string): Promise<void> {
	await FSE.writeFile(STRINGS.authors.fileName, `${STRINGS.authors.header}${gitContributors}${translators}`);
}

/**
 * Uses `git shortlog` to get a list Git contributors.
 * @returns List of contributors, with heading
 */
function getGitContributors(): string {
	let output = `${STRINGS.authors.contributors}:\n`;
	for (const line of exec('git shortlog --all -sn --no-merges').split('\n')) {
		const contributor = line.substring(line.indexOf('\t') + 1);
		if (contributor !== STRINGS.git.committer.name) {
			output += ` ${contributor}\n`;
		}
	}
	return output;
}

/**
 * Gets all translators from the Crowdin project.
 * @param targetLanguageIds List of project target language ids.
 * @returns List of translators, with heading.
 */
export async function getTranslators(targetLanguageIds: string[]): Promise<string> {
	// free test projects don't have access to reports, so return to avoid error
	if (process.env.CROWDIN_PROJECT_ID && !JEST_RUN) {
		return '';
	}
	const blockedUsers: number[] = [];
	for (const { data: blockedUser } of (await usersApi.withFetchAll().listProjectMembers(PROJECT_ID, { role: 'blocked' })).data) {
		blockedUsers.push(blockedUser.id);
	}

	const topMembers = new Map<string, string[]>();
	for (const languageId of targetLanguageIds) {
		const { status: reportStatus, identifier: reportId } = (
			await reportsApi.generateReport(PROJECT_ID, {
				name: 'top-members',
				schema: {
					unit: 'words',
					format: 'json',
					dateFrom: '2014-01-01T00:00:00+00:00',
					dateTo: new Date().getFullYear() + '-12-31T23:59:59+00:00',
					languageId
				}
			})
		).data;
		let finished = reportStatus === 'finished';
		while (!finished) {
			await wait(1000);
			finished = (await reportsApi.checkReportStatus(PROJECT_ID, reportId)).data.status === 'finished';
		}
		let reportData = (await AXIOS.get((await reportsApi.downloadReport(PROJECT_ID, reportId)).data.url)).data;

		if (!('data' in reportData)) {
			continue;
		}
		const languageName: string = reportData.language.name;
		let members: string[];
		if (topMembers.has(languageName)) {
			members = topMembers.get(languageName)!;
		} else {
			members = [];
		}
		for (const userObj of reportData.data) {
			const fullName: string = userObj.user.fullName;
			if (fullName === 'REMOVED_USER' || blockedUsers.includes(Number(userObj.user.id))) {
				continue;
			}
			if (userObj.translated === 0 && userObj.approved === 0) {
				continue;
			}
			members.push(fullName);
		}
		topMembers.set(languageName, members);
	}

	let output = `${STRINGS.authors.translators}:\n`;
	for (const language of new Map([...topMembers].sort((a, b) => String(a[0]).localeCompare(b[0]))).keys()) {
		output += ` ${language}:\n`;
		for (const user of topMembers.get(language)!) {
			output += `  ${user}\n`;
		}
	}
	return output;
}

/**
 * Builds the Crowdin project.
 * @returns The build id.
 */
export async function buildTranslations(): Promise<number> {
	const appDirId = (await sourceFilesApi.listProjectDirectories(PROJECT_ID, { filter: 'App' })).data[0].data.id;
	const { id, status } = (await translationsApi.buildProjectDirectoryTranslation(PROJECT_ID, appDirId, { skipUntranslatedStrings: true }))
		.data;
	let finished = status === 'finished';
	while (!finished) {
		await wait(5000);
		finished = (await translationsApi.checkBuildStatus(PROJECT_ID, id)).data.status === 'finished';
	}
	return id;
}

/**
 * Executes multiple language-related operations.
 * @returns An object containing the properties `targetLanguageIds` and `languageCodeMap`.
 */
export async function getLanguages(): Promise<{
	targetLanguageIds: string[];
	languageCodeMap: Map<string, string>;
}> {
	const projectData = (await projectsGroupsApi.getProject(PROJECT_ID)).data;
	const languageCodeMap = new Map<string, string>(); // <locale, languageId>
	for (const language of projectData.targetLanguages) {
		languageCodeMap.set(language.locale, language.id);
	}
	return {
		languageCodeMap,
		targetLanguageIds: projectData.targetLanguageIds
	};
}

/**
 * Downloads the build, trims the translation files and moves them to their directories.
 * @param buildId Build id.
 * @param sourceFiles Source files mapped to source string keys and their source text.
 * @param filePaths File ids mapped to their export path.
 * @returns An object containing the properties `desktopFileTranslations` and `languageList`.
 */
export async function processBuild(
	buildId: number,
	sourceFiles: Map<number, Map<string, string>>,
	filePaths: Map<number, string>
): Promise<{
	desktopFileTranslations: Map<string, Map<string, string>>;
	languageList: Map<string, string>;
}> {
	const translatedSourceMap = new Map<string, Map<string, string>>(); // <filePath, <stringKey, stringText>> Paths mapped to source strings insteaad of file ids.
	for (const key of sourceFiles.keys()) {
		if (filePaths.has(key)) {
			translatedSourceMap.set(filePaths.get(key)!, sourceFiles.get(key)!);
		}
	}

	const build = new ZIP(
		(await AXIOS.get((await translationsApi.downloadTranslations(PROJECT_ID, buildId)).data.url, { responseType: 'arraybuffer' })).data
	);
	const desktopFileTranslations = new Map<string, Map<string, string>>(); // <locale, <stringKey, translation>>
	const languageList = new Map<string, string>(); // <locale, localeLanguageName>
	const missingDirs: string[] = [];
	for (const zipEntry of build.getEntries()) {
		const entryFullPath = zipEntry.entryName;
		const { dir: entryDir, name: entryName } = PATH.parse(entryFullPath);
		let fileContent = normalize(build.readAsText(zipEntry));
		if (fileContent.length === 0) {
			continue;
		}

		let fixedLineBreaks = '';
		for (const line of fileContent.trimEnd().split('\n')) {
			fixedLineBreaks += (line.includes('="') && !line.endsWith('="') ? '\n' : '\\n') + line;
		}
		fileContent = fixedLineBreaks.trimStart();

		if (entryDir === 'desktop-entry') {
			const translations = new Map<string, string>();
			for (const line of fileContent.split('\n')) {
				translations.set(line.substring(0, line.indexOf('=')), line.substring(line.indexOf('"') + 1, line.lastIndexOf('"')));
			}
			desktopFileTranslations.set(entryName, translations);
			continue;
		}
		// Remove translations equal to source.
		let translationContent = '';
		if (translatedSourceMap.has(entryDir)) {
			let readLanguageName = false;
			if (entryDir === 'frontend/data/locale') {
				readLanguageName = true;
			}
			for (const line of fileContent.split('\n')) {
				const key = line.substring(0, line.indexOf('='));
				const value = line.substring(line.indexOf('"') + 1, line.length - 1);
				if (value !== translatedSourceMap.get(entryDir)!.get(key)) {
					translationContent += `${line}\n`;
					if (readLanguageName && key === 'Language') {
						languageList.set(entryName, value);
						readLanguageName = false;
					}
				}
			}
			if (translationContent.length === 0) {
				translationContent = '#';
			}
		} else {
			translationContent = `${fileContent}\n`;
		}
		if (!(await FSE.pathExists(entryDir))) {
			if (missingDirs.includes(entryDir)) {
				continue;
			}
			ACTIONS.notice(`${entryDir} doesn't exist in the codebase. Remove this file on Crowdin.`);
			missingDirs.push(entryDir);
			continue;
		}
		await FSE.writeFile(entryFullPath, translationContent);
	}
	return {
		desktopFileTranslations: new Map([...desktopFileTranslations].sort((a, b) => a[0].localeCompare(b[0]))),
		languageList
	};
}

/**
 * Updates `com.obsproject.Studio.desktop` file with translations.
 * @param languageFiles Locales mapped to their desktop file translations.
 */
export async function createDesktopFile(languageFiles: Map<string, Map<string, string>>): Promise<void> {
	const filePath = 'frontend/cmake/linux/com.obsproject.Studio.desktop';
	const desktopFile = normalize(await FSE.readFile(filePath, 'utf-8'));
	let result = '';
	for (const line of desktopFile.split('\n')) {
		if (line.length === 0) {
			continue;
		}
		if (!(line.startsWith('GenericName[') || line.startsWith('Comment['))) {
			result += `${line}\n`;
		}
	}
	result += '\n';
	for (const language of languageFiles.entries()) {
		for (const translation of language[1].entries()) {
			result += `${translation[0]}[${language[0]}]=${translation[1]}\n`;
		}
	}
	await FSE.writeFile(filePath, result);
}

/**
 * Updates `locale.ini` file with languages.
 * @param languageList Locales mapped to their locale language name.
 * @param languageCodeMap Locales mapped to their language id.
 */
export async function createLocaleFile(languageList: Map<string, string>, languageCodeMap: Map<string, string>): Promise<void> {
	const progressMap = new Map<string, number>(); // <languageId, translationProgress>
	for (const { data: language } of (await translationStatusApi.withFetchAll().getProjectProgress(PROJECT_ID)).data) {
		progressMap.set(language.languageId, language.translationProgress);
	}
	const languagesInList = [];
	const languagueListPath = 'frontend/data/locale.ini';
	for (const line of normalize(await FSE.readFile(languagueListPath, 'utf-8')).split('\n')) {
		if (line.startsWith('[') && line !== `[${STRINGS.englishLanguage.locale}]`) {
			languagesInList.push(line.substring(1, line.length - 1));
		}
	}
	const finalLanguages = [];
	for (const [locale, languageId] of languageCodeMap.entries()) {
		if (progressMap.has(languageId)) {
			const progress = progressMap.get(languageId)!;
			if ((languagesInList.includes(locale) && progress >= 30) || progress >= 60) {
				finalLanguages.push(locale);
			}
		}
	}
	finalLanguages.push(STRINGS.englishLanguage.locale);
	languageList.set(STRINGS.englishLanguage.locale, STRINGS.englishLanguage.name);
	let result = '';
	for (const locale of finalLanguages.sort()) {
		if (languageList.has(locale)) {
			result += `[${locale}]\nName=${languageList.get(locale)}\n\n`;
		} else {
			ACTIONS.error(`${locale} is missing a translation for its language name and could therefore not be included in the language list.`);
		}
	}
	await FSE.writeFile(languagueListPath, `${result.trimEnd()}\n`);
}
/**
 * Pushes all changes to the submodules and the main repository.
 * @param detachedSubmodules List of detached submodules in the repository.
 * @param submodules A list of submodules.
 */
function pushChanges(detachedSubmodules: string[], submodules: string[]): void {
	if (process.env.CROWDIN_SYNC_SKIP_PUSH) {
		return;
	}
	exec(`git config --global user.name '${STRINGS.git.committer.name}'`);
	exec(`git config --global user.email '${STRINGS.git.committer.email}'`);
	for (const submodule of submodules) {
		process.chdir(`plugins/${submodule}`);
		if (exec('git status --porcelain').trim().length === 0) {
			process.chdir('../..');
			continue;
		}
		exec('git add data/locale/*-*.ini');
		if (exec('git diff --compact-summary').trim().length === 0) {
			process.chdir('../..');
			continue;
		}
		exec(`git commit -m '${STRINGS.git.commitTitle}'`);
		exec('git push');
		process.chdir('../..');
	}
	for (const allowedPath of [
		'AUTHORS',
		'plugins/*/data/locale/*-*.ini',
		'plugins/mac-virtualcam/src/obs-plugin/data/locale/*-*.ini',
		'frontend/data/locale.ini',
		'frontend/data/locale/*-*.ini',
		'frontend/cmake/linux/com.obsproject.Studio.desktop',
		'frontend/plugins/*/data/locale/*-*.ini'
	]) {
		exec(`git add '${allowedPath}'`);
	}
	for (const submodule of submodules) {
		exec(`git add plugins/${submodule}`);
	}
	for (const submodule of detachedSubmodules) {
		ACTIONS.info(`${submodule} has commits not pushed to the main repository. Only pushing to submodule.`);
		exec(`git checkout HEAD -- plugins/${submodule}`);
		exec(`git submodule update --init plugins/${submodule}`);
	}
	if (exec('git status --porcelain').length === 0) {
		ACTIONS.info('No changes in main repository. Skipping push.');
		return;
	}
	exec(`git commit -m '${STRINGS.git.commitTitle}'`);
	exec('git push');
}

(async () => {
	if (JEST_RUN) {
		return;
	}
	try {
		await removePreviousTranslations(Array.from((await getFilePaths()).values()));
		const submodules = await getSubmodules();
		const results = [];
		results[0] = await Promise.all([getDetachedSubmodules(submodules), getFilePaths(), buildTranslations(), getLanguages()]);
		results[1] = await Promise.all([
			generateAuthors(getGitContributors(), await getTranslators(results[0][3].targetLanguageIds)),
			processBuild(results[0][2], await getSourceFiles(results[0][1]), results[0][1])
		]);
		await createLocaleFile(results[1][1].languageList, results[0][3].languageCodeMap);
		await createDesktopFile(results[1][1].desktopFileTranslations);
		pushChanges(results[0][0], submodules);
	} catch (e) {
		ACTIONS.setFailed(e as Error);
	}
})();
