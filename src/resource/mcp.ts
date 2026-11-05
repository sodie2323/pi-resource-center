/** MCP overview. Pi owns connections/credentials; configured enabled flags can be edited separately. */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { stripBom } from "../json.js";
import { getProjectSettingsPath, isFileNotFoundError, USER_AGENT_DIR } from "../settings/shared.js";
import type { McpServerResourceItem, ToolResourceScope } from "../types.js";
import type { ToolRuntime } from "./tool-runtime.js";

const RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
type Config = Record<string, unknown>;
type Server = { name: string; config: Config; source: string; scope: ToolResourceScope; label: string };
const object = (value: unknown): value is Config => typeof value === "object" && value !== null && !Array.isArray(value);
const namespaceOf = (name: string) => `mcp__${name.replace(/-/g, "_")}`;

export async function discoverMcpServers(
	cwd: string,
	projectTrusted: boolean,
	runtime: ToolRuntime | undefined,
	tools: ToolInfo[],
	activeTools: string[],
): Promise<McpServerResourceItem[]> {
	const servers = new Map<string, Server>();
	const diagnostics: McpServerResourceItem[] = [];
	const files: Array<{ path: string; scope: "user" | "project" }> = [{ path: join(USER_AGENT_DIR, "mcp.json"), scope: "user" }];
	if (projectTrusted) files.push({ path: join(dirname(getProjectSettingsPath(cwd)), "mcp.json"), scope: "project" });

	for (const { path, scope } of files) {
		let entries: Config;
		try {
			const parsed: unknown = JSON.parse(stripBom(await readFile(path, "utf8")));
			if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers))) throw new Error("Invalid MCP config");
			entries = (parsed.mcpServers ?? {}) as Config;
		} catch (error) {
			if (isFileNotFoundError(error)) continue;
			diagnostics.push(diagnostic(path, scope, "Cannot read MCP configuration. Open native /mcp for diagnostics."));
			continue;
		}
		const seen = new Set<string>();
		for (const [name, raw] of Object.entries(entries)) {
			const namespace = namespaceOf(name);
			if (!/^[A-Za-z0-9_-]+$/.test(name) || !object(raw) || seen.has(namespace)) {
				diagnostics.push(diagnostic(path, scope, "Invalid or colliding MCP server entries. Open native /mcp for diagnostics.", name));
				continue;
			}
			seen.add(namespace);
			const base = servers.get(namespace);
			const override = scope === "project" && raw.command === undefined && raw.url === undefined && raw.type === undefined;
			if (override) {
				if (!base || base.name !== name) {
					diagnostics.push(diagnostic(path, scope, "Project override has no matching user server. Open native /mcp for diagnostics.", name));
					continue;
				}
				// A project delta may only change these native override fields, never transport/auth.
				const config = { ...base.config };
				for (const key of ["enabled", "exposure", "toolExposure"]) if (raw[key] !== undefined) config[key] = raw[key];
				servers.set(namespace, { name, config, scope, source: path, label: "user + project override" });
			} else if (typeof raw.command === "string" || typeof raw.url === "string") {
				servers.set(namespace, { name, config: raw, scope, source: path, label: `${scope}:mcp.json` });
			} else {
				diagnostics.push(diagnostic(path, scope, "Server has no transport. Open native /mcp for diagnostics.", name));
			}
		}
	}

	// getMcpServers() contains extension registrations only; file definitions take precedence.
	for (const server of runtime?.getMcpServers?.() ?? []) {
		const namespace = namespaceOf(server.name);
		if (!servers.has(namespace)) servers.set(namespace, { name: server.name, config: server.config as unknown as Config,
			source: server.extensionPath, scope: "session", label: "extension registration" });
	}
	const items = [...servers].map(([namespace, server]): McpServerResourceItem => {
		const configState = server.source === "runtime" ? "unknown" : server.config.enabled === false ? "disabled" : "enabled";
		return {
			category: "mcp", id: `mcp:${namespace}`, name: server.name, scope: server.scope,
			source: server.source, sourceLabel: server.label,
			description: typeof server.config.description === "string" ? server.config.description : "MCP server managed by Pi.",
			enabled: configState !== "disabled", configState,
			toggleMode: server.source === "runtime" ? "none" : server.scope === "session" ? "registration" : "config",
			exposure: typeof server.config.exposure === "string"
				? server.config.exposure === "codemode-deferred" ? "codemode" : server.config.exposure
				: configState === "unknown" ? undefined : "codemode",
			transport: typeof server.config.url === "string" ? "http" : typeof server.config.command === "string" ? "stdio" : undefined,
			namespace, toolNames: [], activeToolCount: 0, resourceTools: [],
		};
	});
	return updateMcpToolInventory([...items, ...diagnostics], tools, activeTools, false);
}

