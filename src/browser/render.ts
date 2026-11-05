/**
 * 浏览器各页面的纯渲染函数。
 */
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BrowserListEntry, BrowserTheme, DetailAction, SettingsSection } from "./shared.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, SETTINGS_SECTION_LABELS, SETTINGS_SECTION_ORDER, SORT_MODE_LABELS, formatResourceSourceLabel } from "./shared.js";
import { isContainedResource, isPackageItem, isMcpItem } from "../resource/capabilities.js";
import type { ResourceCategory, ResourceItem } from "../types.js";
import { DESCRIPTION_PREVIEW_LINES, TOOL_PARAMETER_WINDOW_SIZE, promptRepeatsDescription, renderPromptPreview, renderToolParameters } from "./detail-content.js";

export function renderHeader(theme: BrowserTheme, width: number, title: string, count: number, primaryTitle?: string): string[] {
	const right = theme.fg("muted", `${count} result${count === 1 ? "" : "s"}`);
	if (visibleWidth(title) + visibleWidth(right) + 2 <= width) {
		const left = theme.fg("accent", theme.bold(title));
		return [`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`];
	}
	// Drop statistics before shortening context, and never sacrifice the resource name for a path.
	const parts = title.split(" / ");
	const primary = primaryTitle ?? parts.at(-1) ?? title;
	const candidates = [title, parts.slice(-2).join(" / "), `… / ${primary}`, primary];
	const tailWidth = Math.max(0, Math.ceil((width - 1) * 0.65));
	const shortened = width > 1
		? `${sliceByColumn(primary, 0, width - tailWidth - 1)}…${sliceByColumn(primary, Math.max(0, visibleWidth(primary) - tailWidth), tailWidth)}` : width > 0 ? "…" : "";
	const fitted = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? shortened;
	return [theme.fg("accent", theme.bold(fitted))];
}

export function renderTabs(theme: BrowserTheme, width: number, category: ResourceCategory, sortMode?: keyof typeof SORT_MODE_LABELS): string[] {
	const sortHint = sortMode ? SORT_MODE_LABELS[sortMode] : "Sort";
	const title = theme.fg("muted", `(←/→ category | Tab sort: ${sortHint})`);
	const tabs = CATEGORY_ORDER.map((entry) => {
		const label = ` ${CATEGORY_LABELS[entry]} `;
		if (entry === category) {
			return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
		}
		return theme.fg("muted", label);
	}).join(" ");
	if (visibleWidth(tabs) > width) {
		const selectedIndex = CATEGORY_ORDER.indexOf(category);
		const selectedStart = CATEGORY_ORDER.slice(0, selectedIndex).reduce((sum, entry) => sum + visibleWidth(` ${CATEGORY_LABELS[entry]} `) + 1, 0);
		const start = Math.max(0, Math.min(selectedStart, visibleWidth(tabs) - width));
		return [sliceByColumn(tabs, start, width)];
	}
	return [truncateToWidth(`${tabs}  ${title}`, width, "…")];
}

export function renderSearch(theme: BrowserTheme, width: number, inputText: string): string[] {
	return [truncateToWidth(`${theme.fg("muted", "Search:")} ${inputText}`, width, "…")];
}

