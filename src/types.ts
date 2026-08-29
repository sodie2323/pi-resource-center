/**
 * 资源中心使用的核心领域类型定义。
 */
export type ResourceCategory = "packages" | "skills" | "extensions" | "prompts" | "themes" | "tools";

export type ResourceScope = "project" | "user";
export type ToolResourceScope = ResourceScope | "session";

export interface PackageResourceCounts {
	extensions: number;
	skills: number;
	prompts: number;
	themes: number;
}

export interface PackageEnabledSummary {
	enabledCount: number;
	totalCount: number;
}

export interface PackageResourceItem {
	category: "packages";
	id: string;
	name: string;
	scope: ResourceScope;
	source: string;
	sourceLabel?: string;
	description: string;
	enabled: boolean;
	/** Unix epoch millis for "last updated" sorting (best-effort). */
	updatedAt?: number;
	counts?: PackageResourceCounts;
	enabledSummary?: PackageEnabledSummary;
	installPath?: string;
	version?: string;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export interface FileResourceItem {
	category: Exclude<ResourceCategory, "packages" | "themes" | "tools">;
	id: string;
	name: string;
	scope: ResourceScope;
	path: string;
	source: string;
	sourceLabel?: string;
	description: string;
	argumentHint?: string;
	enabled: boolean;
	managedByPluginSettings?: boolean;
	externalSourceId?: string;
	externalPluginId?: string;
	externalPluginName?: string;
	externalSkillId?: string;
	/** Unix epoch millis for "last updated" sorting (best-effort). */
	updatedAt?: number;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export interface ThemeResourceItem {
	category: "themes";
	id: string;
	name: string;
	scope: ResourceScope;
	source: string;
	sourceLabel?: string;
	description: string;
	enabled: boolean;
	/** Unix epoch millis for "last updated" sorting (best-effort). */
	updatedAt?: number;
	path?: string;
	builtin?: boolean;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export interface ToolResourceItem {
	category: "tools";
	id: string;
	name: string;
	scope: ToolResourceScope;
	source: string;
	sourceLabel?: string;
	description: string;
	enabled: boolean;
	builtin: boolean;
	persistent: boolean;
	overridesBuiltin?: boolean;
	toolSourcePath: string;
	toolSourceOrigin: "package" | "top-level";
	packageSource?: string;
	packageRelativePath?: undefined;
	exposed?: false;
	updatedAt?: undefined;
}

export type ResourceItem = PackageResourceItem | FileResourceItem | ThemeResourceItem | ToolResourceItem;

export interface ResourceIndex {
	categories: Record<ResourceCategory, ResourceItem[]>;
}

export const REMOTE_PACKAGE_PREFIXES = ["npm:", "git:", "http://", "https://"] as const;

export function isRemotePackageSource(source: string): boolean {
	return REMOTE_PACKAGE_PREFIXES.some((prefix) => source.startsWith(prefix));
}
