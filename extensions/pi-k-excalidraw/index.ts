/**
 * excalidraw — Native Excalidraw diagram preview tool
 *
 * Registers tools so the LLM can draw Excalidraw diagrams that preview live
 * in a glimpse window. Inspired by https://github.com/excalidraw/excalidraw-mcp
 * but reimplemented natively (no MCP child process). Excalidraw renders inside
 * the glimpse webview via @excalidraw/excalidraw loaded from esm.sh.
 *
 * Tools:
 *   - draw_diagram: render an array of Excalidraw elements in the preview window
 *   - save_diagram: write the most recent diagram to a .excalidraw file
 *
 * Commands:
 *   - /excalidraw <description>: kick off a drawing turn; the element-format
 *     cheat sheet is injected into the system prompt for the rest of the
 *     session so the model never has to ask for it.
 */

import { copyToClipboard, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildExcalidrawFile,
	countElements,
	DEFAULT_DIAGRAM_DIR,
	errorMessage,
	findDiagramByName,
	parseExcalidrawFile,
	relativeDisplay,
	resolveDiagramPath,
} from "./diagrams.ts";
import {
	extractStreamingElements,
	resolveElements,
	type ExcalidrawElement,
	type Viewport,
} from "./parser.ts";
import { getWebviewHtml } from "./webview.ts";

export { slugifyDiagramName } from "./diagrams.ts";

/** Maximum allowed size for the elements JSON input (5 MB). */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

/** Minimal subset of the glimpseui window interface we use. */
interface GlimpseWindow {
	on(event: "ready" | "closed" | "message" | "info", cb: (data?: unknown) => void): void;
	send(js: string): void;
	close(): void;
}

/** Minimal subset of the glimpseui module interface we use. */
interface GlimpseModule {
	open(html: string, opts?: Record<string, unknown>): GlimpseWindow;
}

let cachedGlimpse: GlimpseModule | null = null;
let activeWindow: GlimpseWindow | null = null;
let windowReadyPromise: Promise<void> | null = null;

/** Ephemeral checkpoint store: id → resolved elements. Survives within one pi session. */
const checkpoints = new Map<string, ExcalidrawElement[]>();
let lastCheckpointId: string | null = null;

/** Toggled on by /excalidraw. While true, the cheat sheet is injected into the
 *  system prompt at the start of every agent turn. Persists for the session. */
let cheatSheetActive = false;

/** Per-tool-call buffers of streaming `draw_diagram` argument JSON. */
const streamBuffers = new Map<string, string>();

/** Pending Node→webview RPC calls keyed by request id. `cleanup` clears the
 *  timeout and abort listener; calling it before settling guarantees neither
 *  fires after the RPC has finished. */
interface PendingRpc {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
}
const pendingRpcs = new Map<string, PendingRpc>();

/** Throttle gate for streaming updates pushed to the webview. */
let streamThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let streamPendingPayload: { elements: ExcalidrawElement[]; viewport: Viewport | null } | null = null;
const STREAM_THROTTLE_MS = 80;

/** Directory holding standalone prompt markdown files for this extension. */
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

