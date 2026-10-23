import { basename, extname } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { setDefaultToolStates } from "../settings/mutations.js";
import type { ToolResourceItem, ToolResourceScope } from "../types.js";

export interface ToolRuntime {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	getMcpServers?: ExtensionAPI["getMcpServers"];
	sendUserMessage?: ExtensionAPI["sendUserMessage"];
	getCommands?: ExtensionAPI["getCommands"];
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const BUILTIN_EXTENSION_TOOL_NAMES = new Set(["codemode", "tool_search"]);

export function isKnownBuiltinToolName(name: string): boolean {
	return BUILTIN_TOOL_NAMES.has(name);
}

export function buildToolResourceItems(
	allTools: ToolInfo[],
	activeToolNames: string[],
	builtinScope: "project" | "user",
): ToolResourceItem[] {
	const active = new Set(activeToolNames);
	// Hidden tools have been withdrawn by their owner; setActiveTools cannot activate them.
	return allTools.filter((tool) => tool.exposure !== "hidden").map((tool) => {
		// MCP tools are also registered by a built-in extension, but are not persistent built-ins.
		const builtin = tool.sourceInfo.source === "builtin"
			&& (isKnownBuiltinToolName(tool.name) || BUILTIN_EXTENSION_TOOL_NAMES.has(tool.name));
		const overridesBuiltin = !builtin && isKnownBuiltinToolName(tool.name);
		const scope: ToolResourceScope = builtin
			? builtinScope
			: tool.sourceInfo.scope === "temporary"
				? "session"
				: tool.sourceInfo.scope;
		const sourceLabel = formatToolSourceLabel(tool);
		return {
			category: "tools",
			id: `tool:${tool.name}`,
			name: tool.name,
			scope,
			source: tool.sourceInfo.source,
			sourceLabel: builtin ? "builtin" : sourceLabel,
			description: overridesBuiltin
				? `${tool.description} — overrides the built-in ${tool.name} tool`
				: tool.description,
			enabled: active.has(tool.name),
			builtin,
			persistent: builtin,
			exposure: tool.exposure ?? "direct",
			overridesBuiltin,
			toolNamespace: tool.namespace?.name,
			toolSourcePath: tool.sourceInfo.path,
			toolSourceOrigin: tool.sourceInfo.origin,
			packageSource: tool.sourceInfo.origin === "package" ? tool.sourceInfo.source : undefined,
		};
	});
}

function formatToolSourceLabel(tool: ToolInfo): string {
	if (tool.namespace) return tool.namespace.name.replace(/^mcp__/, "mcp:");
	if (tool.sourceInfo.origin === "package") return tool.sourceInfo.source;
	const path = tool.sourceInfo.path;
	if (path.startsWith("builtin:")) return path;
	if (path.startsWith("<")) return tool.sourceInfo.source;
	return `local:${basename(path, extname(path))}`;
}

export function getToolGroupId(item: ToolResourceItem): string {
	const sourceKey = item.toolNamespace ?? (item.toolSourceOrigin === "package" || item.builtin || item.source === "sdk"
		? item.source
		: item.toolSourcePath);
	return `tool-source:${item.scope}:${item.toolSourceOrigin}:${sourceKey}`;
}

let toolMutationQueue: Promise<unknown> = Promise.resolve();

/** Share live-state and defaultTools mutations between the browser and slash commands. */
export function setToolsEnabled(
	runtime: ToolRuntime,
	items: ToolResourceItem[],
	enabled: boolean,
	cwd: string,
	projectTrusted: boolean,
): Promise<string | undefined> {
	const operation = toolMutationQueue.then(async () => {
		const active = new Set(runtime.getActiveTools());
		for (const item of items) {
			if (enabled) active.add(item.name); else active.delete(item.name);
		}
		const persistent = items.filter((item) => item.persistent);
		let settingsPath: string | undefined;
		if (persistent.length > 0) {
			const scope = persistent[0]!.scope;
			if (scope === "session" || persistent.some((item) => item.scope !== scope)) {
				throw new Error("Persistent tool changes require a single user or project scope");
			}
			settingsPath = await setDefaultToolStates(cwd, persistent.map((item) => ({ name: item.name, enabled })), scope, projectTrusted);
		}
		runtime.setActiveTools([...active]);
		return settingsPath;
	});
	toolMutationQueue = operation.catch(() => undefined);
	return operation;
}

export function getToolToggleMessage(item: ToolResourceItem, enabled: boolean, settingsPath?: string): string {
	const location = settingsPath ?? "current session";
	if (item.exposure === "codemode" || item.exposure === "deferred") {
		return enabled
			? `Activated tool ${item.name} · ${location}`
			: `Deactivated tool ${item.name} · ${location} · still callable through codemode/tool search`;
	}
	return `${enabled ? "Enabled" : "Disabled"} tool ${item.name} · ${location}`;
}
