/**
 * /resource 子命令处理逻辑。
 */
import { DefaultPackageManager, SettingsManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverResources } from "./discovery.js";
import { canExposeResource, canRemoveResourceIndividually, isContainedResource, isResourceCenterPackage, isThemeItem, isToolItem } from "./capabilities.js";
import { getResourceSearchCandidates } from "./identity.js";
import {
	getExposeSuccessMessage,
	getRemoveBlockedMessage,
	getRemovedConventionFileMessage,
	getRemoveSuccessMessage,
	getToggleSuccessMessage,
} from "./messages.js";
import { USER_AGENT_DIR, addPathResourceToSettings, getProjectSettingsPath, getUserSettingsPath, readResourceCenterSettings, removeConventionResource, removeResourceFromSettings, setActiveTheme, setDefaultTools, setResourceExposed, toggleResourceInSettings } from "../settings.js";
import { normalizeCategoryAlias } from "./completions.js";
import { detectAddTarget, getAddTargetSuccessLabel, type AddPathCategory } from "./add-detect.js";
import { buildSuccessOperationMessage } from "./operation-status.js";
import type { ReloadBehavior } from "../settings.js";
import type { ResourceCategory, ResourceItem } from "../types.js";
import type { ToolRuntime } from "./tool-runtime.js";

export async function handleAddCommand(
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify("Usage: /resource add [category] <source-or-path> [project|user]", "info");
		return;
	}
	let scope: "project" | "user" = "project";
	const lastPart = parts.at(-1);
	if (lastPart === "project" || lastPart === "user") {
		scope = lastPart;
		parts.pop();
	}
	let preferredCategory: AddPathCategory | undefined;
	if (parts[0] && isCategoryAlias(parts[0])) {
		const normalized = normalizeCategoryAlias(parts[0]);
		parts.shift();
		if (normalized === "tools") {
			ctx.ui.notify("Tools are registered by Pi and extensions and cannot be added directly", "warning");
			return;
		}
		if (normalized !== "packages") preferredCategory = normalized;
	}
	if (parts.length !== 1) {
		ctx.ui.notify("Usage: /resource add [category] <source-or-path> [project|user]", "info");
		return;
	}
	try {
		const result = await addResourceFromInput(ctx.cwd, parts[0]!, scope, preferredCategory, ctx.isProjectTrusted());
		await refreshCompletions();
		await reloadAfterSettingsChange(ctx, result.message);
		return;
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(detail, "warning");
		return;
	}
}

