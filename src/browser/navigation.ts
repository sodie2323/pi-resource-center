/**
 * 浏览器导航相关的纯函数，包括标题、footer、空态文案和选择移动。
 */
import { CATEGORY_LABELS, type BrowserMode } from "./shared.js";
import { formatPackageLabel } from "./shared.js";
import { isContainedResource, isPackageItem } from "../resource/capabilities.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

export function moveSelection(current: number, length: number, delta: number): number {
	if (length <= 0) return 0;
	return (current + delta % length + length) % length;
}

export function getHeaderTitle(args: {
	mode: BrowserMode;
	category: ResourceCategory;
	detailItem?: ResourceItem;
	packageItem?: ResourceItem;
}): string {
	const { mode, category, detailItem, packageItem } = args;
	if (mode === "detail" && detailItem) return getDetailTitle(detailItem);
	if (mode === "settings") return "Resources / Settings";
	if (mode === "add") return "Resources / Add";
	if (mode === "packageItems" && packageItem && isPackageItem(packageItem)) {
		return `Packages / ${formatPackageLabel(packageItem.source)} / Contents`;
	}
	return `Resources / ${CATEGORY_LABELS[category]}`;
}

export function getDetailTitle(item: ResourceItem): string {
	if (isPackageItem(item)) return `Packages / ${formatPackageLabel(item.source)}`;
	if (isContainedResource(item)) return `Packages / ${formatPackageLabel(item.packageSource!)} / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
	return `Resources / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
}

export function getListFooterText(selectedCategory: ResourceCategory, selectedItem?: ResourceItem): string {
	if (selectedCategory === "mcp") {
		const action = selectedItem?.category === "mcp" && selectedItem.toggleMode === "none" ? "manage" : "toggle";
		return `Space ${action} · P pin/unpin · Enter details · M manage · Esc close`;
	}
	return selectedCategory === "tools"
		? "Space toggle · Enter details · Esc close"
		: "Space toggle · A add · P pin/unpin · Enter details · Esc close";
}

export function getDetailFooterText(item?: ResourceItem): string {
	if (item?.category === "mcp") return "Enter confirm · P pin/unpin · Esc back";
	return item?.category === "tools"
		? "Enter confirm · Esc back"
		: "Enter confirm · A add · P pin/unpin · Esc back";
}

export function getAddFooterText(loading = false): string {
	return loading
		? "Adding… · Esc disabled · S Settings disabled"
		: "Enter accept/add · Tab switch scope · ↑↓ choose suggestion/type · Esc back";
}

export function getPackageFooterText(sortLabel: string): string {
	return `Space toggle · P pin/unpin · Enter details · Tab sort: ${sortLabel} · Esc back`;
}
