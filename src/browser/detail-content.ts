/** Compact, read-only content for tool and prompt details. */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolParameterSummary } from "../types.js";
import type { BrowserTheme } from "./shared.js";

export const TOOL_PARAMETER_WINDOW_SIZE = 4;
export const DESCRIPTION_PREVIEW_LINES = 4;

export function renderToolParameters(theme: BrowserTheme, parameters: ToolParameterSummary[] | undefined, width: number, offset = 0): string[] {
	if (!parameters) return [];
	if (parameters.length === 0) return [theme.fg("text", theme.bold("Parameters")), theme.fg("dim", "  None")];
	const names = parameters.map((parameter) => parameter.name.replace(/\s+/g, " ").trim());
	const nameWidth = Math.min(24, Math.max(8, Math.floor(width / 3)), Math.max(...names.map((name, index) => visibleWidth(name) + Number(parameters[index]!.required))));
	const start = Math.max(0, Math.min(offset, parameters.length - TOOL_PARAMETER_WINDOW_SIZE));
	const end = Math.min(parameters.length, start + TOOL_PARAMETER_WINDOW_SIZE);
	const range = parameters.length > TOOL_PARAMETER_WINDOW_SIZE ? ` · ${start + 1}–${end}/${parameters.length}` : "";
	const title = visibleWidth("Parameters" + range) <= width ? "Parameters" : "Params";
	const legend = parameters.some((parameter) => parameter.required) && visibleWidth(title + range + " · * required") <= width ? " · * required" : "";
	const lines = [theme.fg("text", theme.bold(title)) + theme.fg("dim", range + legend)];
	for (let index = start; index < end; index++) {
		const parameter = parameters[index]!;
		const name = truncateToWidth(names[index]!, Math.max(1, nameWidth - Number(parameter.required)), "…") + (parameter.required ? "*" : "");
		const prefix = `  ${theme.fg("mdCode", name)}${" ".repeat(Math.max(2, nameWidth - visibleWidth(name) + 2))}`;
		const metadata = theme.fg("syntaxType", parameter.type)
			+ (parameter.defaultValue !== undefined ? theme.fg("dim", ` · default ${parameter.defaultValue}`) : "");
		const description = parameter.description?.replace(/\s+/g, " ").trim();
		const descriptionWidth = width - visibleWidth(prefix) - visibleWidth(metadata) - 3;
		if (description && width >= 54 && descriptionWidth >= 16) {
			lines.push(truncateToWidth(`${prefix}${theme.fg("muted", truncateToWidth(description, descriptionWidth, "…"))}${theme.fg("dim", " · ")}${metadata}`, width, "…"));
		} else {
			lines.push(truncateToWidth(`${prefix}${metadata}`, width, "…"));
			if (description) lines.push(truncateToWidth(`    ${theme.fg("muted", description)}`, width, "…"));
		}
	}
	return lines;
}

export function renderPromptPreview(theme: BrowserTheme, text: string, width: number, truncated = false): string[] {
	if (!text.trim()) return [];
	const wrapped = wrapTextWithAnsi(theme.fg("text", text), Math.max(1, width - 2));
	const lines = [theme.fg("text", theme.bold("Preview")),
		...wrapped.slice(0, 6).map((line) => truncateToWidth(`  ${line}`, width, "…"))];
	if (wrapped.length > 6 || truncated) lines.push(truncateToWidth(theme.fg("dim", "  …"), width, "…"));
	return lines;
}

export function promptRepeatsDescription(preview: string, description: string): boolean {
	const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
	const summary = normalize(description);
	if (!summary) return false;
	return [preview.split("\n")[0] ?? "", preview.split(/\n\s*\n/)[0] ?? ""].some((part) => normalize(part) === summary);
}
