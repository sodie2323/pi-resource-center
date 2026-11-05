/** Change only MCP enabled state. Never create a second connection or copy credentials. */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { stripBom } from "../json.js";
import { getProjectSettingsPath, USER_AGENT_DIR } from "../settings/shared.js";
import type { McpServerResourceItem } from "../types.js";
import { discoverMcpServers } from "./mcp.js";
import type { ToolRuntime } from "./tool-runtime.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

export interface McpToggleResult {
	message: string;
	requiresReload: boolean;
}

export async function setMcpServerEnabled(
	cwd: string,
	item: McpServerResourceItem,
	enabled: boolean,
	projectTrusted: boolean,
	runtime: ToolRuntime,
): Promise<McpToggleResult> {
	if (item.toggleMode === "none" || item.configState === "error" || item.configState === "unknown") {
		throw new Error("No editable MCP configuration is known for this server. Use native /mcp.");
	}
	if (item.scope === "project" && !projectTrusted) throw new Error("Project is not trusted");
	// Reject stale list rows after configuration/ownership changes.
	const current = (await discoverMcpServers(cwd, projectTrusted, runtime, [], []))
		.find((candidate) => candidate.id === item.id);
	if (!current || current.source !== item.source || current.scope !== item.scope || current.toggleMode !== item.toggleMode) {
		throw new Error("MCP server configuration changed. Reopen or sync Resource Center before retrying.");
	}
	if (item.toggleMode === "registration") {
		const server = runtime.getMcpServers?.().find((entry) => entry.name === item.name && entry.extensionPath === item.source);
		if (!server || !runtime.registerMcpServer) throw new Error("This MCP registration cannot be updated here. Use native /mcp.");
		try {
			// Pi enforces ownership: only registrations belonging to this extension can be replaced.
			runtime.registerMcpServer(server.name, { ...server.config, enabled });
		} catch {
			throw new Error("Pi could not update this MCP registration; it may belong to another extension. Use native /mcp.");
		}
		return { requiresReload: false, message: `${enabled ? "Enable" : "Disable"} requested for MCP server ${item.name} · current session` };
	}

	const path = item.scope === "project"
		? join(dirname(getProjectSettingsPath(cwd)), "mcp.json")
		: join(USER_AGENT_DIR, "mcp.json");
	if (resolve(item.source) !== resolve(path)) throw new Error("Unexpected MCP configuration path");
	return withFileMutationQueue(path, async () => {
		let raw: string;
		let parsed: unknown;
		try {
			raw = await readFile(path, "utf8");
			parsed = JSON.parse(stripBom(raw));
		} catch {
			throw new Error("Cannot read MCP configuration; no changes were written.");
		}
		if (!isObject(parsed) || !isObject(parsed.mcpServers) || !Object.hasOwn(parsed.mcpServers, item.name)) {
			throw new Error("MCP server entry is missing or invalid; no changes were written.");
		}
		const entry = parsed.mcpServers[item.name];
		if (!isObject(entry)) throw new Error("MCP server entry is invalid; no changes were written.");
		// Keep explicit true for project deltas: deleting enabled would inherit the user's false.
		entry.enabled = enabled;
		const indent = raw.match(/\n([\t ]+)"/)?.[1] ?? "  ";
		const eol = raw.includes("\r\n") ? "\r\n" : "\n";
		const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
		const output = bom + JSON.stringify(parsed, null, indent).replace(/\n/g, eol) + eol;
		await writeFile(path, output, "utf8");
		return { requiresReload: true, message: `${enabled ? "Enabled" : "Disabled"} MCP server ${item.name} in ${path}` };
	});
}