export async function handleMutateCommand(
	action: "remove" | "enable" | "disable",
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
	toolRuntime: ToolRuntime,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}
	let category: ResourceCategory | undefined;
	let query = args.trim();
	if (isCategoryAlias(parts[0]!)) {
		category = normalizeCategoryAlias(parts[0]!);
		query = args.trim().slice(parts[0]!.length).trim();
	}
	if (!query) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}

	const resources = await discoverResources(ctx.cwd, ctx.ui.theme.name, { projectTrusted: ctx.isProjectTrusted(), toolRuntime });
	const matches = findResources(resources, query, category);
	if (matches.length === 0) {
		ctx.ui.notify(`No resource found for "${query}"`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`More than one resource matched: ${list}`, "warning");
		return;
	}

	const item = matches[0]!;
	if (action === "remove") {
		if (!canRemoveResourceIndividually(item)) {
			ctx.ui.notify(getRemoveBlockedMessage(item) ?? "Remove is not allowed for this resource.", "warning");
			return;
		}
		if (item.source === "convention") {
			const filePath = await removeConventionResource(item);
			await refreshCompletions();
			ctx.ui.notify(getRemovedConventionFileMessage(filePath), "info");
			return;
		}
		const settingsPath = await removeResourceFromSettings(ctx.cwd, item, ctx.isProjectTrusted());
		await refreshCompletions();
		await reloadAfterSettingsChange(ctx, getRemoveSuccessMessage(item, settingsPath));
		return;
	}

	if (isToolItem(item)) {
		const enabled = action === "enable";
		const active = new Set(toolRuntime.getActiveTools());
		if (enabled) active.add(item.name); else active.delete(item.name);
		let settingsPath: string | undefined;
		if (item.builtin) {
			if (item.scope === "session") throw new Error("Built-in tools require user or project scope");
			const builtinNames = new Set(toolRuntime.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
			settingsPath = await setDefaultTools(
				ctx.cwd,
				[...active].filter((name) => builtinNames.has(name)),
				item.scope,
				ctx.isProjectTrusted(),
			);
		}
		toolRuntime.setActiveTools([...active]);
		await refreshCompletions();
		ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} tool ${item.name}${settingsPath ? ` · ${settingsPath}` : " · current session"}`, "info");
		return;
	}

	if (action === "disable" && isResourceCenterPackage(item)) {
		ctx.ui.notify("Resource Center cannot disable its own package while it is running. Use pi config if this is intentional.", "warning");
		return;
	}

	if (isThemeItem(item)) {
		if (isContainedResource(item) && action === "disable") {
			item.enabled = false;
			const settingsPath = await toggleResourceInSettings(ctx.cwd, item, ctx.isProjectTrusted());
			await refreshCompletions();
			await reloadAfterSettingsChange(ctx, getToggleSuccessMessage(item, settingsPath));
			return;
		}
		if (action === "disable") {
			ctx.ui.notify("Themes aren't disabled directly. Apply another theme instead.", "warning");
			return;
		}
		if (!ctx.ui.getTheme(item.name)) {
			ctx.ui.notify(`Failed to apply theme ${item.name}: theme is not loaded`, "warning");
			return;
		}
		const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope, ctx.isProjectTrusted());
		const themeResult = ctx.ui.setTheme(item.name);
		if (!themeResult.success) {
			ctx.ui.notify(`Theme setting was saved, but the UI switch failed: ${themeResult.error}`, "warning");
			return;
		}
		await refreshCompletions();
		ctx.ui.notify(getToggleSuccessMessage(item, settingsPath), "info");
		return;
	}

	item.enabled = action === "enable";
	const settingsPath = await toggleResourceInSettings(ctx.cwd, item, ctx.isProjectTrusted());
	await refreshCompletions();
	await reloadAfterSettingsChange(ctx, getToggleSuccessMessage(item, settingsPath));
}

export async function handleExposureCommand(
	action: "expose" | "hide",
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}
	let category: ResourceCategory | undefined;
	let query = args.trim();
	if (isCategoryAlias(parts[0]!)) {
		category = normalizeCategoryAlias(parts[0]!);
		query = args.trim().slice(parts[0]!.length).trim();
	}
	if (!query) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}

	const resources = await discoverResources(ctx.cwd, ctx.ui.theme.name, { projectTrusted: ctx.isProjectTrusted() });
	const matches = findResources(resources, query, category);
	if (matches.length === 0) {
		ctx.ui.notify(`No resource found for "${query}"`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`More than one resource matched: ${list}`, "warning");
		return;
	}
	const item = matches[0]!;
	if (!canExposeResource(item)) {
		ctx.ui.notify("Only package-contained extensions, skills, and prompts can be shown or hidden in top-level categories.", "warning");
		return;
	}
	const exposed = action === "expose";
	const statePath = await setResourceExposed(ctx.cwd, item, exposed);
	await refreshCompletions();
	ctx.ui.notify(getExposeSuccessMessage(item, exposed, statePath), "info");
}

export interface AddResourceResult {
	message: string;
	settingsPath: string;
	target: Extract<Awaited<ReturnType<typeof detectAddTarget>>, { kind: "package" | "path" }>;
	installOutput?: string;
}

export async function addResourceFromInput(
	cwd: string,
	input: string,
	scope: "project" | "user" = "project",
	preferredCategory?: AddPathCategory,
	projectTrusted = true,
): Promise<AddResourceResult> {
	if (scope === "project" && !projectTrusted) {
		throw new Error("Project is not trusted; refusing to add project resources");
	}
	const target = await detectAddTarget(input, cwd, { preferredCategory });
	if (target.kind === "invalid") throw new Error(target.reason);
	if (target.kind === "ambiguous") {
		throw new Error(`Couldn't infer resource type for ${target.path}. Choose one of: ${target.candidates.join(", ")}`);
	}
	let installOutput: string | undefined;
	let settingsPath: string;
	if (target.kind === "package") {
		installOutput = await installPackageAndPersist(cwd, target.source, scope, projectTrusted);
		settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	} else {
		settingsPath = await addPathResourceToSettings(cwd, target.category, target.path, scope, projectTrusted);
	}
	const message = target.kind === "package" && installOutput !== undefined
		? buildSuccessOperationMessage("Added package", target.source, installOutput)
		: `Added ${getAddTargetSuccessLabel(target)} · ${settingsPath}`;
	return { message, settingsPath, target, installOutput };
}

async function installPackageAndPersist(cwd: string, source: string, scope: "project" | "user", projectTrusted: boolean): Promise<string> {
	const { packageManager, settingsManager } = createPackageManagerRuntime(cwd, projectTrusted);
	await packageManager.installAndPersist(source, { local: scope === "project" });
	await settingsManager.flush();
	return "";
}

export async function updatePackageSource(cwd: string, source: string, projectTrusted: boolean): Promise<void> {
	await createPackageManagerRuntime(cwd, projectTrusted).packageManager.update(source);
}

function createPackageManagerRuntime(cwd: string, projectTrusted: boolean): {
	packageManager: DefaultPackageManager;
	settingsManager: SettingsManager;
} {
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR, { projectTrusted });
	return {
		packageManager: new DefaultPackageManager({ cwd, agentDir: USER_AGENT_DIR, settingsManager }),
		settingsManager,
	};
}

export async function reloadAfterSettingsChange(ctx: ExtensionCommandContext, message: string, reloadBehavior?: ReloadBehavior): Promise<void> {
	const behavior = reloadBehavior ?? (await readResourceCenterSettings()).reloadBehavior;
	if (behavior === "notice") {
		ctx.ui.notify(`${message}. Run /reload to apply changes.`, "info");
		return;
	}
	if (behavior === "prompt") {
		const reloadNow = await ctx.ui.confirm("Settings updated", `${message}. Reload now to apply changes?`);
		if (!reloadNow) {
			ctx.ui.notify(`${message}. Run /reload when you're ready.`, "info");
			return;
		}
	}
	try {
		await ctx.reload();
		return;
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`${message}. Settings were saved, but reload failed: ${detail}`, "warning");
	}
}

export function findResources(resources: { categories: Record<ResourceCategory, ResourceItem[]> }, query: string, category?: ResourceCategory): ResourceItem[] {
	const normalized = query.toLowerCase();
	const all = category ? resources.categories[category] : Object.values(resources.categories).flat();
	return all.filter((item) => getResourceSearchCandidates(item).some((value) => value.toLowerCase() === normalized || value.toLowerCase().includes(normalized)));
}

function isCategoryAlias(value: string): boolean {
	return ["package", "packages", "skill", "skills", "extension", "extensions", "prompt", "prompts", "theme", "themes", "tool", "tools"].includes(value);
}
