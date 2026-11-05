/** Observe already-registered tools while the browser is open; never perform discovery or IO. */
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "./tool-runtime.js";
import { summarizeToolParameters } from "./tool-parameters.js";

export interface RuntimeToolSnapshot {
	tools: ToolInfo[];
	active: string[];
	/** The first live check has completed, even if the visible inventory is empty. */
	ready: boolean;
}

export function observeRuntimeTools(
	runtime: ToolRuntime,
	onChange: (snapshot: RuntimeToolSnapshot) => void,
): { refresh: (force?: boolean) => void; dispose: () => void } {
	let disposed = false;
	let signature: string | undefined;
	const check = (force = false, ready = true) => {
		if (disposed) return;
		try {
			const tools = runtime.getAllTools();
			const active = runtime.getActiveTools();
			// Compare compact, visible argument summaries rather than serializing full schemas.
			const next = JSON.stringify([
				ready,
				tools.map((tool) => [tool.name, tool.description, tool.exposure, tool.namespace?.name, tool.sourceInfo, summarizeToolParameters(tool.parameters)])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
				[...active].sort(),
			]);
			if (!force && next === signature) return;
			onChange({ tools, active, ready });
			signature = next;
		} catch {
			// Keep the last inventory if Pi is replacing its runtime. Retry while still open.
		}
	};
	const refresh = (force = false) => check(force);
	const timer = setInterval(refresh, 1000);
	timer.unref();
	// Seed the list immediately; the first live recheck clears its initial loading state.
	check(false, false);
	return {
		refresh,
		dispose: () => {
			disposed = true;
			clearInterval(timer);
		},
	};
}
