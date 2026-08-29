/**
 * 浏览器中的资源筛选、排序与 package 内容选择逻辑。
 */
import type { ResourceCenterSettings } from "../settings.js";
import { CATEGORY_LABELS, formatResourceSourceLabel, type BrowserListEntry, type PackageContentCategory, type PackageGroupEntry } from "./shared.js";
import { belongsToPackage } from "../resource/identity.js";
import { getToolGroupId } from "../resource/tool-runtime.js";
import type { ResourceCategory, ResourceIndex, ResourceItem } from "../types.js";

export function sortResourceItems(
	items: ResourceItem[],
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	const mode = settings.sortMode ?? "updated";
	const sorted = [...items];
	sorted.sort((a, b) => {
		const aPinned = isPinned(a);
		const bPinned = isPinned(b);
		const pinnedDiff = Number(bPinned) - Number(aPinned);
		if (pinnedDiff !== 0) return pinnedDiff;
		if (aPinned && bPinned) {
			const aIndex = getPinnedRank(a);
			const bIndex = getPinnedRank(b);
			if (aIndex !== bIndex) return aIndex - bIndex;
		}

		if (mode === "default") return 0;
		if (mode === "updated") {
			const aTime = a.updatedAt ?? -1;
			const bTime = b.updatedAt ?? -1;
			const timeDiff = bTime - aTime;
			if (timeDiff !== 0) return timeDiff;
		}
		if (mode === "enabled") {
			const enabledDiff = Number(b.enabled) - Number(a.enabled);
			if (enabledDiff !== 0) return enabledDiff;
		}
		if (mode === "scope") {
			const rank = (scope: ResourceItem["scope"]) => (scope === "project" ? 0 : 1);
			const scopeDiff = rank(a.scope) - rank(b.scope);
			if (scopeDiff !== 0) return scopeDiff;
		}

		const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		if (nameDiff !== 0) return nameDiff;
		return a.source.localeCompare(b.source, undefined, { sensitivity: "base" });
	});
	return sorted;
}

export function getVisibleCategoryItems(
	resources: ResourceIndex,
	category: ResourceCategory,
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	const items = resources.categories[category];
	const visible = category === "packages" || category === "themes" || category === "tools"
		? items
		: items.filter((item) => !item.packageSource || item.exposed);
	return sortResourceItems(visible, settings, isPinned, getPinnedRank);
}

export function getPackageContainedItems(
	resources: ResourceIndex,
	pkg: ResourceItem,
	category: PackageContentCategory,
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	if (pkg.category !== "packages") return [];
	const items = resources.categories[category].filter((item) => belongsToPackage(item, pkg));
	return sortResourceItems(items, settings, isPinned, getPinnedRank);
}

export function getFilteredPackageContainedItems(
	items: ResourceItem[],
	category: PackageContentCategory,
	query: string,
	matchesQuery: (item: ResourceItem, query: string) => boolean,
): ResourceItem[] {
	if (!query || CATEGORY_LABELS[category].toLowerCase().includes(query)) return items;
	return items.filter((item) => matchesQuery(item, query));
}

export function buildPackageGroupEntries(
	categories: PackageContentCategory[],
	query: string,
	previewLimit: ResourceCenterSettings["packagePreviewLimit"],
	getItems: (category: PackageContentCategory) => ResourceItem[],
): PackageGroupEntry[] {
	const entries: PackageGroupEntry[] = [];
	for (const category of categories) {
		const categoryMatches = !query || CATEGORY_LABELS[category].toLowerCase().includes(query);
		const items = getItems(category);
		if (!categoryMatches && items.length === 0) continue;
		entries.push({ kind: "category", category });
		for (const item of items.slice(0, previewLimit)) {
			entries.push({ kind: "item", category, item });
		}
		if (items.length > previewLimit) {
			entries.push({ kind: "more", category, remaining: items.length - previewLimit });
		}
	}
	return entries;
}

export function buildBrowserListEntries(
	category: ResourceCategory,
	items: ResourceItem[],
	expandedGroupIds: Set<string>,
	allItems: ResourceItem[] = items,
): BrowserListEntry[] {
	if (category !== "skills" && category !== "tools") {
		return items.map((item) => ({ kind: "resource", item }));
	}

	const getGroup = (item: ResourceItem): { id: string; name: string; sourceLabel: string } | undefined => {
		if (item.category === "skills") {
			const id = item.externalPluginId;
			const name = item.externalPluginName;
			return id && name ? { id, name, sourceLabel: `codex:${name}` } : undefined;
		}
		if (item.category === "tools") {
			const label = formatResourceSourceLabel(item);
			return { id: getToolGroupId(item), name: label, sourceLabel: label };
		}
		return undefined;
	};

	const groupItemsById = new Map<string, ResourceItem[]>();
	for (const item of allItems) {
		const group = getGroup(item);
		if (!group) continue;
		const current = groupItemsById.get(group.id) ?? [];
		current.push(item);
		groupItemsById.set(group.id, current);
	}
	const visibleGroupItemsById = new Map<string, ResourceItem[]>();
	for (const item of items) {
		const group = getGroup(item);
		if (!group) continue;
		const current = visibleGroupItemsById.get(group.id) ?? [];
		current.push(item);
		visibleGroupItemsById.set(group.id, current);
	}

	const emittedGroups = new Set<string>();
	const entries: BrowserListEntry[] = [];
	for (const item of items) {
		const group = getGroup(item);
		const groupItems = group ? groupItemsById.get(group.id) : undefined;
		const visibleGroupItems = group ? visibleGroupItemsById.get(group.id) : undefined;
		if (!group || !groupItems || !visibleGroupItems || groupItems.length <= 1) {
			entries.push({ kind: "resource", item });
			continue;
		}
		if (emittedGroups.has(group.id)) continue;
		emittedGroups.add(group.id);
		const expanded = expandedGroupIds.has(group.id);
		entries.push({
			kind: "resource-group",
			groupId: group.id,
			groupName: group.name,
			scope: item.scope,
			sourceLabel: group.sourceLabel,
			items: groupItems,
			enabledCount: groupItems.filter((entry) => entry.enabled).length,
			totalCount: groupItems.length,
			expanded,
			updatedAt: groupItems.reduce<number | undefined>((latest, entry) => {
				const updatedAt = "updatedAt" in entry ? entry.updatedAt : undefined;
				if (updatedAt === undefined) return latest;
				return latest === undefined ? updatedAt : Math.max(latest, updatedAt);
			}, undefined),
		});
		if (!expanded) continue;
		for (const child of visibleGroupItems) {
			entries.push({ kind: "resource-child", groupId: group.id, item: child });
		}
	}
	return category === "tools" ? moveBuiltinToolGroupFirst(entries) : entries;
}

function moveBuiltinToolGroupFirst(entries: BrowserListEntry[]): BrowserListEntry[] {
	const groupIndex = entries.findIndex((entry) => entry.kind === "resource-group" && entry.items.some((item) => item.category === "tools" && item.builtin));
	if (groupIndex <= 0) return entries;
	const groupEntry = entries[groupIndex]!;
	if (groupEntry.kind !== "resource-group") return entries;
	const children: BrowserListEntry[] = [];
	let index = groupIndex + 1;
	while (index < entries.length) {
		const entry = entries[index]!;
		if (entry.kind !== "resource-child" || entry.groupId !== groupEntry.groupId) break;
		children.push(entry);
		index += 1;
	}
	entries.splice(groupIndex, children.length + 1);
	entries.unshift(groupEntry, ...children);
	return entries;
}
