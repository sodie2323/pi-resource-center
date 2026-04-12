import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverResources } from "./discovery.js";
import { addPackageToSettings, removeConventionResource, removeResourceFromSettings, setActiveTheme, setResourceExposed, toggleResourceInSettings } from "./settings.js";
import { normalizeCategoryAlias } from "./resource-completions.js";
import type { ResourceCategory, ResourceItem } from "./types.js";

export async function handleAddCommand(
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts.length > 2) {
		ctx.ui.notify("Usage: /resource add <package-source> [project|user]", "info");
		return;
	}
	const source = parts[0]!;
	const scopeArg = parts[1];
	if (scopeArg && scopeArg !== "project" && scopeArg !== "user") {
		ctx.ui.notify(`Unknown scope "${scopeArg}". Use project or user.`, "warning");
		return;
	}
	const scope = scopeArg === "user" ? "user" : "project";
	const settingsPath = await addPackageToSettings(ctx.cwd, source, scope);
	await refreshCompletions();
	await reloadAfterSettingsChange(ctx, `Added package ${source} · ${settingsPath}`);
}

export async function handleMutateCommand(
	action: "remove" | "enable" | "disable",
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

	const resources = await discoverResources(ctx.cwd);
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
		if (item.packageSource) {
			ctx.ui.notify("This resource comes from a package and can't be removed individually. Disable it instead.", "warning");
			return;
		}
		if (item.category === "themes" && !("path" in item)) {
			ctx.ui.notify(`Built-in theme "${item.name}" can't be removed.`, "warning");
			return;
		}
		if (item.source === "convention") {
			const filePath = await removeConventionResource(item);
			await refreshCompletions();
			ctx.ui.notify(`Deleted file ${filePath}`, "info");
			return;
		}
		const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
		await refreshCompletions();
		await reloadAfterSettingsChange(ctx, `Removed ${item.name} · ${settingsPath}`);
		return;
	}

	if (item.category === "themes") {
		if (item.packageSource && action === "disable") {
			item.enabled = false;
			const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
			await refreshCompletions();
			await reloadAfterSettingsChange(ctx, `Disabled ${item.name} · ${settingsPath}`);
			return;
		}
		if (action === "disable") {
			ctx.ui.notify("Themes aren't disabled directly. Apply another theme instead.", "warning");
			return;
		}
		const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
		ctx.ui.setTheme(item.name);
		await refreshCompletions();
		ctx.ui.notify(`Applied theme ${item.name} · ${settingsPath}`, "info");
		return;
	}

	item.enabled = action === "enable";
	const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
	await refreshCompletions();
	await reloadAfterSettingsChange(
		ctx,
		item.category === "packages"
			? `${action === "enable" ? "Enabled" : "Disabled"} all resources in package ${item.name} · ${settingsPath}`
			: `${action === "enable" ? "Enabled" : "Disabled"} ${item.name} · ${settingsPath}`,
	);
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

	const resources = await discoverResources(ctx.cwd);
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
	if (!item.packageSource || item.category === "packages" || item.category === "themes") {
		ctx.ui.notify("Only package-contained extensions, skills, and prompts can be shown or hidden in top-level categories.", "warning");
		return;
	}
	const exposed = action === "expose";
	const statePath = await setResourceExposed(ctx.cwd, item, exposed);
	await refreshCompletions();
	ctx.ui.notify(`${exposed ? "Shown" : "Hidden"} ${item.name} ${exposed ? "in" : "from"} ${item.category} · ${statePath}`, "info");
}

export async function reloadAfterSettingsChange(ctx: ExtensionCommandContext, message: string): Promise<void> {
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
	return all.filter((item) => {
		const candidates = [item.id, item.name, item.source, item.description];
		if (item.packageRelativePath) candidates.push(item.packageRelativePath);
		if ("path" in item) candidates.push(item.path);
		return candidates.some((value) => value.toLowerCase() === normalized || value.toLowerCase().includes(normalized));
	});
}

function isCategoryAlias(value: string): boolean {
	return ["package", "packages", "skill", "skills", "extension", "extensions", "prompt", "prompts", "theme", "themes"].includes(value);
}
