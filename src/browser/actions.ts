/**
 * 定义浏览器详情页可用动作，以及对应的文案和提示。
 */
import type { BrowserTheme, DetailAction } from "./shared.js";
import {
	canExposeResource,
	canManagePackageContents,
	canRemoveResourceIndividually,
	isContainedResource,
	isBuiltinExtension,
	isPackageItem,
	isResourceCenterPackage,
	isThemeItem,
	isToolItem,
	isMcpItem,
	supportsPackageUpdate,
} from "../resource/capabilities.js";
import type { ResourceItem } from "../types.js";

export function getDetailActions(item: ResourceItem): DetailAction[] {
	if (isMcpItem(item)) {
		if (item.configState === "error") return ["mcp-manager", "back"];
		return item.toggleMode === "none" ? ["mcp-manager", "mcp-tools", "pin", "back"] : ["toggle", "mcp-manager", "mcp-tools", "pin", "back"];
	}
	if (isToolItem(item)) return ["toggle", "back"];
	if (isBuiltinExtension(item)) return ["toggle", "pin", "back"];
	if (isPackageItem(item)) return ["manage", "toggle", "pin", "update", "remove", "back"];
	if (canExposeResource(item)) return ["toggle", "expose", "pin", "back"];
	if (isContainedResource(item)) return ["toggle", "pin", "back"];
	if (isThemeItem(item)) return canRemoveResourceIndividually(item) ? ["toggle", "pin", "remove", "back"] : ["toggle", "pin", "back"];
	return ["toggle", "pin", "remove", "back"];
}

export function getDetailActionHint(
	theme: BrowserTheme,
	action: DetailAction,
	item: ResourceItem,
	args: { isPinned: boolean; confirmingRemove: boolean },
): string | undefined {
	switch (action) {
		case "mcp-manager":
			return theme.fg("dim", "Open /mcp for connection, authentication and exposure");
		case "mcp-tools":
			return theme.fg("dim", "View registered tools from this server");
		case "manage":
			if (!canManagePackageContents(item)) return undefined;
			return theme.fg("dim", "Browse resources in this package");
		case "toggle":
			if (isMcpItem(item)) {
				return theme.fg("dim", item.toggleMode === "config"
					? "Save configuration · /reload to apply"
					: "Apply for this session · requires registration ownership");
			}
			if (isToolItem(item)) {
				if (item.exposure === "codemode" || item.exposure === "deferred") {
					return theme.fg("dim", item.enabled
						? "Remove from active set; still callable through codemode/tool search"
						: "Add to active set; already callable through codemode/tool search");
				}
				return theme.fg("dim", item.persistent
					? `${item.enabled ? "Disable" : "Enable"} now and update Pi defaultTools`
					: `${item.enabled ? "Disable" : "Enable"} for the current session`);
			}
			if (isPackageItem(item)) {
				if (item.enabled && isResourceCenterPackage(item)) {
					return theme.fg("warning", "Resource Center cannot disable itself here; use pi config if intentional");
				}
				return theme.fg(
					item.enabled ? "warning" : "dim",
					item.enabled
						? "Disable all resources and replace fine-grained package filters"
						: "Enable package defaults and clear fine-grained package filters",
				);
			}
			if (isThemeItem(item)) {
				return item.enabled ? theme.fg("success", "Theme is currently active") : theme.fg("dim", "Apply this theme");
			}
			return theme.fg("dim", item.enabled ? "Disable this resource" : "Enable this resource");
		case "pin":
			return theme.fg("dim", args.isPinned ? "Remove from top" : "Keep on top of the list");
		case "expose":
			if (!canExposeResource(item)) return undefined;
			return theme.fg("dim", item.exposed ? "Hide from top-level category" : "Show in top-level category");
		case "update":
			if (!isPackageItem(item)) return undefined;
			if (!supportsPackageUpdate(item)) {
				return theme.fg("warning", "Only remote packages can be updated");
			}
			return theme.fg("dim", "Update this package");
		case "remove":
			if (!canRemoveResourceIndividually(item)) {
				return theme.fg("warning", isContainedResource(item) ? "This package resource can't be removed individually" : "Built-in themes can't be removed");
			}
			if (item.source === "convention") {
				return args.confirmingRemove
					? theme.fg("warning", "Press Enter again to delete file · Esc cancels")
					: theme.fg("dim", "Delete this file from disk");
			}
			return args.confirmingRemove
				? theme.fg("warning", "Press Enter again to remove · Esc cancels")
				: theme.fg("dim", "Remove this resource");
		case "back":
			return theme.fg("dim", "Return to previous view");
	}
}

export function getDetailActionLabel(
	theme: BrowserTheme,
	action: DetailAction,
	item: ResourceItem,
	args: { isPinned: boolean; selected: boolean },
): string {
	switch (action) {
		case "mcp-manager":
			return theme.fg("accent", "Open MCP Manager");
		case "mcp-tools":
			return theme.fg("accent", "Browse Tools");
		case "manage":
			return theme.fg("accent", "Browse Package Contents");
		case "toggle":
			if (isToolItem(item) && (item.exposure === "codemode" || item.exposure === "deferred")) {
				return item.enabled ? theme.fg("warning", "Deactivate") : theme.fg("success", "Activate");
			}
			if (isPackageItem(item)) {
				return item.enabled ? theme.fg("warning", "Disable All Contents") : theme.fg("success", "Enable All Contents");
			}
			if (isThemeItem(item)) {
				return item.enabled ? theme.fg("success", "Active") : theme.fg("accent", "Apply");
			}
			return item.enabled ? theme.fg("warning", "Disable") : theme.fg("success", "Enable");
		case "pin": {
			const label = args.isPinned ? "Unpin" : "Pin to Top";
			return args.selected ? theme.bold(label) : label;
		}
		case "expose":
			return item.exposed ? theme.fg("warning", "Hide from Category") : theme.fg("accent", "Show in Category");
		case "update":
			return "Update";
		case "remove":
			return args.selected ? theme.fg("error", theme.bold("Remove")) : theme.fg("error", "Remove");
		case "back":
			return "Back";
	}
}
