import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";

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

export class ResourceOperationStatusController {
	private spinner: ReturnType<typeof setInterval> | undefined;
	private text: string | undefined;
	private frameIndex = 0;

	constructor(
		private readonly ui: ExtensionCommandContext["ui"],
		private readonly theme: Theme,
		private readonly callbacks: {
			hasLoadingState: () => boolean;
			onTick: () => void;
			requestRender: () => void;
			stopBrowserLoadingState: () => void;
		},
	) {}

	public start(text: string): void {
		this.text = text;
		this.frameIndex = 0;
		this.setWidget();
		if (this.spinner) return;
		this.spinner = setInterval(() => {
			if (!this.text && !this.callbacks.hasLoadingState()) {
				this.stopInterval();
				this.clearWidget();
				return;
			}
			this.frameIndex += 1;
			this.callbacks.onTick();
			if (this.text) this.setWidget();
			this.callbacks.requestRender();
		}, 100);
	}

	public stop(): void {
		this.callbacks.stopBrowserLoadingState();
		this.text = undefined;
		this.clearWidget();
		if (!this.callbacks.hasLoadingState()) this.stopInterval();
	}

	public dispose(): void {
		this.text = undefined;
		this.clearWidget();
		this.stopInterval();
	}

	private setWidget(): void {
		if (!this.text) return;
		this.ui.setWidget("resource-op", [this.renderText()], { placement: "aboveEditor" });
	}

	private clearWidget(): void {
		this.ui.setWidget("resource-op", undefined, { placement: "aboveEditor" });
	}

	private stopInterval(): void {
		if (!this.spinner) return;
		clearInterval(this.spinner);
		this.spinner = undefined;
	}

	private renderText(): string {
		const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length]!;
		return `${this.theme.fg("accent", frame)} ${this.theme.fg("dim", this.text ?? "")}`;
	}
}
