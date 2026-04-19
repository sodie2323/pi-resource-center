/**
 * 解析“添加资源”输入：支持 package source、本地文件和本地目录。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { resolveHomePath } from "../settings.js";
import type { ResourceCategory } from "../types.js";

export type AddPathCategory = Exclude<ResourceCategory, "packages">;

export type AddTarget =
	| { kind: "package"; source: string; description: string }
	| { kind: "path"; category: AddPathCategory; path: string; description: string }
	| { kind: "ambiguous"; path: string; candidates: AddPathCategory[]; description: string }
	| { kind: "invalid"; reason: string };

const REMOTE_PROTOCOL_PREFIXES = ["npm:", "git:", "http://", "https://", "ssh://"];
const CONVENTIONAL_PACKAGE_DIRS = ["extensions", "skills", "prompts", "themes"] as const;
const CATEGORY_LABELS: Record<AddPathCategory, string> = {
	extensions: "extension",
	skills: "skill",
	prompts: "prompt",
	themes: "theme",
};

export async function detectAddTarget(
	input: string,
	cwd: string,
	options: { preferredCategory?: AddPathCategory } = {},
): Promise<AddTarget> {
	const prepared = prepareAddInput(input, cwd, options);
	if (prepared.kind !== "path") return prepared.result;

	let pathStat;
	try {
		pathStat = await stat(prepared.resolvedPath);
	} catch {
		return { kind: "invalid", reason: `Path does not exist: ${prepared.trimmed}` };
	}

	const preferredTarget = buildPreferredCategoryTarget(prepared.resolvedPath, options.preferredCategory, pathStat.isDirectory());
	if (preferredTarget) return preferredTarget;
	if (pathStat.isFile()) return detectFileTarget(prepared.resolvedPath);
	if (pathStat.isDirectory()) return await detectDirectoryTarget(prepared.resolvedPath);
	return { kind: "invalid", reason: `Unsupported path type: ${prepared.trimmed}` };
}

export function detectAddTargetSync(
	input: string,
	cwd: string,
	options: { preferredCategory?: AddPathCategory } = {},
): AddTarget {
	const prepared = prepareAddInput(input, cwd, options);
	if (prepared.kind !== "path") return prepared.result;

	let pathStat;
	try {
		pathStat = statSync(prepared.resolvedPath);
	} catch {
		return { kind: "invalid", reason: `Path does not exist: ${prepared.trimmed}` };
	}

	const preferredTarget = buildPreferredCategoryTarget(prepared.resolvedPath, options.preferredCategory, pathStat.isDirectory());
	if (preferredTarget) return preferredTarget;
	if (pathStat.isFile()) return detectFileTarget(prepared.resolvedPath);
	if (pathStat.isDirectory()) return detectDirectoryTargetSync(prepared.resolvedPath);
	return { kind: "invalid", reason: `Unsupported path type: ${prepared.trimmed}` };
}

export function getAddTargetSuccessLabel(target: Extract<AddTarget, { kind: "package" | "path" }>): string {
	if (target.kind === "package") return `package ${target.source}`;
	return `local ${CATEGORY_LABELS[target.category]} ${basename(target.path)}`;
}

function isRemotePackageSource(value: string): boolean {
	return REMOTE_PROTOCOL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function resolveLocalInput(value: string, cwd: string): string {
	if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) return resolveHomePath(value);
	return resolve(cwd, value);
}

function prepareAddInput(
	input: string,
	cwd: string,
	options: { preferredCategory?: AddPathCategory },
):
	| { kind: "result"; result: AddTarget }
	| { kind: "path"; trimmed: string; resolvedPath: string } {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "result", result: { kind: "invalid", reason: "Enter a package source or local path." } };
	if (isRemotePackageSource(trimmed)) {
		if (options.preferredCategory) {
			return { kind: "result", result: { kind: "invalid", reason: `Remote source ${trimmed} can only be added as a package.` } };
		}
		return { kind: "result", result: { kind: "package", source: trimmed, description: "Remote package source" } };
	}
	return { kind: "path", trimmed, resolvedPath: resolveLocalInput(trimmed, cwd) };
}

function buildPreferredCategoryTarget(path: string, category: AddPathCategory | undefined, isDirectory: boolean): AddTarget | undefined {
	if (!category) return undefined;
	return {
		kind: "path",
		category,
		path,
		description: `Local ${CATEGORY_LABELS[category]} ${isDirectory ? "directory" : "file"}`,
	};
}

function detectFileTarget(path: string): AddTarget {
	const fileName = basename(path);
	const extension = extname(path).toLowerCase();
	if (fileName === "SKILL.md") return { kind: "path", category: "skills", path, description: "Local skill file" };
	if ([".ts", ".js", ".mjs", ".cjs"].includes(extension)) return { kind: "path", category: "extensions", path, description: "Local extension file" };
	if (extension === ".json") return { kind: "path", category: "themes", path, description: "Local theme file" };
	if (extension === ".md") return { kind: "path", category: "prompts", path, description: "Local prompt file" };
	return { kind: "invalid", reason: `Couldn't infer resource type from file: ${path}` };
}

async function detectDirectoryTarget(path: string): Promise<AddTarget> {
	if (await isLikelyPackageDirectory(path)) return buildPackageDirectoryTarget(path);
	return buildDirectoryTarget(path, await detectDirectoryCandidates(path));
}

function detectDirectoryTargetSync(path: string): AddTarget {
	if (isLikelyPackageDirectorySync(path)) return buildPackageDirectoryTarget(path);
	return buildDirectoryTarget(path, detectDirectoryCandidatesSync(path));
}

async function isLikelyPackageDirectory(path: string): Promise<boolean> {
	const manifestPath = resolve(path, "package.json");
	if (await pathExists(manifestPath)) return isLikelyPackageManifest(await readPackageManifest(manifestPath));
	return hasConventionalPackageDirs(path, (dirPath) => pathExists(dirPath));
}

function isLikelyPackageDirectorySync(path: string): boolean {
	const manifestPath = resolve(path, "package.json");
	try {
		statSync(manifestPath);
		return isLikelyPackageManifest(readPackageManifestSync(manifestPath));
	} catch {
		return hasConventionalPackageDirsSync(path, (dirPath) => {
			try {
				return statSync(dirPath).isDirectory();
			} catch {
				return false;
			}
		});
	}
}

async function detectDirectoryCandidates(path: string): Promise<AddPathCategory[]> {
	return collectDirectoryCandidates(await readdir(path, { withFileTypes: true }));
}

function detectDirectoryCandidatesSync(path: string): AddPathCategory[] {
	return collectDirectoryCandidates(readdirSync(path, { withFileTypes: true }));
}

function buildPackageDirectoryTarget(path: string): AddTarget {
	return { kind: "package", source: path, description: "Local package directory" };
}

function buildDirectoryTarget(path: string, candidates: AddPathCategory[]): AddTarget {
	if (candidates.length === 1) {
		return {
			kind: "path",
			category: candidates[0]!,
			path,
			description: `Local ${CATEGORY_LABELS[candidates[0]!]} directory`,
		};
	}
	if (candidates.length > 1) {
		return {
			kind: "ambiguous",
			path,
			candidates,
			description: `Directory could be added as: ${candidates.map((candidate) => CATEGORY_LABELS[candidate]).join(", ")}`,
		};
	}
	return { kind: "invalid", reason: `Couldn't infer resource type from directory: ${path}` };
}

function isLikelyPackageManifest(manifest: { pi?: unknown; keywords?: string[] } | undefined): boolean {
	if (!manifest) return true;
	if (manifest.pi && typeof manifest.pi === "object") return true;
	if (Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package")) return true;
	return true;
}

async function hasConventionalPackageDirs(path: string, exists: (path: string) => Promise<boolean>): Promise<boolean> {
	for (const dirName of CONVENTIONAL_PACKAGE_DIRS) {
		if (await exists(resolve(path, dirName))) return true;
	}
	return false;
}

function hasConventionalPackageDirsSync(path: string, exists: (path: string) => boolean): boolean {
	for (const dirName of CONVENTIONAL_PACKAGE_DIRS) {
		if (exists(resolve(path, dirName))) return true;
	}
	return false;
}

function collectDirectoryCandidates(entries: Array<{ name: string; isDirectory(): boolean }>): AddPathCategory[] {
	const candidates = new Set<AddPathCategory>();
	for (const entry of entries) {
		if (entry.name === "SKILL.md") candidates.add("skills");
		const lower = entry.name.toLowerCase();
		const extension = extname(lower);
		if (entry.isDirectory()) {
			if (["skills", "prompts", "extensions", "themes"].includes(lower)) candidates.add(lower as AddPathCategory);
			continue;
		}
		if ([".ts", ".js", ".mjs", ".cjs"].includes(extension)) candidates.add("extensions");
		if (extension === ".md") candidates.add(lower === "skill.md" ? "skills" : "prompts");
		if (extension === ".json") candidates.add("themes");
	}
	return [...candidates];
}

async function readPackageManifest(path: string): Promise<{ pi?: unknown; keywords?: string[] } | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as { pi?: unknown; keywords?: string[] };
	} catch {
		return undefined;
	}
}

function readPackageManifestSync(path: string): { pi?: unknown; keywords?: string[] } | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as { pi?: unknown; keywords?: string[] };
	} catch {
		return undefined;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
