/**
 * 资源中心自身设置的读写与维护逻辑。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canExposeResource } from "../resource/capabilities.js";
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
	readSettingsFile,
	resolveHomePath,
	saveSettingsFile,
	toErrorMessage,
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
			externalSkillSources: (parsed.externalSkillSources ?? DEFAULT_EXTERNAL_SKILL_SOURCES).map((source) => ({ ...source })),
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
	const { exposedResources: _exposed, ...settings } = file;
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
	const prunedSettings = resources ? prunePinnedResourceIds(settings, resources) : settings;
	const exposedResources = resources ? pruneExposedResourceEntries(file.exposedResources, resources) : file.exposedResources;
	const nextFile = { ...file, ...prunedSettings, exposedResources };
	const savedPath = await saveResourceCenterSettingsFile(nextFile);
	await syncExternalSkillSourcesToPiSettings(previousExternalSkillSources, nextFile.externalSkillSources);
	return savedPath;
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

export async function setResourceExposed(cwd: string, item: ResourceItem, exposed: boolean): Promise<string> {
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
): Promise<string> {
	const settingsPath = getUserSettingsPath();
	const settingsFile = (await readSettingsFile(settingsPath)) ?? { path: settingsPath, dir: dirname(settingsPath), settings: {} };
	const nextSkills = [...(settingsFile.settings.skills ?? [])];
	const previousById = new Map(previousSources.map((source) => [source.id, source]));
	const nextById = new Map(nextSources.map((source) => [source.id, source]));
	const sourceIds = new Set([...previousById.keys(), ...nextById.keys()]);

	for (const sourceId of sourceIds) {
		const previous = previousById.get(sourceId);
		const next = nextById.get(sourceId);
		const previousResolvedPath = previous ? resolveHomePath(previous.path) : undefined;
		const nextResolvedPath = next ? resolveHomePath(next.path) : undefined;

		if (previousResolvedPath && (!next || !next.enabled || previousResolvedPath !== nextResolvedPath)) {
			removeManagedExternalSkillSourceEntries(nextSkills, settingsFile.dir, previousResolvedPath);
		}

		if (next?.enabled) {
			upsertExternalSkillSourceRoot(nextSkills, settingsFile.dir, next.path);
		}
	}

	settingsFile.settings.skills = nextSkills.length > 0 ? nextSkills : undefined;
	await saveSettingsFile(settingsPath, settingsFile.settings);
	return settingsPath;
}

function upsertExternalSkillSourceRoot(entries: string[], settingsDir: string, sourcePath: string): void {
	const resolvedSourcePath = resolveHomePath(sourcePath);
	const nextEntries = entries.filter((entry) => {
		if (entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!")) return true;
		return resolveSettingsEntryPath(settingsDir, entry) !== resolvedSourcePath;
	});
	nextEntries.push(sourcePath.replace(/\\/g, "/"));
	entries.splice(0, entries.length, ...nextEntries);
}

function removeManagedExternalSkillSourceEntries(entries: string[], settingsDir: string, resolvedSourcePath: string): void {
	const normalizedRoot = normalizeAbsolutePath(resolvedSourcePath);
	const nextEntries = entries.filter((entry) => {
		const resolvedEntryPath = resolveSettingsEntryPath(settingsDir, entry);
		if (!resolvedEntryPath) return true;
		const normalizedEntryPath = normalizeAbsolutePath(resolvedEntryPath);
		if (!(normalizedEntryPath === normalizedRoot || normalizedEntryPath.startsWith(`${normalizedRoot}/`))) return true;
		return !(entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!") || normalizedEntryPath === normalizedRoot);
	});
	entries.splice(0, entries.length, ...nextEntries);
}

function resolveSettingsEntryPath(settingsDir: string, entry: string): string | undefined {
	const normalizedEntry = normalizeConfigPath(entry);
	if (!normalizedEntry) return undefined;
	if (normalizedEntry === "~" || normalizedEntry.startsWith("~/") || normalizedEntry.startsWith("~\\")) {
		return resolveHomePath(normalizedEntry);
	}
	return resolve(settingsDir, normalizedEntry);
}

function normalizeAbsolutePath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}