export function renderListPage(args: {
	theme: BrowserTheme;
	width: number;
	entries: BrowserListEntry[];
	selectedIndex: number;
	maxVisible: number;
	isPinned: (item: ResourceItem) => boolean;
	formatPackageToggleState: (item: ResourceItem) => string;
	context?: "category" | "package";
	emptyMessage?: string;
	formatBinaryToggle: (enabled: boolean, bold?: boolean) => string;
}): string[] {
	const { theme, width, entries, selectedIndex, maxVisible, isPinned, formatPackageToggleState, formatBinaryToggle } = args;
	if (entries.length === 0) {
		return [theme.fg("muted", `  ${args.emptyMessage ?? "Nothing matches the current view"}`)];
	}

	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), entries.length - maxVisible));
	const endIndex = Math.min(entries.length, startIndex + maxVisible);
	const lines: string[] = [];
	const nameCounts = new Map<string, number>();
	if (args.context === "package") {
		for (const entry of entries) {
			if (entry.kind === "resource-group") continue;
			const key = `${entry.item.category}:${entry.item.name.toLowerCase()}`;
			nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
		}
	}

	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index]!;
		const selected = index === selectedIndex;
		const marker = selected ? theme.fg("accent", "▌") : theme.fg("dim", " ");
		if (entry.kind === "resource-group") {
			const toggle = theme.fg(
				entry.enabledCount === 0 ? "dim" : entry.enabledCount === entry.totalCount ? "success" : "warning",
				theme.bold(`[${entry.enabledCount}/${entry.totalCount}]`),
			);
			const disclosure = theme.fg("muted", entry.expanded ? "▾" : "▸");
			const name = selected ? theme.bold(entry.groupName) : theme.fg("text", entry.groupName);
			const sessionBadge = entry.items.length > 0 && entry.items.every((item) => item.category === "tools" && !item.builtin)
				? theme.fg("dim", " [session]")
				: "";
			const scope = entry.scope === "project"
				? theme.fg("success", "project")
				: entry.scope === "user"
					? theme.fg("warning", "user")
					: theme.fg("muted", "session");
			const source = entry.groupName === entry.sourceLabel ? "" : theme.fg("dim", entry.sourceLabel);
			const right = source ? `${scope}  ${source}` : scope;
			const left = `${marker} ${toggle} ${disclosure} ${name}${sessionBadge}`;
			const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
			let line = truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, "…");
			line = selected ? theme.bg("selectedBg", line) : theme.fg("text", line);
			lines.push(line);
			continue;
		}
		const item = entry.item;
		const toggle = isPackageItem(item) ? formatPackageToggleState(item)
			: isMcpItem(item) && item.configState === "error" ? theme.fg("error", theme.bold("[!]"))
				: isMcpItem(item) && item.configState === "unknown" ? theme.fg("dim", theme.bold("[?]"))
					: formatBinaryToggle(item.enabled, true);
		const pinBadge = isPinned(item) ? theme.fg("accent", "[pin] ") : "";
		const packageBadge = args.context !== "package" && isContainedResource(item) ? theme.fg("accent", theme.bold("[pkg] ")) : "";
		const overrideBadge = item.category === "tools" && item.overridesBuiltin ? theme.fg("warning", "[override] ") : "";
		const sessionBadge = (item.category === "tools" && !item.builtin) || (isMcpItem(item) && item.toggleMode === "registration")
			? theme.fg("dim", " [session]") : "";
		const exposureBadge = item.category === "tools" && item.exposure !== "direct"
			? theme.fg("dim", ` [${item.exposure}]`) : "";
		const packageVersion = isPackageItem(item) && item.version ? theme.fg("dim", ` @${item.version}`) : "";
		const duplicate = (nameCounts.get(`${item.category}:${item.name.toLowerCase()}`) ?? 0) > 1;
		const disambiguation = duplicate && item.packageRelativePath ? theme.fg("dim", ` · ${item.packageRelativePath}`) : "";
		const displayName = (isPackageItem(item) ? formatResourceSourceLabel(item) : item.name) + disambiguation;
		const toolSummary = isMcpItem(item) && item.configState !== "error" && item.enabled
			? theme.fg("dim", item.toolsLoading ? " [fetching tools…]" : ` [${item.toolNames.length} tools]`) : "";
		const childIndent = entry.kind === "resource-child" ? theme.fg("dim", "   ↳ ") : "";
		const nameText = `${childIndent}${pinBadge}${packageBadge}${overrideBadge}${displayName}${sessionBadge}${exposureBadge}${toolSummary}${packageVersion}`;
		const name = selected ? theme.bold(nameText) : theme.fg("text", nameText);
		const itemScope = item.scope === "project"
			? theme.fg("success", "project")
			: item.scope === "user"
				? theme.fg("warning", "user")
				: theme.fg("muted", "session");
		const right = args.context === "package"
			? theme.fg("muted", CATEGORY_LABELS[item.category].replace(/s$/, ""))
			: entry.kind === "resource-child" ? "" : `${itemScope}  ${theme.fg("dim", formatResourceSourceLabel(item))}`;
		const left = truncateToWidth(`${marker} ${toggle} ${name}`,
			args.context === "package" ? Math.max(1, width - visibleWidth(right) - 1) : width, "…");
		const spacing = right ? Math.max(1, width - visibleWidth(left) - visibleWidth(right)) : 0;
		let line = truncateToWidth(right ? `${left}${" ".repeat(spacing)}${right}` : left, width, "…");
		line = selected ? theme.bg("selectedBg", line) : theme.fg("text", line);
		lines.push(line);

		const nextEntry = index + 1 < endIndex ? entries[index + 1] : undefined;
		if (entry.kind === "resource" && isPackageItem(item) && nextEntry?.kind === "resource" && !isPackageItem(nextEntry.item)) {
			lines.push(theme.fg("dim", ""));
		}
	}

	if (startIndex > 0 || endIndex < entries.length) {
		lines.push(theme.fg("dim", truncateToWidth(`(${selectedIndex + 1}/${entries.length})`, width, "")));
	}

	return lines;
}

