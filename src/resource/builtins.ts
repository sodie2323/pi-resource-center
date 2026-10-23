/** Built-in extension resource names shipped by Pi 1.4. */
export const BUILTIN_EXTENSIONS = {
	"llama.cpp": "Manage local models served by llama.cpp",
	codemode: "Run JavaScript that calls tools and models",
	"tool-search": "Find and activate tools on demand",
	mcp: "Connect and manage MCP servers",
} as const;

export function isBuiltinExtensionPath(path: string): boolean {
	return path.startsWith("builtin:");
}

export function getBuiltinExtensionDescription(path: string): string {
	const name = path.slice("builtin:".length) as keyof typeof BUILTIN_EXTENSIONS;
	return BUILTIN_EXTENSIONS[name] ?? "Built-in Pi extension";
}