/** Read a prompt markdown file from `prompts/` at module load time. */
function loadPrompt(name: string): string {
	return readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

/** Excalidraw element-format reference injected into the system prompt while
 *  /excalidraw mode is active. */
const ELEMENT_FORMAT_PROMPT = loadPrompt("element-format.md");

/** User-message template for /excalidraw. The literal `{{task}}` placeholder
 *  is replaced with the user's diagram description. */
const DRAW_INSTRUCTION_TEMPLATE = loadPrompt("draw-instruction.md");

/**
 * Lazily import the glimpseui module. Tries the bare specifier first (works when
 * pi resolves through the same global node_modules); falls back to a path derived
 * from process.execPath for unusual install layouts.
 */
async function loadGlimpse(): Promise<GlimpseModule> {
	if (cachedGlimpse) return cachedGlimpse;
	const dynamicImport = (spec: string): Promise<unknown> => import(spec);
	try {
		cachedGlimpse = (await dynamicImport("glimpseui")) as GlimpseModule;
		return cachedGlimpse;
	} catch {
		const nodeBin = process.execPath;
		const candidate = path.resolve(
			path.dirname(nodeBin),
			"..",
			"lib",
			"node_modules",
			"glimpseui",
			"src",
			"glimpse.mjs",
		);
		cachedGlimpse = (await dynamicImport(candidate)) as GlimpseModule;
		return cachedGlimpse;
	}
}

/** Write a PNG image to the macOS pasteboard via osascript. Linux/Windows are
 *  not supported yet — callers should expect a rejection on those platforms. */
async function copyPngToClipboard(bytes: Uint8Array): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error(`Copy PNG is only supported on macOS (got ${process.platform})`);
	}
	const tmp = path.join(os.tmpdir(), `pi-excalidraw-${crypto.randomUUID()}.png`);
	await fs.writeFile(tmp, bytes);
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(
				"osascript",
				["-e", `set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)`],
				(err) => (err ? reject(err) : resolve()),
			);
		});
	} finally {
		await fs.unlink(tmp).catch(() => undefined);
	}
}

/** Send a copy-result ack back to the webview UI. */
function sendCopyResult(win: GlimpseWindow, target: "svg" | "png", ok: boolean, error?: string): void {
	const payload = { ok, target, ...(error ? { error } : {}) };
	win.send(`window.__piOnCopyResult?.(${JSON.stringify(payload)})`);
}

/** Run a copy task and ack the webview with success or the error message. */
async function runCopy(win: GlimpseWindow, target: "svg" | "png", task: () => Promise<void>): Promise<void> {
	try {
		await task();
		sendCopyResult(win, target, true);
	} catch (e) {
		sendCopyResult(win, target, false, errorMessage(e));
	}
}

/** Handle a message from the webview. Routes `copy-svg` / `copy-png` requests
 *  to the appropriate clipboard writer and `rpc-result` replies to the matching
 *  pending RPC entry. */
async function handleWebviewMessage(win: GlimpseWindow, data: unknown): Promise<void> {
	if (!data || typeof data !== "object") return;
	const msg = data as {
		type?: unknown;
		svg?: unknown;
		base64?: unknown;
		id?: unknown;
		ok?: unknown;
		data?: unknown;
		error?: unknown;
	};

	if (msg.type === "copy-svg" && typeof msg.svg === "string") {
		const svg = msg.svg;
		await runCopy(win, "svg", () => copyToClipboard(svg));
		return;
	}

	if (msg.type === "copy-png" && typeof msg.base64 === "string") {
		const base64 = msg.base64;
		await runCopy(win, "png", () => copyPngToClipboard(Buffer.from(base64, "base64")));
		return;
	}

	if (msg.type === "rpc-result" && typeof msg.id === "string") {
		const entry = pendingRpcs.get(msg.id);
		if (!entry) return;
		pendingRpcs.delete(msg.id);
		entry.cleanup();
		if (msg.ok) entry.resolve(msg.data);
		else entry.reject(new Error(typeof msg.error === "string" ? msg.error : "Webview RPC failed"));
		return;
	}
}

/** Settle a pending RPC by id, running its cleanup and rejecting with `err`.
 *  No-op when the RPC has already settled. */
function failPendingRpc(id: string, err: Error): void {
	const entry = pendingRpcs.get(id);
	if (!entry) return;
	pendingRpcs.delete(id);
	entry.cleanup();
	entry.reject(err);
}

/** Send an RPC request to the webview and wait for its reply. Honors the
 *  caller's AbortSignal and a per-call timeout. */