export function renderDetailPage(args: {
	theme: BrowserTheme;
	width: number;
	item: ResourceItem | undefined;
	detailSelectedIndex: number;
	contentOffset?: number;
	parameterOffset?: number;
	descriptionExpanded?: boolean;
	onDescriptionLayout?: (expandable: boolean) => void;
	maxContentLines?: number;
	onContentLayout?: (total: number, visible: number, offset: number) => void;
	getDetailActions: (item: ResourceItem) => DetailAction[];
	getDetailActionLabel: (action: DetailAction, item: ResourceItem, selected: boolean) => string;
	getPersistedActionHint: (action: DetailAction) => string | undefined;
	getDetailActionHint: (action: DetailAction, item: ResourceItem) => string | undefined;
	formatPackageEnabledSummary: (item: ResourceItem) => string | undefined;
	formatPackageCounts: (item: ResourceItem, detailed?: boolean, dimmed?: boolean) => string | undefined;
}): string[] {
	const {
		theme,
		width,
		item,
		detailSelectedIndex,
		getDetailActions,
		getDetailActionLabel,
		getPersistedActionHint,
		getDetailActionHint,
		formatPackageEnabledSummary,
		formatPackageCounts,
	} = args;
	if (!item) return [theme.fg("muted", "Nothing selected")];

	const field = (label: string, value: string) => truncateToWidth(`${theme.fg("muted", label)}: ${value}`, width, "…");
	const lines = item.category === "prompts" && "argumentHint" in item && item.argumentHint
		? [field("Argument Hint", item.argumentHint)]
		: [];
	if (isPackageItem(item)) {
		if (item.version) lines.push(field("Version", item.version));
		const enabledSummary = formatPackageEnabledSummary(item);
		if (enabledSummary) lines.push(field("Enabled Resources", enabledSummary));
		const counts = formatPackageCounts(item, true);
		if (counts) lines.push(field("Resources", counts));
	}
	if (isMcpItem(item) && item.configState !== "error") {
		const toolState = item.toolsLoading ? "Fetching tools…"
			: !item.enabled && item.toolNames.length === 0 ? "None observed · disabled in configuration"
			: `${item.activeToolCount}/${item.toolNames.length} active · registered`;
		lines.push(field("Tools", toolState));
		lines.push(field("Transport", `${item.transport ?? "unknown"} · ${theme.fg("muted", "Exposure")}: ${item.exposure ?? "unknown"}`));
		lines.push(field("Resources", `Not queried${item.resourceTools.length > 0 ? " · shared access available" : ""}`));
		lines.push(...wrapTextWithAnsi(theme.fg("dim", "Switches control configuration, not connection status. Manage connections in /mcp."), Math.max(1, width))
			.map((line) => truncateToWidth(line, width, "…")));
	}
	const preview = item.category === "prompts" ? item.promptPreview : undefined;
	const description = preview && promptRepeatsDescription(preview, item.description)
		? [] : renderDescriptionBlock(theme, item.description, width);
	const expandable = description.length > DESCRIPTION_PREVIEW_LINES;
	args.onDescriptionLayout?.(expandable);
	if (description.length > 0) {
		if (lines.length > 0) lines.push("");
		let hint = expandable ? ` · o ${args.descriptionExpanded ? "collapse" : "expand"}` : "";
		if (visibleWidth("Description" + hint) > width && expandable) hint = ` · o ${args.descriptionExpanded ? "−" : "+"}`;
		lines.push(truncateToWidth(theme.fg("text", theme.bold("Description")) + theme.fg("dim", hint), width, "…"));
		const shown = expandable && !args.descriptionExpanded ? description.slice(0, DESCRIPTION_PREVIEW_LINES) : description;
		if (expandable && !args.descriptionExpanded) {
			shown[shown.length - 1] = truncateToWidth(shown.at(-1)!, Math.max(0, width - 1), "") + theme.fg("dim", "…");
		}
		lines.push(...shown);
	}
	const extra = item.category === "tools" ? renderToolParameters(theme, item.parameters, width, args.parameterOffset)
		: preview !== undefined ? renderPromptPreview(theme, preview, width, item.category === "prompts" && item.promptPreviewTruncated) : [];
	if (extra.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...extra);
	}
	const maxContentLines = Math.max(2, args.maxContentLines ?? Infinity);
	const moreParameters = item.category === "tools" && (item.parameters?.length ?? 0) > TOOL_PARAMETER_WINDOW_SIZE;
	const needsScrollHint = moreParameters || lines.length > maxContentLines;
	const visible = Math.min(lines.length, maxContentLines - Number(needsScrollHint));
	const offset = Math.max(0, Math.min(args.contentOffset ?? 0, lines.length - visible));
	args.onContentLayout?.(lines.length, visible, offset);
	const result = lines.slice(offset, offset + visible);
	if (needsScrollHint) result.push(truncateToWidth(theme.fg("dim", "j↓ k↑ scroll"), width, "…"));
	if (result.length > 0) result.push("");
	result.push(theme.fg("text", theme.bold("Actions")));
	const actions = getDetailActions(item);
	for (let i = 0; i < actions.length; i++) {
		const action = actions[i]!;
		const selected = i === detailSelectedIndex;
		const label = getDetailActionLabel(action, item, selected);
		const actionHint = selected ? getPersistedActionHint(action) ?? getDetailActionHint(action, item) : getPersistedActionHint(action);
		const marker = selected ? theme.fg("accent", "› ") : "  ";
		const labelLines = wrapTextWithAnsi(label, Math.max(1, width - 2));
		for (const [index, labelLine] of labelLines.entries()) {
			let line = `${index === 0 ? marker : "  "}${labelLine}`;
			const hintWidth = width - visibleWidth(line) - 3;
			// A clipped fragment of a hint is less useful than a clean, complete action label.
			if (labelLines.length === 1 && actionHint && hintWidth >= 16) {
				line += theme.fg("dim", " · ") + truncateToWidth(actionHint, hintWidth, "…");
			}
			line = truncateToWidth(line, width, "…");
			result.push(selected ? theme.bg("selectedBg", line) : line);
		}
	}
	return result;
}

