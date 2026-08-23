/**
 * 统一描述不同资源具备哪些能力，例如 expose、remove、update 等。
 */
import { isRemotePackageSource, type FileResourceItem, type PackageResourceItem, type ResourceItem, type ThemeResourceItem } from "../types.js";

type ContainedResourceItem = (FileResourceItem | ThemeResourceItem) & { packageSource: string; packageRelativePath?: string };
type ExposableResourceItem = FileResourceItem & { category: "extensions" | "skills" | "prompts"; packageSource: string; packageRelativePath?: string };

export function isPackageItem(item: ResourceItem): item is PackageResourceItem {
	return item.category === "packages";
}

export function isThemeItem(item: ResourceItem): item is ThemeResourceItem {
	return item.category === "themes";
}

export function isContainedResource(item: ResourceItem): item is ContainedResourceItem {
	return item.category !== "packages" && Boolean(item.packageSource);
}

export function canManagePackageContents(item: ResourceItem): boolean {
	return isPackageItem(item);
}

export function canExposeResource(item: ResourceItem): item is ExposableResourceItem {
	return isContainedResource(item) && item.category !== "themes";
}

export function isBuiltinTheme(item: ResourceItem): boolean {
	return isThemeItem(item) && !("path" in item);
}

export function canRemoveResourceIndividually(item: ResourceItem): boolean {
	return !isContainedResource(item) && !isBuiltinTheme(item) && !("managedByPluginSettings" in item && item.managedByPluginSettings);
}

export function supportsPackageUpdate(item: ResourceItem): boolean {
	return isPackageItem(item) && isRemotePackageSource(item.source);
}

export function isResourceCenterPackage(item: ResourceItem): boolean {
	if (!isPackageItem(item)) return false;
	const source = item.source.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const installPath = item.installPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return source === "npm:pi-resource-center"
		|| source.startsWith("npm:pi-resource-center@")
		|| source.endsWith("/pi-resource-center")
		|| installPath?.endsWith("/pi-resource-center") === true;
}