function callWebviewRpc<T = unknown>(
	method: string,
	args: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (!activeWindow) {
			reject(new Error("Preview window is not open. Call draw_diagram or draw_mermaid_diagram first."));
			return;
		}
		if (signal?.aborted) {
			reject(new Error("Aborted before RPC dispatch"));
			return;
		}
		const id = crypto.randomUUID();
		const timer = setTimeout(
			() => failPendingRpc(id, new Error(`Webview RPC "${method}" timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		const onAbort = () => failPendingRpc(id, new Error(`Webview RPC "${method}" aborted`));
		signal?.addEventListener("abort", onAbort);
		pendingRpcs.set(id, {
			resolve: (data) => resolve(data as T),
			reject,
			cleanup: () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			},
		});
		activeWindow.send(`window.__piRpcRequest?.(${JSON.stringify({ method, id, args })})`);
	});
}

/** Open a fresh preview window and return a promise that resolves on "ready". */
async function openPreviewWindow(): Promise<void> {
	const glimpse = await loadGlimpse();
	const win = glimpse.open(getWebviewHtml(), {
		width: 1000,
		height: 750,
		title: "Excalidraw Preview",
	});
	activeWindow = win;
	win.on("closed", () => {
		activeWindow = null;
		windowReadyPromise = null;
	});
	win.on("message", (data) => { void handleWebviewMessage(win, data); });
	await new Promise<void>((resolve) => win.on("ready", () => resolve()));
}

/**
 * Open a glimpse window if none exists, wait for it to be ready, then push the
 * payload. Concurrent calls share a single readiness promise; subsequent calls
 * after ready just send.
 */
async function ensureWindow(payload: { elements: ExcalidrawElement[]; viewport: Viewport | null }): Promise<void> {
	if (!windowReadyPromise) windowReadyPromise = openPreviewWindow();
	await windowReadyPromise;
	activeWindow?.send(`window.__piRender(${JSON.stringify(payload)})`);
}

/** Schedule a throttled streaming update to the preview window. The window is
 *  opened on first call so it's already loading by the time elements arrive. */
function scheduleStreamUpdate(elements: ExcalidrawElement[], viewport: Viewport | null): void {
	streamPendingPayload = { elements, viewport };
	if (!windowReadyPromise) windowReadyPromise = openPreviewWindow();
	if (streamThrottleTimer) return;
	streamThrottleTimer = setTimeout(() => {
		streamThrottleTimer = null;
		const payload = streamPendingPayload;
		streamPendingPayload = null;
		if (!payload) return;
		void ensureWindow(payload);
	}, STREAM_THROTTLE_MS);
}

const DrawParams = Type.Object({
	elements: Type.String({
		description:
			"JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. See the Excalidraw element format reference in the system prompt for the exact schema.",
	}),
});

const SaveParams = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"Diagram name. Saved to .pi/excalidraw-diagrams/<slug>.excalidraw. Preferred form so list_diagrams / load_diagram can find it.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Explicit output path (relative to cwd). Use only when you need a custom location; otherwise prefer `name`.",
		}),
	),
	checkpoint_id: Type.Optional(
		Type.String({
			description: "Checkpoint id to save. Defaults to the most recent draw_diagram result.",
		}),
	),
});

const LoadParams = Type.Object({
	name: Type.Optional(
		Type.String({
			description: "Diagram name (slug, filename, or basename) under .pi/excalidraw-diagrams/.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "Explicit path to a .excalidraw file (relative to cwd or absolute).",
		}),
	),
});

const MermaidParams = Type.Object({
	definition: Type.String({
		description:
			"Mermaid diagram source (e.g. 'flowchart TD\\n  A[Start] --> B[End]'). Supported: flowchart, sequence, class, ER. Other types render as images.",
	}),
});

/** Generate a short opaque checkpoint id (18 hex chars from a UUID v4). */
function generateCheckpointId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 18);
}

/** Store `elements` under a fresh checkpoint id, mark it as the latest, and
 *  return the new id. Centralises the small bookkeeping every render path does. */
function recordCheckpoint(elements: ExcalidrawElement[]): string {
	const id = generateCheckpointId();
	checkpoints.set(id, elements);
	lastCheckpointId = id;
	return id;
}

/** Validate that exactly one of `name` / `path` was provided. Returns an
 *  errorResult to short-circuit the tool, or null when validation passed. */
function requireOneOfNameOrPath(
	params: { name?: string; path?: string },
	toolName: string,
): ToolResult | null {
	if (!params.name && !params.path) {
		return errorResult(`Provide either \`name\` or \`path\` to ${toolName}.`);
	}
	if (params.name && params.path) {
		return errorResult("Provide only one of `name` or `path`, not both.");
	}
	return null;
}

/** Pick the first stringy field for renderCall labels (name preferred, path
 *  as fallback). */
function nameOrPathLabel(args: Record<string, unknown>): string {
	if (typeof args.name === "string") return args.name;
	if (typeof args.path === "string") return args.path;
	return "";
}

/** Saved-diagram metadata exposed by list_diagrams. */
interface DiagramListing {
	name: string;
	path: string;
	elementCount: number;
	modifiedAt: string;
	sizeBytes: number;
}

/** Tool result `details` payload returned by the registered tools. */
type ToolDetails =
	| { error: string }
	| { checkpointId: string; elementCount: number }
	| { path: string; checkpointId: string; elementCount: number }
	| { path: string; checkpointId: string; elementCount: number; loaded: true }
	| { directory: string; count: number; diagrams: DiagramListing[] }
	| { elementCount: number; mimeType: string; checkpointId: string }
	| undefined;

/** Tool result envelope shared by all registered tools. The content array uses
 *  the same {text}/{image} variants pi-coding-agent expects from tool results. */
type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };
interface ToolResult {
	content: ToolContent[];
	details: ToolDetails;
}

