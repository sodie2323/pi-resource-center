import { basename, extname } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolResourceItem, ToolResourceScope } from "../types.js";

export interface ToolRuntime {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export function isKnownBuiltinToolName(name: string): boolean {
	return BUILTIN_TOOL_NAMES.has(name);
}

export function buildToolResourceItems(
	allTools: ToolInfo[],
	activeToolNames: string[],
	builtinScope: "project" | "user",
): ToolResourceItem[] {
	const active = new Set(activeToolNames);
	return allTools.map((tool) => {
		const builtin = tool.sourceInfo.source === "builtin";
		const overridesBuiltin = !builtin && isKnownBuiltinToolName(tool.name);
		const scope: ToolResourceScope = builtin
			? builtinScope
			: tool.sourceInfo.scope === "temporary"
				? "session"
				: tool.sourceInfo.scope;
		const sourceLabel = tool.sourceInfo.origin === "package"
			? tool.sourceInfo.source
			: tool.sourceInfo.path.startsWith("<")
				? tool.sourceInfo.source
				: `local:${basename(tool.sourceInfo.path, extname(tool.sourceInfo.path))}`;
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
			overridesBuiltin,
			toolSourcePath: tool.sourceInfo.path,
			toolSourceOrigin: tool.sourceInfo.origin,
			packageSource: tool.sourceInfo.origin === "package" ? tool.sourceInfo.source : undefined,
		};
	});
}

export function getToolGroupId(item: ToolResourceItem): string {
	const sourceKey = item.toolSourceOrigin === "package" || item.source === "builtin" || item.source === "sdk"
		? item.source
		: item.toolSourcePath;
	return `tool-source:${item.scope}:${item.toolSourceOrigin}:${sourceKey}`;
}

