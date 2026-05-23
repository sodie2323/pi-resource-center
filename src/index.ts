/**
 * 插件主入口：注册 /resource 命令并分发子命令。
 *
 * 注意：这里刻意避免静态导入 discovery/browser/commands/completions。
 * Pi 加载扩展时会计入整个静态 import 图的 jiti 转译时间；resource-center 的
 * 浏览器和发现逻辑文件较多，如果在入口里 eager import，会显著拖慢启动。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResourceCompletionProvider } from "./resource/completions.js";
import type { ResourceCategory } from "./types.js";

const CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

let completionProviderPromise: Promise<ResourceCompletionProvider> | undefined;
let sessionCwd = process.cwd();

async function getCompletionProvider(): Promise<ResourceCompletionProvider> {
	const completions = await (completionProviderPromise ??= import("./resource/completions.js").then(({ ResourceCompletionProvider }) => new ResourceCompletionProvider()));
	completions.setCwd(sessionCwd);
	return completions;
}

export default function resourceCenter(pi: ExtensionAPI) {
	pi.registerCommand("resource", {
		description: "Browse packages, skills, extensions, prompts, and themes",
		getArgumentCompletions: async (prefix) => {
			const completions = await getCompletionProvider();
			return completions.getArgumentCompletions(prefix);
		},
		handler: async (args, ctx) => {
			await handleResourceCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 只记录 cwd，不导入补全/发现/浏览器模块；资源发现会在打开 /resource、sync、
		// 或首次需要资源补全时按需执行，避免拖慢 Pi 启动。
		sessionCwd = ctx.cwd;
	});

	pi.on("resources_discover", async () => {
		return {};
	});
}

async function handleResourceCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const completions = await getCompletionProvider();
	completions.setCwd(ctx.cwd);
	const [subcommand] = args.trim().split(/\s+/, 1);
	if (!subcommand) {
		const { openResourceBrowser } = await import("./resource/browser-open.js");
		await openResourceBrowser("packages", ctx, pi);
		return;
	}

	if (isCategory(subcommand)) {
		const { openResourceBrowser } = await import("./resource/browser-open.js");
		await openResourceBrowser(subcommand, ctx, pi);
		return;
	}

	if (subcommand === "sync") {
		const [{ discoverResources }, { readResourceCenterSettings, syncExternalSkillSourcesToPiSettings }] = await Promise.all([
			import("./resource/discovery.js"),
			import("./settings.js"),
		]);
		const settings = await readResourceCenterSettings();
		await syncExternalSkillSourcesToPiSettings(settings.externalSkillSources, settings.externalSkillSources);
		const resources = await discoverResources(ctx.cwd, ctx.ui.theme.name);
		await completions.refresh(ctx.cwd);
		const count = Object.values(resources.categories).reduce((sum, items) => sum + items.length, 0);
		ctx.ui.notify(`Discovered ${count} resources`, "info");
		return;
	}

	const { handleAddCommand, handleExposureCommand, handleMutateCommand } = await import("./resource/commands.js");
	const refresh = () => completions.refresh(ctx.cwd);
	if (subcommand === "add") {
		await handleAddCommand(sliceCommandArgs(args, subcommand), ctx, pi, refresh);
		return;
	}
	if (subcommand === "remove") {
		await handleMutateCommand("remove", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "enable") {
		await handleMutateCommand("enable", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "disable") {
		await handleMutateCommand("disable", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "expose") {
		await handleExposureCommand("expose", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "hide") {
		await handleExposureCommand("hide", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}

	ctx.ui.notify(`Unknown /resource subcommand: ${subcommand}`, "warning");
}

function isCategory(value: string): value is ResourceCategory {
	return CATEGORIES.includes(value as ResourceCategory);
}

function sliceCommandArgs(args: string, subcommand: string): string {
	return args.trim().slice(subcommand.length).trim();
}
