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
	const trimmed = input.trim();
	if (!trimmed) return { kind: "invalid", reason: "Enter a package source or local path." };
	if (isRemotePackageSource(trimmed)) {
		if (options.preferredCategory) {
			return { kind: "invalid", reason: `Remote source ${trimmed} can only be added as a package.` };
		}
		return { kind: "package", source: trimmed, description: "Remote package source" };
	}

	const resolvedPath = resolveLocalInput(trimmed, cwd);
	let pathStat;
	try {
		pathStat = await stat(resolvedPath);
	} catch {
		return { kind: "invalid", reason: `Path does not exist: ${trimmed}` };
	}

	if (options.preferredCategory) {
		return {
			kind: "path",
			category: options.preferredCategory,
			path: resolvedPath,
			description: `Local ${CATEGORY_LABELS[options.preferredCategory]} ${pathStat.isDirectory() ? "directory" : "file"}`,
		};
	}

	if (pathStat.isFile()) {
		return detectFileTarget(resolvedPath);
	}
	if (pathStat.isDirectory()) {
		return await detectDirectoryTarget(resolvedPath);
	}
	return { kind: "invalid", reason: `Unsupported path type: ${trimmed}` };
}

export function detectAddTargetSync(
	input: string,
	cwd: string,
	options: { preferredCategory?: AddPathCategory } = {},
): AddTarget {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "invalid", reason: "Enter a package source or local path." };
	if (isRemotePackageSource(trimmed)) {
		if (options.preferredCategory) {
			return { kind: "invalid", reason: `Remote source ${trimmed} can only be added as a package.` };
		}
		return { kind: "package", source: trimmed, description: "Remote package source" };
	}

	const resolvedPath = resolveLocalInput(trimmed, cwd);
	let pathStat;
	try {
		pathStat = statSync(resolvedPath);
	} catch {
		return { kind: "invalid", reason: `Path does not exist: ${trimmed}` };
	}

	if (options.preferredCategory) {
		return {
			kind: "path",
			category: options.preferredCategory,
			path: resolvedPath,
			description: `Local ${CATEGORY_LABELS[options.preferredCategory]} ${pathStat.isDirectory() ? "directory" : "file"}`,
		};
	}
	if (pathStat.isFile()) return detectFileTarget(resolvedPath);
	if (pathStat.isDirectory()) return detectDirectoryTargetSync(resolvedPath);
	return { kind: "invalid", reason: `Unsupported path type: ${trimmed}` };
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
	if (await isLikelyPackageDirectory(path)) {
		return { kind: "package", source: path, description: "Local package directory" };
	}

	const candidates = await detectDirectoryCandidates(path);
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

function detectDirectoryTargetSync(path: string): AddTarget {
	if (isLikelyPackageDirectorySync(path)) {
		return { kind: "package", source: path, description: "Local package directory" };
	}
	const candidates = detectDirectoryCandidatesSync(path);
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

async function isLikelyPackageDirectory(path: string): Promise<boolean> {
	if (await pathExists(resolve(path, "package.json"))) {
		const manifest = await readPackageManifest(resolve(path, "package.json"));
		if (manifest?.pi && typeof manifest.pi === "object") return true;
		if (Array.isArray(manifest?.keywords) && manifest.keywords.includes("pi-package")) return true;
		return true;
	}
	for (const dirName of CONVENTIONAL_PACKAGE_DIRS) {
		if (await pathExists(resolve(path, dirName))) return true;
	}
	return false;
}

function isLikelyPackageDirectorySync(path: string): boolean {
	try {
		const manifestPath = resolve(path, "package.json");
		statSync(manifestPath);
		const manifest = readPackageManifestSync(manifestPath);
		if (manifest?.pi && typeof manifest.pi === "object") return true;
		if (Array.isArray(manifest?.keywords) && manifest.keywords.includes("pi-package")) return true;
		return true;
	} catch {
		for (const dirName of CONVENTIONAL_PACKAGE_DIRS) {
			try {
				if (statSync(resolve(path, dirName)).isDirectory()) return true;
			} catch {}
		}
		return false;
	}
}

async function detectDirectoryCandidates(path: string): Promise<AddPathCategory[]> {
	const entries = await readdir(path, { withFileTypes: true });
	const candidates = new Set<AddPathCategory>();
	for (const entry of entries) {
		if (entry.name === "SKILL.md") candidates.add("skills");
		const lower = entry.name.toLowerCase();
		const extension = extname(lower);
		if (entry.isDirectory()) {
			if (["skills", "prompts", "extensions", "themes"].includes(lower)) {
				candidates.add(lower as AddPathCategory);
			}
			continue;
		}
		if ([".ts", ".js", ".mjs", ".cjs"].includes(extension)) candidates.add("extensions");
		if (extension === ".md") candidates.add(lower === "skill.md" ? "skills" : "prompts");
		if (extension === ".json") candidates.add("themes");
	}
	return [...candidates];
}

function detectDirectoryCandidatesSync(path: string): AddPathCategory[] {
	const entries = readdirSync(path, { withFileTypes: true });
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
