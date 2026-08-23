/**
 * Pure helpers for applying Pi's exact +path/-path resource override semantics.
 */

export type ExactOverrideOptions = {
	/** Normalize an entry target before comparison. */
	normalize?: (value: string) => string;
	/** Keep matching plain entries because they are required as discovery roots. */
	preserveMatchingPlainEntries?: boolean;
};

export function getConfigEntryPrefix(entry: string): "+" | "-" | "!" | undefined {
	const prefix = entry[0];
	return prefix === "+" || prefix === "-" || prefix === "!" ? prefix : undefined;
}

export function getConfigEntryTarget(entry: string): string {
	return getConfigEntryPrefix(entry) ? entry.slice(1) : entry;
}

export function setExactOverride(
	entries: readonly string[],
	target: string,
	enabled: boolean,
	options: ExactOverrideOptions = {},
): string[] {
	const normalize = options.normalize ?? normalizeConfigTarget;
	const normalizedTarget = normalize(target);
	const next = entries.filter((entry) => {
		const prefix = getConfigEntryPrefix(entry);
		if (!prefix && options.preserveMatchingPlainEntries) return true;
		return normalize(getConfigEntryTarget(entry)) !== normalizedTarget;
	});
	next.push(`${enabled ? "+" : "-"}${target}`);
	return next;
}

function normalizeConfigTarget(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
