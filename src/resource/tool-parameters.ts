/** Small, display-only summaries of top-level tool arguments; never retain the full schema. */
import type { ToolParameterSummary } from "../types.js";

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function summarizeToolParameters(schema: unknown): ToolParameterSummary[] | undefined {
	if (!record(schema)) return undefined;
	const root = resolveSchema(schema, schema);
	if (!record(root.properties)) {
		// An absent schema is not proof that the tool accepts no arguments.
		return root.type === "object" && root.additionalProperties === false ? [] : undefined;
	}
	const required = new Set(Array.isArray(root.required) ? root.required : []);
	return Object.entries(root.properties).map(([name, raw]) => {
		const property = record(raw) ? resolveSchema(raw, schema) : {};
		return {
			name,
			type: formatType(property, schema),
			required: required.has(name),
			description: typeof property.description === "string" ? singleLine(property.description) : undefined,
			// Only scalar defaults are useful in a compact argument list. Never dump objects or arrays.
			defaultValue: property.default === null || ["string", "number", "boolean"].includes(typeof property.default)
				? formatDefault(property.default) : undefined,
		};
	});
}

function resolveSchema(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
	let current = schema;
	const seen = new Set<string>();
	while (typeof current.$ref === "string" && current.$ref.startsWith("#/") && !seen.has(current.$ref)) {
		seen.add(current.$ref);
		let target: unknown = root;
		for (const part of current.$ref.slice(2).split("/")) {
			target = record(target) ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
		}
		if (!record(target)) break;
		current = { ...target, ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "$ref")) };
	}
	return current;
}

function formatType(schema: Record<string, unknown>, root: Record<string, unknown>, depth = 0): string {
	if (depth > 3) return "…";
	if (Array.isArray(schema.enum) || schema.const !== undefined) return "enum";
	const alternatives = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(alternatives)) {
		const types = [...new Set(alternatives.filter(record).map((item) => formatType(resolveSchema(item, root), root, depth + 1)))];
		return types.length > 3 ? "union" : types.join(" | ") || "unknown";
	}
	if (Array.isArray(schema.type)) return schema.type.filter((item): item is string => typeof item === "string").join(" | ") || "unknown";
	if (schema.type === "array" || schema.items !== undefined) {
		if (!record(schema.items)) return "array";
		const item = formatType(resolveSchema(schema.items, root), root, depth + 1);
		return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
	}
	if (typeof schema.type === "string") return schema.type;
	if (schema.properties !== undefined || schema.additionalProperties !== undefined) return "object";
	return "unknown";
}

function formatDefault(value: unknown): string {
	const text = singleLine(JSON.stringify(value));
	return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}
