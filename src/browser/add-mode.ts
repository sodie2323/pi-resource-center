import { type Input, type Theme, getKeybindings, truncateToWidth } from "@mariozechner/pi-tui";
import { detectAddTargetSync, type AddPathCategory, type AddTarget } from "../resource/add-detect.js";
import { getAddSuggestions, type AddSuggestion } from "./add-suggestions.js";
import { moveSelection } from "./navigation.js";

export interface AddModeState {
	scope: "project" | "user";
	detection: AddTarget;
	suggestions: AddSuggestion[];
	selectedSuggestionIndex: number;
	selectedCandidateIndex: number;
	loading: boolean;
	requestId: number;
	returnMode: "list" | "detail" | "packageGroups" | "packageItems" | "settings";
}

export function createInitialAddModeState(scope: "project" | "user", returnMode: AddModeState["returnMode"]): AddModeState {
	return {
		scope,
		detection: { kind: "invalid", reason: "Enter a package source or local path." },
		suggestions: [],
		selectedSuggestionIndex: 0,
		selectedCandidateIndex: 0,
		loading: false,
		requestId: 0,
		returnMode,
	};
}

export function renderAddPage(theme: Theme, width: number, input: Input, state: AddModeState): string[] {
	const scopeLabel = state.scope === "project"
		? theme.fg("success", "project")
		: theme.fg("warning", "user");
	const lines = [
		truncateToWidth(`Scope: ${scopeLabel}  ${theme.fg("dim", "(Tab to switch)")}`, width, "…"),
		truncateToWidth(`Source: ${input.render(Math.max(1, width - 8))[0] ?? ""}`, width, "…"),
	];
	if (input.getValue().trim() && state.suggestions.length > 0 && !state.loading) {
		lines.push("");
		for (const [index, suggestion] of state.suggestions.entries()) {
			const isSelected = index === state.selectedSuggestionIndex;
			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const label = isSelected ? theme.fg("accent", suggestion.label) : suggestion.label;
			const description = suggestion.description ? theme.fg("dim", `  ${suggestion.description}`) : "";
			lines.push(truncateToWidth(`${prefix}${label}${description}`, width, "…"));
		}
	}
	lines.push("");
	if (state.detection.kind === "package") {
		lines.push(truncateToWidth(theme.fg("success", `Detected: package · ${state.detection.description}`), width, "…"));
	} else if (state.detection.kind === "path") {
		lines.push(truncateToWidth(theme.fg("success", `Detected: ${formatAddCategoryLabel(state.detection.category)} · ${state.detection.description}`), width, "…"));
	} else if (state.detection.kind === "ambiguous") {
		lines.push(truncateToWidth(theme.fg("warning", state.detection.description), width, "…"));
		lines.push("");
		for (const [index, candidate] of state.detection.candidates.entries()) {
			const prefix = index === state.selectedCandidateIndex ? theme.fg("accent", "> ") : "  ";
			lines.push(truncateToWidth(`${prefix}${formatAddCategoryLabel(candidate)}`, width, "…"));
		}
	} else {
		lines.push(truncateToWidth(theme.fg("warning", state.detection.reason), width, "…"));
	}
	return lines;
}

export function refreshAddDetection(state: AddModeState, inputValue: string, cwd: string): AddModeState {
	const result = detectAddTargetSync(inputValue, cwd);
	return {
		...state,
		detection: result,
		selectedCandidateIndex: result.kind === "ambiguous"
			? Math.max(0, Math.min(state.selectedCandidateIndex, result.candidates.length - 1))
			: 0,
	};
}

export async function refreshAddSuggestions(state: AddModeState, inputValue: string, cwd: string, mode: string): Promise<AddModeState> {
	const requestId = state.requestId + 1;
	const suggestions = await getAddSuggestions(inputValue, cwd);
	if (mode !== "add") return { ...state, requestId };
	const nextSuggestions = suggestions.slice(0, 6);
	return {
		...state,
		requestId,
		suggestions: nextSuggestions,
		selectedSuggestionIndex: Math.max(0, Math.min(state.selectedSuggestionIndex, nextSuggestions.length - 1)),
	};
}

export function applyAcceptedSuggestion(state: AddModeState, input: Input): AddModeState {
	const suggestion = state.suggestions[state.selectedSuggestionIndex];
	if (!suggestion) return state;
	input.setValue(suggestion.value);
	(input as Input & { cursor?: number }).cursor = suggestion.value.length;
	return state;
}

export function handleAddModeNavigation(state: AddModeState, data: string): AddModeState {
	const kb = getKeybindings();
	if (kb.matches(data, "tui.input.tab")) {
		return { ...state, scope: state.scope === "project" ? "user" : "project" };
	}
	if (state.suggestions.length > 0) {
		if (kb.matches(data, "tui.select.up")) {
			return { ...state, selectedSuggestionIndex: moveSelection(state.selectedSuggestionIndex, state.suggestions.length, -1) };
		}
		if (kb.matches(data, "tui.select.down")) {
			return { ...state, selectedSuggestionIndex: moveSelection(state.selectedSuggestionIndex, state.suggestions.length, 1) };
		}
	} else if (state.detection.kind === "ambiguous") {
		if (kb.matches(data, "tui.select.up")) {
			return { ...state, selectedCandidateIndex: moveSelection(state.selectedCandidateIndex, state.detection.candidates.length, -1) };
		}
		if (kb.matches(data, "tui.select.down")) {
			return { ...state, selectedCandidateIndex: moveSelection(state.selectedCandidateIndex, state.detection.candidates.length, 1) };
		}
	}
	return state;
}

function formatAddCategoryLabel(category: AddPathCategory): string {
	return category.slice(0, 1).toUpperCase() + category.slice(1);
}
