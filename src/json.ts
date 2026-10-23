/** Match Pi's handling of UTF-8 files rewritten with a BOM (e.g. by PowerShell 5.1). */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
