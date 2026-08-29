/**
 * 对 Pi settings 中资源配置进行增删改切换的逻辑。
 */
import { lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FileResourceItem, ResourceCategory, ResourceItem } from "../types.js";
import type { AddPathCategory } from "../resource/add-detect.js";
import { getConfigEntryPrefix, getConfigEntryTarget, setExactOverride } from "../resource/config-overrides.js";
import { isResourceCenterPackage } from "../resource/capabilities.js";
import {
	USER_AGENT_DIR,
	getProjectSettingsPath,
	getUserSettingsPath,
	readSettingsFile,
	saveSettingsFile,
	type PackageSource,
	describeResource,
	inferPackageRelativePath,
	normalizeConfigPath,
	normalizeFsPath,
	resolveHomePath,
	toErrorMessage,
	toSettingsPath,
} from "./shared.js";

export async function toggleResourceInSettings(cwd: string, item: ResourceItem, projectTrusted = true): Promise<string> {
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = createSettingsManager(cwd, projectTrusted);
	try {
		if (item.category === "tools") throw new Error("Tools are managed through Pi's active-tool API");
		if (item.category === "packages") {
			if (!item.enabled && isResourceCenterPackage(item)) {
				throw new Error("Resource Center cannot disable its own package while it is running; use pi config if this is intentional");
			}
			togglePackage(settingsManager, item.scope, item.source, item.enabled);
		} else if (item.packageSource) {
			togglePackageResource(settingsManager, item, item.enabled);
		} else {
			if (item.category === "themes" || !("path" in item)) throw new Error(`Resource ${item.name} cannot be toggled via path settings`);
			togglePathResource(settingsManager, item.scope, item.category, item, dirname(settingsPath));
		}
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to toggle ${describeResource(item)} in ${item.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function removeResourceFromSettings(cwd: string, item: ResourceItem, projectTrusted = true): Promise<string> {
	if (item.category === "tools") throw new Error("Tools cannot be removed from Pi settings");
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = createSettingsManager(cwd, projectTrusted);
	try {
		if (item.category === "packages") {
			const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
			const packages = [...(settings.packages ?? [])] as PackageSource[];
			const filtered = packages.filter((entry) => (typeof entry === "string" ? entry : entry.source) !== item.source);
			if (filtered.length === packages.length) throw new Error(`Package source not found in ${item.scope} settings: ${item.source}`);
			setPackagesForScope(settingsManager, item.scope, filtered);
		} else {
			if (item.packageSource) throw new Error("Package resources cannot be removed individually");
			if (item.category === "themes" || !("path" in item)) throw new Error(`Resource ${item.name} cannot be removed via path settings`);
			const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
			const current = [...(settings[item.category] ?? [])];
			const normalizedItemPath = normalizeFsPath(resolve(item.path));
			const filtered = current.filter((entry) => normalizeFsPath(resolve(dirname(settingsPath), normalizeConfigPath(entry))) !== normalizedItemPath);
			if (filtered.length === current.length) throw new Error(`Resource path is not configured in ${item.scope} settings: ${item.path}`);
			setPathEntriesForScope(settingsManager, item.scope, item.category, filtered);
		}
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to remove ${describeResource(item)} from ${item.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function removeConventionResource(item: ResourceItem): Promise<string> {
	if (item.category === "packages") throw new Error("Packages are not file resources and can't be removed from disk this way");
	if (item.packageSource) throw new Error("Package resources can't be removed individually from disk");
	if (!("path" in item) || !item.path) throw new Error(`Resource ${item.name} has no file path`);
	const filePath = resolve(item.path);
	try {
		const stats = await lstat(filePath);
		if (stats.isDirectory()) throw new Error(`Expected a file but got directory: ${filePath}`);
		await unlink(filePath);
		return filePath;
	} catch (error: unknown) {
		throw new Error(`Failed to remove file for ${describeResource(item)} at ${filePath}: ${toErrorMessage(error)}`);
	}
}

export async function setActiveTheme(cwd: string, themeName: string, scope: "project" | "user" = "project", projectTrusted = true): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = createSettingsManager(cwd, projectTrusted);
	try {
		if (scope === "project") {
			// SettingsManager currently has no project-scoped setTheme method. Still honor
			// Pi's trust decision before updating the project settings file.
			if (!settingsManager.isProjectTrusted()) throw new Error("Project is not trusted");
			const settingsFile = (await readSettingsFile(settingsPath)) ?? { path: settingsPath, dir: dirname(settingsPath), settings: {} };
			settingsFile.settings.theme = themeName;
			await saveSettingsFile(settingsPath, settingsFile.settings);
		} else {
			settingsManager.setTheme(themeName);
			await settingsManager.flush();
		}
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to set active theme ${themeName} in ${scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function setDefaultTools(
	cwd: string,
	toolNames: string[],
	scope: "project" | "user",
	projectTrusted = true,
): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = createSettingsManager(cwd, projectTrusted);
	try {
		if (scope === "project" && !settingsManager.isProjectTrusted()) throw new Error("Project is not trusted");
		const settingsFile = (await readSettingsFile(settingsPath)) ?? { path: settingsPath, dir: dirname(settingsPath), settings: {} };
		settingsFile.settings.defaultTools = [...new Set(toolNames)];
		await saveSettingsFile(settingsPath, settingsFile.settings);
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to save defaultTools in ${scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function addPathResourceToSettings(cwd: string, category: AddPathCategory, path: string, scope: "project" | "user" = "project", projectTrusted = true): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = createSettingsManager(cwd, projectTrusted);
	try {
		const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
		const current = [...(settings[category] ?? [])];
		const settingsDir = dirname(settingsPath);
		const relativePath = toSettingsPath(path, settingsDir);
		const normalizedTargetPath = normalizeFsPath(resolve(settingsDir, normalizeConfigPath(relativePath)));
		const filtered = current.filter((entry) => normalizeFsPath(resolve(settingsDir, normalizeConfigPath(entry))) !== normalizedTargetPath);
		filtered.push(relativePath);
		setPathEntriesForScope(settingsManager, scope, category, filtered);
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to add ${category.slice(0, -1)} path ${path} to ${scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

function togglePackage(settingsManager: SettingsManager, scope: "project" | "user", source: string, enabled: boolean): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
	if (enabled) {
		if (index === -1) packages.push(source);
		else packages[index] = source;
	} else {
		const disabledEntry = { source, extensions: [], skills: [], prompts: [], themes: [] };
		if (index === -1) packages.push(disabledEntry);
		else packages[index] = disabledEntry;
	}
	setPackagesForScope(settingsManager, scope, packages);
}

function togglePathResource(settingsManager: SettingsManager, scope: "project" | "user", category: Exclude<ResourceCategory, "packages" | "themes" | "tools">, item: FileResourceItem, settingsDir: string): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const current = [...(settings[category] ?? [])];
	const relativePath = toSettingsPath(item.path, settingsDir);
	const normalizeEntryPath = (value: string) => normalizeFsPath(resolveConfigEntryPath(settingsDir, value));
	const updated = setExactOverride(current, relativePath, item.enabled, {
		normalize: normalizeEntryPath,
		preserveMatchingPlainEntries: item.source === "manual",
	});

	if (item.source === "manual" && !hasDiscoveryEntryForPath(updated, item.path, settingsDir)) {
		updated.unshift(relativePath);
	}

	setPathEntriesForScope(settingsManager, scope, category, updated);
}

function togglePackageResource(settingsManager: SettingsManager, item: Exclude<ResourceItem, { category: "packages" | "tools" }>, enabled: boolean): void {
	if (!item.packageSource) throw new Error(`Resource ${item.name} is not backed by a package`);
	const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === item.packageSource);
	if (index === -1) throw new Error(`Package source not found in settings: ${item.packageSource}`);
	let pkg = packages[index]!;
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[index] = pkg;
	}
	const category = item.category;
	const current = [...(pkg[category] ?? [])];
	const pattern = item.packageRelativePath ?? inferPackageRelativePath(item);
	const updated = setExactOverride(current, pattern, enabled, { normalize: normalizeConfigPath });
	pkg[category] = updated.length > 0 ? updated : undefined;
	const hasFilters = ["extensions", "skills", "prompts", "themes"].some((key) => (pkg as unknown as Record<string, unknown>)[key] !== undefined);
	if (!hasFilters) packages[index] = pkg.source;
	setPackagesForScope(settingsManager, item.scope, packages.length > 0 ? packages : []);
}

function hasDiscoveryEntryForPath(entries: string[], resourcePath: string, settingsDir: string): boolean {
	const normalizedResourcePath = normalizeFsPath(resolve(resourcePath));
	return entries.some((entry) => {
		if (getConfigEntryPrefix(entry)) return false;
		const normalizedEntryPath = normalizeFsPath(resolveConfigEntryPath(settingsDir, entry));
		return normalizedResourcePath === normalizedEntryPath || normalizedResourcePath.startsWith(`${normalizedEntryPath}/`);
	});
}

function resolveConfigEntryPath(settingsDir: string, entry: string): string {
	const target = getConfigEntryTarget(entry);
	if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) return resolveHomePath(target);
	return resolve(settingsDir, target);
}

function setPackagesForScope(settingsManager: SettingsManager, scope: "project" | "user", packages: PackageSource[]): void {
	if (scope === "project") settingsManager.setProjectPackages(packages); else settingsManager.setPackages(packages);
}

function setPathEntriesForScope(settingsManager: SettingsManager, scope: "project" | "user", category: Exclude<ResourceCategory, "packages" | "tools">, paths: string[]): void {
	if (scope === "project") {
		if (category === "extensions") settingsManager.setProjectExtensionPaths(paths);
		else if (category === "skills") settingsManager.setProjectSkillPaths(paths);
		else if (category === "prompts") settingsManager.setProjectPromptTemplatePaths(paths);
		else settingsManager.setProjectThemePaths(paths);
		return;
	}
	if (category === "extensions") settingsManager.setExtensionPaths(paths);
	else if (category === "skills") settingsManager.setSkillPaths(paths);
	else if (category === "prompts") settingsManager.setPromptTemplatePaths(paths);
	else settingsManager.setThemePaths(paths);
}

function createSettingsManager(cwd: string, projectTrusted: boolean): SettingsManager {
	return SettingsManager.create(cwd, USER_AGENT_DIR, { projectTrusted });
}
