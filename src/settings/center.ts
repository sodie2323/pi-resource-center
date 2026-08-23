/**
 * 资源中心自身设置的读写与维护逻辑。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { canExposeResource } from "../resource/capabilities.js";
import { getCodexPluginInventory } from "../resource/codex-plugin-inventory.js";
import { pruneExposedResourceEntries, prunePinnedResourceIds } from "../resource/state-prune.js";
import type { ResourceIndex, ResourceItem } from "../types.js";
import {
	DEFAULT_EXTERNAL_SKILL_SOURCES,
	DEFAULT_RESOURCE_CENTER_SETTINGS,
	getResourceCenterSettingsPath,
	getUserSettingsPath,
	inferPackageRelativePath,
	isFileNotFoundError,
	normalizeConfigPath,
	resolveHomePath,
	toErrorMessage,
	USER_AGENT_DIR,
	type ExposedResourceEntry,
	type ExternalSkillSourceSetting,
	type ResourceCenterSettings,
	type ResourceCenterSettingsFile,
} from "./shared.js";

async function readResourceCenterSettingsFile(): Promise<ResourceCenterSettingsFile> {
	const path = getResourceCenterSettingsPath();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ResourceCenterSettingsFile>;
		return {
			...DEFAULT_RESOURCE_CENTER_SETTINGS,
			...parsed,
			externalSkillSources: mergeExternalSkillSourcesWithDefaults(parsed.externalSkillSources),
			exposedResources: parsed.exposedResources,
		};
	} catch (error: unknown) {
		if (isFileNotFoundError(error)) {
			return {
				...DEFAULT_RESOURCE_CENTER_SETTINGS,
				externalSkillSources: DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => ({ ...source })),
			};
		}
		if (error instanceof SyntaxError) throw new Error(`Failed to parse resource center settings ${path}: ${error.message}`);
		throw new Error(`Failed to read resource center settings ${path}: ${toErrorMessage(error)}`);
	}
}

async function saveResourceCenterSettingsFile(file: ResourceCenterSettingsFile): Promise<string> {
	const path = getResourceCenterSettingsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	return path;
}

export async function readResourceCenterSettings(): Promise<ResourceCenterSettings> {
	const file = await readResourceCenterSettingsFile();
	const {
		exposedResources: _exposed,
		externalSkillSyncEntries: _syncEntries,
		showSource: _legacyShowSource,
		showPath: _legacyShowPath,
		showPathInPackage: _legacyShowPathInPackage,
		...settings
	} = file as ResourceCenterSettingsFile & Record<string, unknown>;
	return settings;
}

export async function saveResourceCenterSettings(settings: ResourceCenterSettings, resources?: ResourceIndex): Promise<string> {
	let file: ResourceCenterSettingsFile;
	try {
		file = await readResourceCenterSettingsFile();
	} catch {
		file = {
			...DEFAULT_RESOURCE_CENTER_SETTINGS,
			externalSkillSources: DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => ({ ...source })),
		};
	}

	const previousExternalSkillSources = file.externalSkillSources ?? DEFAULT_EXTERNAL_SKILL_SOURCES;
	const previousDisabledExternalSkills = file.disabledExternalSkills ?? [];
	const prunedSettings = resources ? prunePinnedResourceIds(settings, resources) : settings;
	const exposedResources = resources ? pruneExposedResourceEntries(file.exposedResources, resources) : file.exposedResources;
	const {
		showSource: _legacyShowSource,
		showPath: _legacyShowPath,
		showPathInPackage: _legacyShowPathInPackage,
		...currentFile
	} = file as ResourceCenterSettingsFile & Record<string, unknown>;
	const nextFile = { ...currentFile, ...prunedSettings, exposedResources } as ResourceCenterSettingsFile;
	const savedPath = await saveResourceCenterSettingsFile(nextFile);
	const externalSourcesChanged = JSON.stringify(previousExternalSkillSources) !== JSON.stringify(nextFile.externalSkillSources);
	const disabledSkillsChanged = !areStringArraysEqual(previousDisabledExternalSkills, nextFile.disabledExternalSkills ?? []);
	if (externalSourcesChanged || disabledSkillsChanged) {
		await syncExternalSkillSourcesToPiSettings(previousExternalSkillSources, nextFile.externalSkillSources, nextFile.disabledExternalSkills);
	}
	return savedPath;
}

export async function setExternalSkillEnabled(externalSkillId: string, enabled: boolean): Promise<string> {
	return setExternalSkillsEnabled([externalSkillId], enabled);
}

export async function setExternalSkillsEnabled(externalSkillIds: Iterable<string>, enabled: boolean): Promise<string> {
	const settingsPath = getResourceCenterSettingsPath();
	const targetIds = new Set(externalSkillIds);
	try {
		const file = await readResourceCenterSettingsFile();
		const nextDisabled = new Set(file.disabledExternalSkills ?? []);
		for (const externalSkillId of targetIds) {
			if (enabled) nextDisabled.delete(externalSkillId);
			else nextDisabled.add(externalSkillId);
		}
		const nextFile = { ...file, disabledExternalSkills: [...nextDisabled].sort() };
		await saveResourceCenterSettingsFile(nextFile);
		await syncExternalSkillSourcesToPiSettings(file.externalSkillSources, nextFile.externalSkillSources, nextFile.disabledExternalSkills);
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to ${enabled ? "enable" : "disable"} ${targetIds.size} external skill(s) via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function getExposedResources(_cwd: string): Promise<ExposedResourceEntry[]> {
	try {
		const file = await readResourceCenterSettingsFile();
		return file.exposedResources ?? [];
	} catch (error: unknown) {
		throw new Error(`Failed to read exposed resources: ${toErrorMessage(error)}`);
	}
}

export async function syncPrunedExposedResources(resources: ResourceIndex): Promise<void> {
	const file = await readResourceCenterSettingsFile();
	const nextEntries = pruneExposedResourceEntries(file.exposedResources, resources);
	if (areExposedEntriesEqual(file.exposedResources, nextEntries)) return;
	await saveResourceCenterSettingsFile({ ...file, exposedResources: nextEntries });
}

function areExposedEntriesEqual(left: ExposedResourceEntry[] | undefined, right: ExposedResourceEntry[] | undefined): boolean {
	if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
	return (left ?? []).every((entry, index) => {
		const other = right?.[index];
		return Boolean(
			other &&
			entry.scope === other.scope &&
			entry.category === other.category &&
			entry.package === other.package &&
			entry.path === other.path,
		);
	});
}

export async function setResourceExposed(_cwd: string, item: ResourceItem, exposed: boolean): Promise<string> {
	if (!canExposeResource(item)) {
		throw new Error("Only package-contained extensions, skills, and prompts can be exposed");
	}
	const exposureItem = item;
	const entryPath = exposureItem.packageRelativePath ?? inferPackageRelativePath(exposureItem);
	const settingsPath = getResourceCenterSettingsPath();
	try {
		const file = await readResourceCenterSettingsFile();
		const entries = [...(file.exposedResources ?? [])];
		const normalizedPath = normalizeConfigPath(entryPath);
		const nextEntries = entries.filter(
			(entry) => !(entry.scope === exposureItem.scope && entry.category === exposureItem.category && entry.package === exposureItem.packageSource && normalizeConfigPath(entry.path) === normalizedPath),
		);
		if (exposed) nextEntries.push({ scope: exposureItem.scope, category: exposureItem.category, package: exposureItem.packageSource, path: entryPath });
		await saveResourceCenterSettingsFile({ ...file, exposedResources: nextEntries.length ? nextEntries : undefined });
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to ${exposed ? "expose" : "hide"} ${exposureItem.name} in ${exposureItem.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function syncExternalSkillSourcesToPiSettings(
	previousSources: ExternalSkillSourceSetting[],
	nextSources: ExternalSkillSourceSetting[],
	disabledExternalSkills: Iterable<string> = [],
): Promise<string> {
	const settingsPath = getUserSettingsPath();
	const settingsManager = SettingsManager.create(process.cwd(), USER_AGENT_DIR, { projectTrusted: false });
	const settingsDir = dirname(settingsPath);
	const previousSkills = settingsManager.getGlobalSettings().skills ?? [];
	const nextSkills = [...previousSkills];
	const centerFile = await readResourceCenterSettingsFile();
	const previousManagedEntries = centerFile.externalSkillSyncEntries;

	if (previousManagedEntries) {
		removeExactManagedEntries(nextSkills, previousManagedEntries);
	} else {
		// One-time migration from versions that inferred ownership from directory roots.
		// Only clean sources that were actually enabled, then switch to exact-entry tracking.
		await cleanupLegacyExternalSkillEntries(nextSkills, settingsDir, previousSources, nextSources);
	}

	const disabledExternalSkillIds = new Set(disabledExternalSkills);
	const nextManagedEntries: string[] = [];
	for (const source of nextSources) {
		if (!source.enabled) continue;
		if (isCodexPluginSource(source)) {
			const entries = await collectCodexPluginSkillEntries(source.id, resolveHomePath(source.path));
			for (const skillsRoot of Array.from(new Set(entries.map((entry) => entry.skillsRoot))).sort()) {
				appendManagedEntry(nextSkills, nextManagedEntries, skillsRoot.replace(/\\/g, "/"), settingsDir);
			}
			for (const entry of entries) {
				if (disabledExternalSkillIds.has(entry.externalSkillId)) {
					appendManagedEntry(nextSkills, nextManagedEntries, `-${entry.path.replace(/\\/g, "/")}`, settingsDir);
				}
			}
			continue;
		}
		appendManagedEntry(nextSkills, nextManagedEntries, source.path.replace(/\\/g, "/"), settingsDir);
	}

	if (!areStringArraysEqual(previousSkills, nextSkills)) {
		settingsManager.setSkillPaths(nextSkills);
		await settingsManager.flush();
	}
	if (!areStringArraysEqual(previousManagedEntries ?? [], nextManagedEntries)) {
		await saveResourceCenterSettingsFile({ ...centerFile, externalSkillSyncEntries: nextManagedEntries });
	}
	return settingsPath;
}

function mergeExternalSkillSourcesWithDefaults(sources: ExternalSkillSourceSetting[] | undefined): ExternalSkillSourceSetting[] {
	const defaultsById = new Map(DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => [source.id, source]));
	const merged = new Map<string, ExternalSkillSourceSetting>();
	for (const source of DEFAULT_EXTERNAL_SKILL_SOURCES) {
		merged.set(source.id, { ...source });
	}
	for (const source of sources ?? []) {
		const defaultSource = defaultsById.get(source.id);
		const mergedSource = defaultSource ? { ...defaultSource, ...source } : { ...source };
		if (mergedSource.id === "codex-plugins" && mergedSource.path === "~/.codex/plugins/cache") {
			mergedSource.path = "~/.codex/plugins";
		}
		merged.set(source.id, mergedSource);
	}
	return Array.from(merged.values());
}

function isCodexPluginSource(source: ExternalSkillSourceSetting): boolean {
	return source.integration === "codex-plugin-cache" || source.id === "codex-plugins";
}

async function cleanupLegacyExternalSkillEntries(
	entries: string[],
	settingsDir: string,
	previousSources: ExternalSkillSourceSetting[],
	nextSources: ExternalSkillSourceSetting[],
): Promise<void> {
	const nextById = new Map(nextSources.map((source) => [source.id, source]));
	for (const previous of previousSources) {
		if (!previous.enabled) continue;
		const next = nextById.get(previous.id);
		const sourceChanged = !next || !next.enabled || resolveHomePath(previous.path) !== resolveHomePath(next.path);
		if (!sourceChanged) continue;
		for (const entry of await getLegacyGeneratedRootEntries(previous)) removeOneSemanticEntry(entries, settingsDir, entry);
	}
	// Claim only exact roots that older Resource Center versions generated. Never remove
	// arbitrary descendants during migration.
	for (const next of nextSources) {
		if (!next.enabled) continue;
		for (const entry of await getLegacyGeneratedRootEntries(next)) removeOneSemanticEntry(entries, settingsDir, entry);
	}
}

async function getLegacyGeneratedRootEntries(source: ExternalSkillSourceSetting): Promise<string[]> {
	if (!isCodexPluginSource(source)) return [source.path.replace(/\\/g, "/")];
	return (await getCodexPluginInventory(resolveHomePath(source.path))).map((plugin) => plugin.skillsRoot.replace(/\\/g, "/"));
}

function removeOneSemanticEntry(entries: string[], settingsDir: string, entry: string): void {
	const key = getSettingsEntrySemanticKey(settingsDir, entry);
	const index = entries.findIndex((existing) => getSettingsEntrySemanticKey(settingsDir, existing) === key);
	if (index >= 0) entries.splice(index, 1);
}

function removeExactManagedEntries(entries: string[], managedEntries: string[]): void {
	for (const managedEntry of managedEntries) {
		const key = normalizeManagedEntryText(managedEntry);
		const index = entries.findIndex((entry) => normalizeManagedEntryText(entry) === key);
		if (index >= 0) entries.splice(index, 1);
	}
}

function appendManagedEntry(entries: string[], managedEntries: string[], entry: string, settingsDir: string): void {
	const key = getSettingsEntrySemanticKey(settingsDir, entry);
	if (entries.some((existing) => getSettingsEntrySemanticKey(settingsDir, existing) === key)) return;
	entries.push(entry);
	managedEntries.push(entry);
}

function getSettingsEntrySemanticKey(settingsDir: string, entry: string): string {
	const prefix = entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!") ? entry[0] : "";
	const resolvedPath = resolveSettingsEntryPath(settingsDir, entry);
	return `${prefix}:${resolvedPath ? normalizeAbsolutePath(resolvedPath) : normalizeManagedEntryText(entry)}`;
}

function normalizeManagedEntryText(entry: string): string {
	return entry.replace(/\\/g, "/");
}

async function collectCodexPluginSkillEntries(sourceId: string, cacheRoot: string): Promise<Array<{ path: string; skillsRoot: string; externalSkillId: string }>> {
	const entries: Array<{ path: string; skillsRoot: string; externalSkillId: string }> = [];
	for (const plugin of await getCodexPluginInventory(cacheRoot)) {
		for (const path of plugin.skillPaths) {
			const relativeSkillPath = normalizeConfigPath(relative(plugin.skillsRoot, path));
			entries.push({
				path,
				skillsRoot: plugin.skillsRoot,
				externalSkillId: `${sourceId}:${plugin.pluginName}:${relativeSkillPath}`,
			});
		}
	}
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveSettingsEntryPath(settingsDir: string, entry: string): string | undefined {
	const normalizedEntry = normalizeConfigPath(entry);
	if (!normalizedEntry) return undefined;
	if (normalizedEntry === "~" || normalizedEntry.startsWith("~/") || normalizedEntry.startsWith("~\\")) {
		return resolveHomePath(normalizedEntry);
	}
	return resolve(settingsDir, normalizedEntry);
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeAbsolutePath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}
