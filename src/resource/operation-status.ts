import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function buildSuccessOperationMessage(verb: "Updated package" | "Added package", source: string, output: string): string {
	const summary = summarizeCliOutput(output);
	return summary ? `${verb} ${source} · ${summary}` : `${verb} ${source}`;
}

export function summarizeCliOutput(output: string): string | undefined {
	const normalized = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^(updating|adding)\s+/i.test(line));
	if (normalized.length === 0) return undefined;
	const preferred = normalized.find((line) => /(added|removed|changed|up to date|audited|installed)/i.test(line)) ?? normalized[normalized.length - 1];
	return preferred.replace(/\s+/g, " ").trim();
}

type OperationKind = "add" | "update";
type OperationToken = string;

type OperationEntry = {
	kind: OperationKind;
	text: string;
};

export class ResourceOperationStatusController {
	private spinner: ReturnType<typeof setInterval> | undefined;
	private frameIndex = 0;
	private nextOperationId = 1;
	private readonly activeOperations = new Map<OperationToken, OperationEntry>();

	constructor(
		private readonly ui: ExtensionCommandContext["ui"],
		private readonly theme: Theme,
		private readonly callbacks: {
			hasLoadingState: () => boolean;
			onTick: () => void;
			requestRender: () => void;
			stopBrowserLoadingState: (operation?: OperationKind) => void;
		},
	) {}

	public start(operation: OperationKind, text: string): OperationToken {
		const token = `${operation}:${this.nextOperationId++}`;
		this.activeOperations.set(token, { kind: operation, text });
		this.frameIndex = 0;
		this.setWidget();
		if (!this.spinner) {
			this.spinner = setInterval(() => {
				if (this.activeOperations.size === 0 && !this.callbacks.hasLoadingState()) {
					this.stopInterval();
					this.clearWidget();
					return;
				}
				this.frameIndex += 1;
				this.callbacks.onTick();
				this.setWidget();
				this.callbacks.requestRender();
			}, 100);
		}
		return token;
	}

	public stop(token?: OperationToken): void {
		const entry = token ? this.activeOperations.get(token) : undefined;
		if (token) this.activeOperations.delete(token); else this.activeOperations.clear();
		this.callbacks.stopBrowserLoadingState(entry?.kind);
		if (this.activeOperations.size > 0) this.setWidget(); else this.clearWidget();
		if (this.activeOperations.size === 0 && !this.callbacks.hasLoadingState()) this.stopInterval();
	}

	public dispose(): void {
		this.activeOperations.clear();
		this.clearWidget();
		this.stopInterval();
	}

	private setWidget(): void {
		if (this.activeOperations.size === 0) return;
		this.ui.setWidget("resource-op", this.renderLines(), { placement: "aboveEditor" });
	}

	private clearWidget(): void {
		this.ui.setWidget("resource-op", undefined, { placement: "aboveEditor" });
	}

	private stopInterval(): void {
		if (!this.spinner) return;
		clearInterval(this.spinner);
		this.spinner = undefined;
	}

	private renderLines(): string[] {
		const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length]!;
		return Array.from(this.activeOperations.values()).map((entry) => `${this.theme.fg("accent", frame)} ${this.theme.fg("dim", entry.text)}`);
	}
}
