/**
 * Pure helpers for Excalidraw diagram persistence and tool-result formatting.
 *
 * Extracted from index.ts so they can be unit-tested without pulling in pi
 * runtime, glimpse, or webview dependencies. Anything in here is either pure
 * or only touches the filesystem in a tractable, tmp-dir-friendly way.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { ExcalidrawElement } from "./parser.ts";

/** Default project-relative directory for saved Excalidraw diagrams. */
export const DEFAULT_DIAGRAM_DIR = path.join(".pi", "excalidraw-diagrams");

/** Best-effort error message extraction for arbitrary thrown values. */
export function errorMessage(e: unknown): string {
	return (e as Error)?.message ?? String(e);
}

/** Best-effort element count for the streaming-tool-call status line. Returns
 *  the number for valid array input, or an ellipsis while input is partial. */
export function countElements(elementsStr: string): number | string {
	try {
		const v = JSON.parse(elementsStr);
		if (Array.isArray(v)) return v.length;
	} catch { /* partial JSON — fall through */ }
	return "…";
}

/** Slugify a user-supplied diagram name into a safe filename stem. Mirrors the
 *  conventions used by similar pi extensions: lowercased, ASCII letters /
 *  digits / dash, collapsed dashes, trimmed. Falls back to "diagram" if the
 *  input collapses to empty (e.g. all punctuation). */
export function slugifyDiagramName(name: string): string {
	// First replace already collapses runs of non-alphanumerics to a single
	// dash, so no further dedupe is needed before trimming the edges.
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length ? slug.slice(0, 64) : "diagram";
}

/** Build the Excalidraw v2 file format wrapper around an element array. */
export function buildExcalidrawFile(elements: ExcalidrawElement[]): Record<string, unknown> {
	return {
		type: "excalidraw",
		version: 2,
		source: "https://excalidraw.com",
		elements,
		appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
		files: {},
	};
}

/** Parse an Excalidraw v2 file body and pull out the elements array. Throws on
 *  malformed JSON or missing/invalid elements field so callers can surface a
 *  user-facing error message. */
export function parseExcalidrawFile(body: string): ExcalidrawElement[] {
	let parsed: unknown;
	try { parsed = JSON.parse(body); }
	catch (e) { throw new Error(`Invalid JSON: ${errorMessage(e)}`); }
	if (!parsed || typeof parsed !== "object") throw new Error("File is not a JSON object");
	const elements = (parsed as { elements?: unknown }).elements;
	if (!Array.isArray(elements)) throw new Error("Missing or invalid `elements` array");
	return elements as ExcalidrawElement[];
}

/** Resolve the on-disk path for a diagram given a name or explicit path. The
 *  caller decides which is set; this just produces the absolute target. */
export function resolveDiagramPath(
	cwd: string,
	opts: { name?: string; path?: string },
): string {
	if (opts.path) {
		return path.isAbsolute(opts.path) ? opts.path : path.join(cwd, opts.path);
	}
	const slug = slugifyDiagramName(opts.name ?? "");
	return path.join(cwd, DEFAULT_DIAGRAM_DIR, `${slug}.excalidraw`);
}

/** Display `abs` as a cwd-relative path when it lives under cwd, otherwise as
 *  the absolute path. Used when echoing save/load locations to the user. */
export function relativeDisplay(cwd: string, abs: string): string {
	const rel = path.relative(cwd, abs);
	return rel.startsWith("..") ? abs : rel;
}

/** Locate a saved diagram by `name` (basename, slug, or filename with .excalidraw
 *  extension) inside the project's diagram directory. Returns the absolute path
 *  or null if no match. */
export async function findDiagramByName(cwd: string, name: string): Promise<string | null> {
	const dir = path.join(cwd, DEFAULT_DIAGRAM_DIR);
	let entries: string[];
	try { entries = await fs.readdir(dir); }
	catch { return null; }
	const stem = name.replace(/\.excalidraw$/i, "");
	const candidates = [`${stem}.excalidraw`, `${slugifyDiagramName(stem)}.excalidraw`];
	const hit = candidates.find((c) => entries.includes(c));
	return hit ? path.join(dir, hit) : null;
}