/** Theme slot subset used by our renderCalls. Narrower than pi-tui's full
 *  ThemeColor union, but contravariantly compatible — a Theme.fg that accepts
 *  any ThemeColor satisfies a parameter that only ever passes these two. */
type ToolTitleTheme = {
	fg: (slot: "toolTitle" | "muted", s: string) => string;
	bold: (s: string) => string;
};

/** Build a `theme.fg("toolTitle", theme.bold(name))` Text widget, with optional
 *  muted suffix. Centralises the chrome shared by every tool's renderCall. */
function toolTitle(theme: ToolTitleTheme, name: string, suffix?: string): Text {
	const title = theme.fg("toolTitle", theme.bold(suffix ? `${name} ` : name));
	return new Text(suffix ? title + theme.fg("muted", suffix) : title, 0, 0);
}

/** Build a tool error result with a user-facing message. */
function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

/** Pi extension entry point: registers Excalidraw tools and the /excalidraw command. */
export default function excalidrawExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "draw_diagram",
		label: "draw_diagram",
		description:
			"Render a hand-drawn Excalidraw diagram in a live preview window. Pass a JSON array " +
			"string of elements following the Excalidraw element format. Returns a checkpoint id " +
			"you can pass via {\"type\":\"restoreCheckpoint\",\"id\":\"<id>\"} as the first element of " +
			"the next draw_diagram call to extend the diagram instead of redrawing it.",
		parameters: DrawParams,

		async execute(_toolCallId, params): Promise<ToolResult> {
			if (params.elements.length > MAX_INPUT_BYTES) {
				return errorResult(`Elements input exceeds ${MAX_INPUT_BYTES} byte limit.`);
			}

			let parsed: ExcalidrawElement[];
			try {
				const raw: unknown = JSON.parse(params.elements);
				if (!Array.isArray(raw)) return errorResult("Elements must be a JSON array.");
				parsed = raw as ExcalidrawElement[];
			} catch (e) {
				return errorResult(`Invalid JSON in elements: ${errorMessage(e)}`);
			}

			let resolved: ExcalidrawElement[];
			let viewport: Viewport | null;
			try {
				({ resolved, viewport } = resolveElements(parsed, (id) => checkpoints.get(id)));
			} catch (e) {
				return errorResult(errorMessage(e));
			}

			const checkpointId = recordCheckpoint(resolved);

			try {
				await ensureWindow({ elements: resolved, viewport });
			} catch (e) {
				return errorResult(`Preview window failed: ${errorMessage(e)}`);
			}

			const text =
				`Diagram rendered (${resolved.length} elements). Checkpoint id: "${checkpointId}".\n` +
				`Next step: call screenshot_diagram to visually verify the layout (overlaps, truncated text, off-camera elements, low contrast). ` +
				`If anything looks wrong, fix it with another draw_diagram call prefixed with [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...] and use {"type":"delete","ids":"id1,id2"} to remove broken pieces. ` +
				`Repeat screenshot_diagram → fix until the diagram looks correct, then summarise for the user.\n` +
				`To save the file, call save_diagram with a path.`;

			return {
				content: [{ type: "text", text }],
				details: { checkpointId, elementCount: resolved.length },
			};
		},

		renderCall(args, theme) {
			const count = countElements(typeof args.elements === "string" ? args.elements : "");
			return toolTitle(theme, "draw_diagram", `(${count} elements)`);
		},
	});

	pi.registerTool({
		name: "save_diagram",
		label: "save_diagram",
		description:
			"Save the current preview diagram to a .excalidraw file. By default saves the most recently rendered diagram; pass checkpoint_id to save a specific one.",
		parameters: SaveParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
			const id = params.checkpoint_id ?? lastCheckpointId;
			if (!id) return errorResult("No diagram to save — call draw_diagram first.");

			const elements = checkpoints.get(id);
			if (!elements) return errorResult(`Checkpoint "${id}" not found.`);

			const invalid = requireOneOfNameOrPath(params, "save_diagram");
			if (invalid) return invalid;

			const outPath = resolveDiagramPath(ctx.cwd, { name: params.name, path: params.path });
			await fs.mkdir(path.dirname(outPath), { recursive: true });
			await fs.writeFile(outPath, JSON.stringify(buildExcalidrawFile(elements), null, 2), "utf8");

			return {
				content: [{ type: "text", text: `Saved diagram to ${relativeDisplay(ctx.cwd, outPath)}` }],
				details: { path: outPath, checkpointId: id, elementCount: elements.length },
			};
		},

		renderCall(args, theme) {
			return toolTitle(theme, "save_diagram", nameOrPathLabel(args));
		},
	});

	pi.registerTool({
		name: "list_diagrams",
		label: "list_diagrams",
		description:
			"List previously saved Excalidraw diagrams under .pi/excalidraw-diagrams/. Use before load_diagram to see what is available.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<ToolResult> {
			const dir = path.join(ctx.cwd, DEFAULT_DIAGRAM_DIR);
			let entries: string[];
			try { entries = await fs.readdir(dir); }
			catch {
				return {
					content: [{ type: "text", text: `No saved diagrams (directory ${DEFAULT_DIAGRAM_DIR} not found).` }],
					details: { directory: dir, count: 0, diagrams: [] },
				};
			}

			const diagrams: DiagramListing[] = [];
			for (const entry of entries) {
				if (!entry.toLowerCase().endsWith(".excalidraw")) continue;
				const full = path.join(dir, entry);
				try {
					const [stat, body] = await Promise.all([
						fs.stat(full),
						fs.readFile(full, "utf8"),
					]);
					let count = 0;
					try { count = parseExcalidrawFile(body).length; } catch { /* keep 0 on parse error */ }
					diagrams.push({
						name: entry.replace(/\.excalidraw$/i, ""),
						path: full,
						elementCount: count,
						modifiedAt: stat.mtime.toISOString(),
						sizeBytes: stat.size,
					});
				} catch { /* skip unreadable entries */ }
			}
			diagrams.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

			const lines = diagrams.length
				? diagrams.map((d) => `  - ${d.name} (${d.elementCount} el, ${d.modifiedAt})`).join("\n")
				: "  (none)";
			return {
				content: [{ type: "text", text: `Saved diagrams in ${DEFAULT_DIAGRAM_DIR}:\n${lines}` }],
				details: { directory: dir, count: diagrams.length, diagrams },
			};
		},

		renderCall(_args, theme) {
			return toolTitle(theme, "list_diagrams");
		},
	});

	pi.registerTool({
		name: "load_diagram",
		label: "load_diagram",
		description:
			"Load a previously saved .excalidraw file into the preview, register it as a checkpoint, and return its id so you can extend it via {\"type\":\"restoreCheckpoint\",\"id\":\"<id>\"} in the next draw_diagram call.",
		parameters: LoadParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
			const invalid = requireOneOfNameOrPath(params, "load_diagram");
			if (invalid) return invalid;

			let absPath: string | null;
			if (params.path) {
				absPath = path.isAbsolute(params.path) ? params.path : path.join(ctx.cwd, params.path);
			} else {
				absPath = await findDiagramByName(ctx.cwd, params.name!);
				if (!absPath) return errorResult(`No saved diagram named "${params.name}" in ${DEFAULT_DIAGRAM_DIR}.`);
			}

			let body: string;
			try { body = await fs.readFile(absPath, "utf8"); }
			catch (e) { return errorResult(`Failed to read ${absPath}: ${errorMessage(e)}`); }

			let elements: ExcalidrawElement[];
			try { elements = parseExcalidrawFile(body); }
			catch (e) { return errorResult(`Failed to parse ${absPath}: ${errorMessage(e)}`); }

			const checkpointId = recordCheckpoint(elements);

			try { await ensureWindow({ elements, viewport: null }); }
			catch (e) { return errorResult(`Preview window failed: ${errorMessage(e)}`); }

			const text =
				`Loaded diagram from ${relativeDisplay(ctx.cwd, absPath)} (${elements.length} elements). Checkpoint id: "${checkpointId}".\n` +
				`To extend it, prefix your next draw_diagram call with [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...new elements...].`;
			return {
				content: [{ type: "text", text }],
				details: { path: absPath, checkpointId, elementCount: elements.length, loaded: true },
			};
		},

		renderCall(args, theme) {
			return toolTitle(theme, "load_diagram", nameOrPathLabel(args));
		},
	});

	pi.registerTool({
		name: "screenshot_diagram",
		label: "screenshot_diagram",
		description:
			"Capture a PNG screenshot of the current diagram and return it as an image you can visually inspect. Use after draw_diagram to verify layout, label readability, and alignment, then iterate with another draw_diagram call if needed.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal): Promise<ToolResult> {
			if (!lastCheckpointId) return errorResult("No diagram to screenshot — call draw_diagram first.");
			if (!activeWindow) return errorResult("Preview window is not open. Call draw_diagram first.");

			let result: { base64: string; count: number };
			try {
				result = await callWebviewRpc("screenshot", {}, 15_000, signal);
			} catch (e) {
				return errorResult(`Screenshot failed: ${errorMessage(e)}`);
			}

			if (!result.base64) return errorResult("Diagram is empty — nothing to screenshot.");

			return {
				content: [
					{ type: "text", text: `Screenshot of ${result.count} element(s) attached for visual inspection.` },
					{ type: "image", data: result.base64, mimeType: "image/png" },
				],
				details: {
					elementCount: result.count,
					mimeType: "image/png",
					checkpointId: lastCheckpointId,
				},
			};
		},

		renderCall(_args, theme) {
			return toolTitle(theme, "screenshot_diagram");
		},
	});

	pi.registerTool({
		name: "draw_mermaid_diagram",
		label: "draw_mermaid_diagram",
		description:
			"Render a Mermaid diagram (flowchart, sequence, class, ER, etc.) by converting it to native Excalidraw elements in the preview. Returns a checkpoint id you can extend via {\"type\":\"restoreCheckpoint\",\"id\":\"<id>\"} in a follow-up draw_diagram call.",
		parameters: MermaidParams,

		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			if (!params.definition?.trim()) return errorResult("Mermaid `definition` is required.");

			// Open the preview window first so the webview is ready to receive
			// the conversion RPC. The mermaid module loads lazily inside the
			// webview on first use.
			try {
				if (!windowReadyPromise) windowReadyPromise = openPreviewWindow();
				await windowReadyPromise;
			} catch (e) {
				return errorResult(`Preview window failed: ${errorMessage(e)}`);
			}

			let result: { elements: ExcalidrawElement[]; count: number };
			try {
				result = await callWebviewRpc("mermaid", { definition: params.definition }, 30_000, signal);
			} catch (e) {
				return errorResult(`Mermaid conversion failed: ${errorMessage(e)}`);
			}

			const elements = result.elements ?? [];
			if (!elements.length) return errorResult("Mermaid produced no elements — the diagram may be invalid or unsupported.");

			const checkpointId = recordCheckpoint(elements);

			try { await ensureWindow({ elements, viewport: null }); }
			catch (e) { return errorResult(`Preview window failed: ${errorMessage(e)}`); }

			const text =
				`Mermaid diagram rendered (${elements.length} elements). Checkpoint id: "${checkpointId}".\n` +
				`Next step: call screenshot_diagram to visually verify the layout. ` +
				`If anything looks wrong, fix it with another draw_diagram call prefixed with [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...] and use {"type":"delete","ids":"id1,id2"} to remove broken pieces. ` +
				`Repeat screenshot_diagram → fix until the diagram looks correct, then summarise for the user.\n` +
				`To save it, call save_diagram with a name.`;
			return {
				content: [{ type: "text", text }],
				details: { checkpointId, elementCount: elements.length },
			};
		},

		renderCall(_args, theme) {
			return toolTitle(theme, "draw_mermaid_diagram");
		},
	});

	pi.registerCommand("excalidraw", {
		description: "Draw an Excalidraw diagram with live preview (/excalidraw <what to draw>)",
		handler: async (args, ctx) => {
			const task = args?.trim();
			if (!task) {
				ctx.ui.notify("Usage: /excalidraw <description of the diagram>", "info");
				return;
			}
			cheatSheetActive = true;
			pi.sendUserMessage(DRAW_INSTRUCTION_TEMPLATE.replace("{{task}}", task));
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!cheatSheetActive) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Excalidraw element format reference\n\n${ELEMENT_FORMAT_PROMPT}`,
		};
	});

	// Stream partial diagrams to the preview as the LLM emits them, instead of
	// waiting for the full tool result. Hooks into the assistant message stream.
	pi.on("message_update", async (event) => {
		const me = event.assistantMessageEvent;
		if (!me || typeof me !== "object") return;

		if (me.type === "toolcall_start") {
			const block = me.partial?.content?.[me.contentIndex];
			if (block?.type === "toolCall" && block.name === "draw_diagram") {
				streamBuffers.set(block.id, "");
				// Open the window early so esm.sh + fonts are loading while the
				// model is still streaming the first elements.
				if (!windowReadyPromise) windowReadyPromise = openPreviewWindow();
			}
			return;
		}

		if (me.type === "toolcall_delta") {
			const block = me.partial?.content?.[me.contentIndex];
			if (block?.type !== "toolCall" || !streamBuffers.has(block.id)) return;
			const buffer = (streamBuffers.get(block.id) ?? "") + me.delta;
			streamBuffers.set(block.id, buffer);

			const raw = extractStreamingElements(buffer);
			if (!raw.length) return;
			try {
				const { resolved, viewport } = resolveElements(raw, (id) => checkpoints.get(id));
				scheduleStreamUpdate(resolved, viewport);
			} catch { /* partial restoreCheckpoint id may not exist yet */ }
			return;
		}

		if (me.type === "toolcall_end") {
			streamBuffers.delete(me.toolCall.id);
			// Cancel any pending throttled update — the tool's execute() will fire
			// the canonical final render shortly via ensureWindow().
			if (streamThrottleTimer) {
				clearTimeout(streamThrottleTimer);
				streamThrottleTimer = null;
			}
			streamPendingPayload = null;
		}
	});
}