/** Merge only the runtime inventory; no config reads, skill sync, connections or writes. */
export function updateMcpToolInventory(
	servers: McpServerResourceItem[],
	tools: ToolInfo[],
	activeTools: string[],
	inventoryReady = true,
): McpServerResourceItem[] {
	const byNamespace = new Map<string, ToolInfo[]>();
	const resourceTools: string[] = [];
	for (const tool of tools) {
		if (tool.exposure === "hidden") continue;
		if (RESOURCE_TOOLS.has(tool.name)) resourceTools.push(tool.name);
		const namespace = tool.namespace?.name;
		if (!namespace?.startsWith("mcp__")) continue;
		const grouped = byNamespace.get(namespace) ?? [];
		grouped.push(tool);
		byNamespace.set(namespace, grouped);
	}
	const active = new Set(activeTools);
	const items = servers.filter((server) => server.source !== "runtime" || byNamespace.has(server.namespace));
	const known = new Set(items.map((server) => server.namespace));
	for (const namespace of byNamespace.keys()) {
		if (known.has(namespace)) continue;
		items.push({
			category: "mcp", id: `mcp:${namespace}`, name: namespace.slice("mcp__".length), namespace,
			scope: "session", source: "runtime", sourceLabel: "runtime tools", description: "MCP server managed by Pi.",
			enabled: true, configState: "unknown", toggleMode: "none", toolNames: [], activeToolCount: 0, resourceTools: [],
		});
	}
	return items.map((server) => {
		if (server.configState === "error") return server;
		const registered = byNamespace.get(server.namespace) ?? [];
		return { ...server, toolNames: registered.map((tool) => tool.name).sort(),
			toolsLoading: server.enabled && registered.length === 0 && !inventoryReady,
			activeToolCount: registered.filter((tool) => active.has(tool.name)).length, resourceTools: [...resourceTools].sort() };
	}).sort((a, b) => a.name.localeCompare(b.name));
}

/** Dispatch only an existing slash command; never accidentally send /mcp to a model. */
export function openNativeMcpManager(runtime: ToolRuntime, ctx: Pick<ExtensionCommandContext, "ui">): void {
	if (!runtime.sendUserMessage || !runtime.getCommands?.().some((command) => command.name === "mcp")) {
		ctx.ui.notify("No /mcp command is available. Enable Pi built-in MCP support or your MCP adapter.", "warning");
		return;
	}
	runtime.sendUserMessage("/mcp", { expandPromptTemplates: true });
}

function diagnostic(path: string, scope: "user" | "project", message: string, name?: string): McpServerResourceItem {
	return {
		category: "mcp", id: `mcp:diagnostic:${path}:${name ?? "file"}`, name: name && /^[A-Za-z0-9_-]+$/.test(name) ? name : `${scope} MCP config`,
		scope, source: path, sourceLabel: `${scope}:mcp.json`, description: message,
		enabled: false, configState: "error", toggleMode: "none", namespace: "", toolNames: [], activeToolCount: 0, resourceTools: [],
	};
}
