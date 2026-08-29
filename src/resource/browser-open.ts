/**
 * 负责打开资源浏览器，并把浏览器动作连接到实际资源变更逻辑。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ResourceBrowser } from "../browser/browser.js";
import { discoverResources } from "./discovery.js";
import { canRemoveResourceIndividually, isPackageItem, isResourceCenterPackage, isThemeItem, isToolItem, supportsPackageUpdate } from "./capabilities.js";
import { buildSuccessOperationMessage, ResourceOperationStatusController } from "./operation-status.js";
import {
	getExposeErrorMessage,
	getExposeSuccessMessage,
	getRemoveBlockedMessage,
	getRemoveErrorMessage,
	getRemovedConventionFileMessage,
	getRemoveSuccessMessage,
	getToggleErrorMessage,
	getToggleSuccessMessage,
} from "./messages.js";
import { addResourceFromInput, reloadAfterSettingsChange, updatePackageSource } from "./commands.js";
import { readResourceCenterSettings, removeConventionResource, removeResourceFromSettings, saveResourceCenterSettings, setActiveTheme, setDefaultTools, setExternalSkillEnabled, setExternalSkillsEnabled, setResourceExposed, toggleResourceInSettings } from "../settings.js";
import type { ResourceCategory, ResourceItem, ToolResourceItem } from "../types.js";
import type { ToolRuntime } from "./tool-runtime.js";

export async function openResourceBrowser(category: ResourceCategory, ctx: ExtensionCommandContext, toolRuntime: ToolRuntime): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The Resource Center browser is only available in interactive TUI mode. Use /resource subcommands in this mode.", "warning");
		return;
	}
	const resourceCenterSettings = await readResourceCenterSettings();
	const resources = await discoverResources(ctx.cwd, ctx.ui.theme.name, { projectTrusted: ctx.isProjectTrusted(), toolRuntime });
	let currentResourceCenterSettings = resourceCenterSettings;
	let hasPendingChanges = false;

	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		let browserOpen = true;
		let browser!: ResourceBrowser;
		let refreshGeneration = 0;
		let settingsSaveQueue: Promise<void> = Promise.resolve();
		let toolMutationQueue: Promise<void> = Promise.resolve();
		const requestRender = () => {
			if (browserOpen) tui.requestRender();
		};
		const refreshBrowser = async () => {
			const generation = ++refreshGeneration;
			const nextResources = await discoverResources(ctx.cwd, ctx.ui.theme.name, {
				projectTrusted: ctx.isProjectTrusted(),
				syncExternalSkills: false,
				toolRuntime,
			});
			if (!browserOpen || generation !== refreshGeneration) return;
			browser.setResources(nextResources);
			requestRender();
		};
		const operationStatus = new ResourceOperationStatusController(ctx.ui, theme, {
			hasLoadingState: () => browser.hasLoadingState(),
			onTick: () => browser.advanceLoadingFrame(),
			requestRender,
			stopBrowserLoadingState: (operation) => {
				if (!operation || operation === "update") browser.stopActionLoading("update");
				if (!operation || operation === "add") browser.stopAddLoading();
			},
		});
		const setActionMessage = (action: "toggle" | "expose" | "update" | "remove", type: "info" | "warning" | "error", text: string) => {
			browser.setActionMessage(action, type, text);
			requestRender();
		};
		const setToolsEnabledNow = async (items: ToolResourceItem[], enabled: boolean): Promise<string | undefined> => {
			const active = new Set(toolRuntime.getActiveTools());
			for (const item of items) {
				if (enabled) active.add(item.name); else active.delete(item.name);
			}
			const builtinItem = items.find((item) => item.builtin);
			let settingsPath: string | undefined;
			if (builtinItem) {
				const scope = builtinItem.scope;
				if (scope === "session") throw new Error("Built-in tools require user or project scope");
				const builtinNames = new Set(
					toolRuntime.getAllTools()
						.filter((tool) => tool.sourceInfo.source === "builtin")
						.map((tool) => tool.name),
				);
				const activeBuiltinNames = [...active].filter((name) => builtinNames.has(name));
				settingsPath = await setDefaultTools(ctx.cwd, activeBuiltinNames, scope, ctx.isProjectTrusted());
			}
			toolRuntime.setActiveTools([...active]);
			return settingsPath;
		};
		const setToolsEnabled = (items: ToolResourceItem[], enabled: boolean): Promise<string | undefined> => {
			const operation = toolMutationQueue.then(() => setToolsEnabledNow([...items], enabled));
			toolMutationQueue = operation.then(() => undefined, () => undefined);
			return operation;
		};
		const closeBrowser = async () => {
			browserOpen = false;
			refreshGeneration += 1;
			done(undefined);
			await Promise.all([settingsSaveQueue, toolMutationQueue]);
			if (!hasPendingChanges) return;
			await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
		};
		const startUpdateSpinner = (source: string) => {
			const token = operationStatus.start("update", `Updating ${source}...`);
			browser.startActionLoading("update", `Updating ${source}`);
			requestRender();
			return token;
		};
		const updatePackage = async (item: ResourceItem) => {
			if (!isPackageItem(item)) {
				setActionMessage("update", "warning", "Only packages can be updated here");
				return;
			}
			if (!supportsPackageUpdate(item)) {
				setActionMessage("update", "warning", "Only remote packages can be updated");
				return;
			}
			const operationToken = startUpdateSpinner(item.source);
			try {
				await updatePackageSource(ctx.cwd, item.source, ctx.isProjectTrusted());
				operationStatus.stop(operationToken);
				hasPendingChanges = true;
				if (browserOpen) await refreshBrowser();
				const message = buildSuccessOperationMessage("Updated package", item.source, "");
				setActionMessage("update", "info", message);
				ctx.ui.notify(message, "info");
				if (!browserOpen) await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
			} catch (error: unknown) {
				operationStatus.stop(operationToken);
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("update", "error", `Failed to update package: ${message}`);
				ctx.ui.notify(`Failed to update package: ${message}`, "warning");
			}
		};
		const toggleItem = async (item: ResourceItem) => {
			try {
				if (isPackageItem(item) && !item.enabled && isResourceCenterPackage(item)) {
					item.enabled = true;
					setActionMessage("toggle", "warning", "Resource Center cannot disable itself while it is running. Use pi config if this is intentional.");
					return;
				}
				if (isToolItem(item)) {
					const settingsPath = await setToolsEnabled([item], item.enabled);
					await refreshBrowser();
					setActionMessage(
						"toggle",
						"info",
						`${item.enabled ? "Enabled" : "Disabled"} tool ${item.name}${settingsPath ? ` · ${settingsPath}` : " · current session"}`,
					);
					return;
				}
				if ("externalSkillId" in item && item.externalSkillId) {
					const statePath = await setExternalSkillEnabled(item.externalSkillId, item.enabled);
					hasPendingChanges = true;
					await refreshBrowser();
					setActionMessage("toggle", "info", getToggleSuccessMessage(item, statePath));
					return;
				}
				if (isThemeItem(item)) {
					if (!ctx.ui.getTheme(item.name)) throw new Error(`Theme ${item.name} is not loaded`);
					const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope, ctx.isProjectTrusted());
					const themeResult = ctx.ui.setTheme(item.name);
					if (!themeResult.success) throw new Error(`Theme setting was saved, but the UI switch failed: ${themeResult.error}`);
					await refreshBrowser();
					setActionMessage("toggle", "info", getToggleSuccessMessage(item, settingsPath));
					return;
				}
				const settingsPath = await toggleResourceInSettings(ctx.cwd, item, ctx.isProjectTrusted());
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("toggle", "info", getToggleSuccessMessage(item, settingsPath));
			} catch (error: unknown) {
				if (item.category !== "themes") item.enabled = !item.enabled;
				setActionMessage("toggle", "error", getToggleErrorMessage(item, error));
			}
		};
		const toggleGroup = async (items: ResourceItem[], enabled: boolean, label: string) => {
			const previousStates = items.map((item) => ({ item, enabled: item.enabled }));
			try {
				if (items.every(isToolItem)) {
					const changedItems = items.filter((item) => item.enabled !== enabled);
					for (const item of changedItems) item.enabled = enabled;
					const settingsPath = await setToolsEnabled(changedItems, enabled);
					await refreshBrowser();
					setActionMessage(
						"toggle",
						"info",
						`${enabled ? "Enabled" : "Disabled"} ${changedItems.length} tools in ${label}${settingsPath ? ` · ${settingsPath}` : " · current session"}`,
					);
					return;
				}
				let settingsPath: string | undefined;
				let changedCount = 0;
				const changedItems = items.filter((item) => item.enabled !== enabled);
				const externalSkillIds = changedItems.flatMap((item) =>
					"externalSkillId" in item && item.externalSkillId ? [item.externalSkillId] : [],
				);
				for (const item of changedItems) item.enabled = enabled;
				if (externalSkillIds.length > 0) {
					settingsPath = await setExternalSkillsEnabled(externalSkillIds, enabled);
					changedCount += externalSkillIds.length;
				}
				for (const item of changedItems) {
					if ("externalSkillId" in item && item.externalSkillId) continue;
					settingsPath = await toggleResourceInSettings(ctx.cwd, item, ctx.isProjectTrusted());
					changedCount += 1;
				}
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("toggle", "info", `${enabled ? "Enabled" : "Disabled"} ${changedCount} skills in ${label}${settingsPath ? ` · ${settingsPath}` : ""}`);
			} catch (error: unknown) {
				for (const state of previousStates) state.item.enabled = state.enabled;
				await refreshBrowser();
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("toggle", "error", `Failed to update ${label}: ${message}`);
			}
		};
		const exposeItem = async (item: ResourceItem) => {
			try {
				const statePath = await setResourceExposed(ctx.cwd, item, Boolean(item.exposed));
				await refreshBrowser();
				setActionMessage("expose", "info", getExposeSuccessMessage(item, Boolean(item.exposed), statePath));
			} catch (error: unknown) {
				item.exposed = !item.exposed;
				setActionMessage("expose", "error", getExposeErrorMessage(item, Boolean(item.exposed), error));
			}
		};
		const removeItem = async (item: ResourceItem) => {
			try {
				if (!canRemoveResourceIndividually(item)) {
					setActionMessage("remove", "warning", getRemoveBlockedMessage(item) ?? "Remove is not allowed for this resource.");
					return;
				}
				if (item.source === "convention") {
					const filePath = await removeConventionResource(item);
					await refreshBrowser();
					setActionMessage("remove", "info", getRemovedConventionFileMessage(filePath));
					requestRender();
					return;
				}
				const settingsPath = await removeResourceFromSettings(ctx.cwd, item, ctx.isProjectTrusted());
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("remove", "info", getRemoveSuccessMessage(item, settingsPath));
				requestRender();
			} catch (error: unknown) {
				setActionMessage("remove", "error", getRemoveErrorMessage(item, error));
			}
		};
		const addResource = async (request: { input: string; scope: "project" | "user"; preferredCategory?: import("./add-detect.js").AddPathCategory }): Promise<void> => {
			const operationToken = operationStatus.start("add", `Adding ${request.input}...`);
			try {
				const result = await addResourceFromInput(ctx.cwd, request.input, request.scope, request.preferredCategory, ctx.isProjectTrusted());
				hasPendingChanges = true;
				if (browserOpen) await refreshBrowser();
				operationStatus.stop(operationToken);
				ctx.ui.notify(result.message, "info");
				if (browserOpen === false) await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				operationStatus.stop(operationToken);
				ctx.ui.notify(message, "warning");
				throw error;
			}
		};

		browser = new ResourceBrowser(theme, resources, category, resourceCenterSettings, {
			onClose: closeBrowser,
			onInspect: undefined,
			onToggle: (item) => void toggleItem(item),
			onToggleGroup: (items, enabled, label) => void toggleGroup(items, enabled, label),
			onExpose: (item) => void exposeItem(item),
			onUpdate: (item) => void updatePackage(item),
			onRemove: (item) => void removeItem(item),
			onAdd: (request) => addResource(request),
			onSettingsChange: (settings) => {
				const previousExternalSources = JSON.stringify(currentResourceCenterSettings.externalSkillSources);
				const nextExternalSources = JSON.stringify(settings.externalSkillSources);
				const externalSourcesChanged = previousExternalSources !== nextExternalSources;
				if (externalSourcesChanged) hasPendingChanges = true;
				currentResourceCenterSettings = settings;
				const settingsSnapshot = structuredClone(settings);
				settingsSaveQueue = settingsSaveQueue
					.then(async () => {
						await saveResourceCenterSettings(settingsSnapshot);
						if (externalSourcesChanged && browserOpen) await refreshBrowser();
					})
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to save resource center settings: ${message}`, "error");
					});
			},
			onRequestRender: requestRender,
		}, ctx.cwd, keybindings);
		return {
			render: (width) => browser.render(width),
			invalidate: () => browser.invalidate(),
			handleInput: (data) => {
				browser.handleInput(data);
				requestRender();
			},
		};
	});
}