export function renderPackageItemsPage(args: {
	theme: BrowserTheme;
	width: number;
	items: ResourceItem[];
	selectedIndex: number;
	maxVisible: number;
	isPinned: (item: ResourceItem) => boolean;
	emptyMessage: string;
	formatBinaryToggle: (enabled: boolean, bold?: boolean) => string;
}): string[] {
	return renderListPage({
		...args,
		context: "package",
		entries: args.items.map((item) => ({ kind: "resource", item })),
		formatPackageToggleState: () => "", // Package contents contain leaf resources only.
	});
}

export function renderFooterWithSettingsHint(theme: BrowserTheme, width: number, text: string): string {
	const parts = [...text.split(" · "), "S Settings"];
	const format = (items: string[]) => items.map((item) => item === "S Settings"
		? theme.fg("accent", theme.bold(item)) : theme.fg("dim", item)).join(theme.fg("dim", " · "));
	if (visibleWidth(parts.join(" · ")) <= width) return format(parts);
	// Keep the primary operation and escape route; add optional hints only as complete phrases.
	const escape = parts.find((item) => item.startsWith("Esc "));
	let primary = parts[0] ?? "";
	const compact = primary.startsWith("Enter ") ? "Enter" : primary.startsWith("Space ") ? "Space" : primary;
	if (escape && visibleWidth(`${primary} · ${escape}`) > width) primary = compact;
	const kept = [primary];
	if (escape && visibleWidth(`${primary} · ${escape}`) <= width) kept.push(escape);
	if (visibleWidth(kept.join(" · ")) > width) return theme.fg("dim", width > 0 ? "…" : "");
	for (const part of ["S Settings", ...parts.slice(1)]) {
		if (kept.includes(part)) continue;
		if (visibleWidth([...kept, part].join(" · ")) <= width) kept.push(part);
	}
	return format(kept);
}

export function renderSettingsTabs(theme: BrowserTheme, width: number, section: SettingsSection): string[] {
	const title = theme.fg("muted", "(← → or Tab to cycle)");
	const tabs = SETTINGS_SECTION_ORDER.map((entry) => {
		const label = ` ${SETTINGS_SECTION_LABELS[entry]} `;
		if (entry === section) {
			return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
		}
		return theme.fg("muted", label);
	}).join(" ");
	return [truncateToWidth(`${tabs}  ${title}`, width, "…")];
}

export function renderSettingsSearch(theme: BrowserTheme, width: number, input: string): string[] {
	const label = "Search:";
	return [truncateToWidth(`${theme.fg("muted", label)} ${input}`, width, "…")];
}

export function renderDescriptionBlock(theme: BrowserTheme, text: string, width: number): string[] {
	// Trim blank lines at the edges, not indentation or paragraph spacing inside the content.
	const content = text.replace(/\r\n?/g, "\n").replace(/^(?:[^\S\n]*\n)+/, "").replace(/(?:\n[^\S\n]*)+$/, "");
	if (!content.trim()) return [];
	const wrapped = wrapTextWithAnsi(theme.fg("text", content), Math.max(10, width - 2));
	return wrapped.map((line) => truncateToWidth(`  ${line}`, width, "…"));
}

export function renderTopRule(theme: BrowserTheme, width: number): string {
	return theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
}

export function wrapBlock(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(` ${line}`, width, "…"));
}
