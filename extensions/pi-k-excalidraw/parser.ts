/**
 * Pure parsing and resolution helpers for Excalidraw element streams.
 *
 * Extracted from index.ts so they can be unit-tested without pulling in
 * pi runtime, glimpse, or filesystem dependencies. All functions in this
 * module are deterministic and side-effect-free.
 */

/** Excalidraw element with the few fields we inspect (everything else is opaque). */
export interface ExcalidrawElement {
	type: string;
	id?: string;
	ids?: string;
	containerId?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

/** Viewport extracted from a `cameraUpdate` pseudo-element. */
export interface Viewport {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Result of resolving pseudo-elements (restoreCheckpoint, delete, cameraUpdate). */
export interface ResolvedDiagram {
	resolved: ExcalidrawElement[];
	viewport: Viewport | null;
}

/** Pseudo-element types that don't get drawn — they control camera, deletion, or restoration. */
export const PSEUDO_TYPES: ReadonlySet<string> = new Set([
	"cameraUpdate",
	"delete",
	"restoreCheckpoint",
]);

/** Find the byte offset of the first un-escaped `"` in a JSON-string body.
 *  Returns the input length if no unescaped quote is found. */
export function findJsonStringEnd(s: string): number {
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") { i++; continue; }
		if (c === '"') return i;
	}
	return s.length;
}

/** Parse a possibly-truncated JSON array of elements. Mirrors excalidraw-mcp's
 *  `parsePartialElements`: strict parse first, else trim to the last `}` and
 *  append `]` to recover a valid prefix. The `partial` flag tells callers
 *  whether the result includes a potentially incomplete last item (the closing
 *  `}` we found may have belonged to a nested object). */
export function parsePartialElementArray(
	arrayText: string,
): { elements: ExcalidrawElement[]; partial: boolean } {
	const trimmed = arrayText.trim();
	if (!trimmed.startsWith("[")) return { elements: [], partial: true };

	try {
		return { elements: JSON.parse(trimmed) as ExcalidrawElement[], partial: false };
	} catch { /* fall through to recovery */ }

	const lastClose = trimmed.lastIndexOf("}");
	if (lastClose < 0) return { elements: [], partial: true };

	try {
		const recovered = `${trimmed.substring(0, lastClose + 1)}]`;
		return { elements: JSON.parse(recovered) as ExcalidrawElement[], partial: true };
	} catch {
		return { elements: [], partial: true };
	}
}

/** Try to JSON-parse a string body wrapped in quotes, returning undefined on failure. */
function tryParseJsonString(body: string): string | undefined {
	try { return JSON.parse(`"${body}"`) as string; } catch { return undefined; }
}

/** Extract whatever Excalidraw elements we can parse out of a partial stream
 *  of `draw_diagram` argument JSON like `{"elements":"[{...},{...},...`.
 *  Handles JSON-string-inside-JSON unescaping and trailing partial escapes.
 *
 *  All elements returned are guaranteed to have come from successful
 *  `JSON.parse` of a brace-balanced prefix — the recovery path trims to the
 *  last `}` and appends `]`, which only succeeds when every preceding `{`
 *  was matched. So no "incomplete-last" item leaks through. */
export function extractStreamingElements(argsStr: string): ExcalidrawElement[] {
	const match = argsStr.match(/"elements"\s*:\s*"/);
	if (!match || match.index === undefined) return [];

	let inner = argsStr.substring(match.index + match[0].length);
	inner = inner.substring(0, findJsonStringEnd(inner));
	if (inner.endsWith("\\")) inner = inner.slice(0, -1);

	const unescaped = tryParseJsonString(inner);
	if (unescaped === undefined) return [];

	return parsePartialElementArray(unescaped).elements;
}

/** Collect ids referenced by `delete` pseudo-elements (comma-separated `ids` field). */
export function collectDeleteIds(parsed: ExcalidrawElement[]): Set<string> {
	const out = new Set<string>();
	for (const el of parsed) {
		if (el.type !== "delete") continue;
		for (const id of String(el.ids ?? el.id ?? "").split(",")) {
			const trimmed = id.trim();
			if (trimmed) out.add(trimmed);
		}
	}
	return out;
}

/** Extract the viewport from the last cameraUpdate, or null if none had a valid rect. */
export function extractViewport(parsed: ExcalidrawElement[]): Viewport | null {
	const last = parsed.findLast((el) => el.type === "cameraUpdate");
	if (!last || typeof last.x !== "number" || typeof last.y !== "number" || !last.width || !last.height) {
		return null;
	}
	return { x: last.x, y: last.y, width: last.width, height: last.height };
}

/**
 * Resolve an array of raw elements: apply restoreCheckpoint, drop deleted ids,
 * pull out the last cameraUpdate as the viewport. Throws on invalid checkpoint id.
 *
 * `getCheckpoint` is injected so this function stays pure with respect to the
 * caller's checkpoint store (in production: a Map; in tests: a fixture).
 */
export function resolveElements(
	parsed: ExcalidrawElement[],
	getCheckpoint: (id: string) => ExcalidrawElement[] | undefined,
): ResolvedDiagram {
	const deleteIds = collectDeleteIds(parsed);
	const restoreEl = parsed.find((el) => el.type === "restoreCheckpoint");

	let base: ExcalidrawElement[] = [];
	if (restoreEl?.id) {
		const stored = getCheckpoint(restoreEl.id);
		if (!stored) {
			throw new Error(
				`Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Recreate the diagram from scratch.`,
			);
		}
		base = stored;
	}

	const keepBase = (el: ExcalidrawElement): boolean =>
		!(el.id && deleteIds.has(el.id)) && !(el.containerId && deleteIds.has(el.containerId));
	const keepNew = (el: ExcalidrawElement): boolean => !PSEUDO_TYPES.has(el.type);

	return {
		resolved: [...base.filter(keepBase), ...parsed.filter(keepNew)],
		viewport: extractViewport(parsed),
	};
}
