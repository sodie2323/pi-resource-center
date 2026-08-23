/**
 * Shared Codex plugin inventory used by settings sync and resource discovery.
 * A short-lived cache collapses the repeated scans performed by one refresh cycle.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface CodexPluginInventoryEntry {
	pluginName: string;
	pluginLabel: string;
	description?: string;
	skillsRoot: string;
	skillPaths: string[];
}

type CacheEntry = {
	createdAt: number;
	inventory: Promise<CodexPluginInventoryEntry[]>;
};

const CACHE_TTL_MS = 2_000;
const inventoryCache = new Map<string, CacheEntry>();

export async function getCodexPluginInventory(root: string): Promise<CodexPluginInventoryEntry[]> {
	const cacheKey = resolve(root).replace(/\\/g, "/").toLowerCase();
	const now = Date.now();
	const cached = inventoryCache.get(cacheKey);
	if (cached && now - cached.createdAt <= CACHE_TTL_MS) return cached.inventory;
	const inventory = scanCodexPluginInventory(root);
	inventoryCache.set(cacheKey, { createdAt: now, inventory });
	try {
		return await inventory;
	} catch (error) {
		inventoryCache.delete(cacheKey);
		throw error;
	}
}

export function clearCodexPluginInventoryCache(): void {
	inventoryCache.clear();
}

async function scanCodexPluginInventory(root: string): Promise<CodexPluginInventoryEntry[]> {
	const pluginJsonPaths = await collectCodexPluginManifests(root);
	const inventory: CodexPluginInventoryEntry[] = [];
	for (const pluginJsonPath of pluginJsonPaths) {
		const plugin = await readCodexPluginManifest(pluginJsonPath);
		if (!plugin || plugin.hasApps) continue;
		const pluginRoot = dirname(dirname(pluginJsonPath));
		const pluginName = (plugin.name || plugin.displayName || basename(pluginRoot)).toLowerCase();
		const pluginLabel = plugin.displayName || plugin.name || basename(pluginRoot);
		const skillsRoot = resolve(pluginRoot, plugin.skillsPath ?? "skills");
		const skillPaths = await collectSkillPaths(skillsRoot);
		if (skillPaths.length === 0) continue;
		inventory.push({
			pluginName,
			pluginLabel,
			description: plugin.shortDescription ?? plugin.description,
			skillsRoot,
			skillPaths,
		});
	}
	return inventory.sort((left, right) => left.skillsRoot.localeCompare(right.skillsRoot));
}

async function collectCodexPluginManifests(root: string): Promise<string[]> {
	const manifests: string[] = [];
	await walkDirectory(root, async (path, isDirectory) => {
		if (!isDirectory) return false;
		if (!path.endsWith(".codex-plugin")) return undefined;
		const pluginJsonPath = resolve(path, "plugin.json");
		try {
			if ((await stat(pluginJsonPath)).isFile()) manifests.push(pluginJsonPath);
		} catch {
			// Ignore malformed plugin folders.
		}
		return false;
	});
	return manifests.sort();
}

async function walkDirectory(root: string, visit: (path: string, isDirectory: boolean) => Promise<boolean | void>): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const entryPath = resolve(root, entry.name);
		const shouldContinue = await visit(entryPath, entry.isDirectory());
		if (entry.isDirectory() && shouldContinue !== false) await walkDirectory(entryPath, visit);
	}
}

async function readCodexPluginManifest(path: string): Promise<{
	name?: string;
	displayName?: string;
	description?: string;
	shortDescription?: string;
	skillsPath?: string;
	hasApps: boolean;
} | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as {
			name?: unknown;
			description?: unknown;
			skills?: unknown;
			apps?: unknown;
			interface?: { displayName?: unknown; shortDescription?: unknown };
		};
		return {
			name: typeof parsed.name === "string" ? parsed.name : undefined,
			displayName: typeof parsed.interface?.displayName === "string" ? parsed.interface.displayName : undefined,
			description: typeof parsed.description === "string" ? parsed.description : undefined,
			shortDescription: typeof parsed.interface?.shortDescription === "string" ? parsed.interface.shortDescription : undefined,
			skillsPath: typeof parsed.skills === "string" && parsed.skills.trim() ? parsed.skills : undefined,
			hasApps: parsed.apps !== undefined,
		};
	} catch {
		return undefined;
	}
}

async function collectSkillPaths(path: string): Promise<string[]> {
	try {
		const info = await stat(path);
		if (info.isFile()) return path.endsWith(".md") ? [path] : [];
		if (!info.isDirectory()) return [];
		const found = new Set<string>();
		await walkSkillDirectory(path, found, true);
		return Array.from(found).sort();
	} catch {
		return [];
	}
}

async function walkSkillDirectory(dir: string, found: Set<string>, includeRootFiles: boolean): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		if (entry.isFile()) found.add(resolve(dir, entry.name));
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const entryPath = resolve(dir, entry.name);
		if (entry.isDirectory()) await walkSkillDirectory(entryPath, found, false);
		else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) found.add(entryPath);
	}
}
