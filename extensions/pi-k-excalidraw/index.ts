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
	extractStreamingElements,
	resolveElements,
	type ExcalidrawElement,
	type Viewport,
} from "./parser.ts";
import { getWebviewHtml } from "./webview.ts";

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

/** Best-effort error message extraction for arbitrary thrown values. */
function errorMessage(e: unknown): string {
	return (e as Error)?.message ?? String(e);
}

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

/** Handle a message from the webview. Routes `copy-svg` and `copy-png` requests
 *  to the appropriate clipboard writer and acks the webview UI. */
async function handleWebviewMessage(win: GlimpseWindow, data: unknown): Promise<void> {
	if (!data || typeof data !== "object") return;
	const msg = data as { type?: unknown; svg?: unknown; base64?: unknown };

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
	path: Type.String({
		description: "Output file path (relative to cwd). Conventionally ends with .excalidraw.",
	}),
	checkpoint_id: Type.Optional(
		Type.String({
			description: "Checkpoint id to save. Defaults to the most recent draw_diagram result.",
		}),
	),
});

/** Build the Excalidraw v2 file format wrapper around an element array. */
function buildExcalidrawFile(elements: ExcalidrawElement[]): Record<string, unknown> {
	return {
		type: "excalidraw",
		version: 2,
		source: "https://excalidraw.com",
		elements,
		appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
		files: {},
	};
}

/** Tool result `details` payload returned by draw_diagram and save_diagram. */
type ToolDetails =
	| { error: string }
	| { checkpointId: string; elementCount: number }
	| { path: string; checkpointId: string; elementCount: number };

/** Tool result envelope shared by draw_diagram and save_diagram. */
interface ToolResult {
	content: { type: "text"; text: string }[];
	details: ToolDetails;
}

/** Build a tool error result with a user-facing message. */
function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

/** Best-effort element count for the streaming-tool-call status line. Returns
 *  the number for valid array input, or an ellipsis while input is partial. */
function countElements(elementsStr: string): number | string {
	try {
		const v = JSON.parse(elementsStr);
		if (Array.isArray(v)) return v.length;
	} catch { /* partial JSON — fall through */ }
	return "…";
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

			const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
			checkpoints.set(checkpointId, resolved);
			lastCheckpointId = checkpointId;

			try {
				await ensureWindow({ elements: resolved, viewport });
			} catch (e) {
				return errorResult(`Preview window failed: ${errorMessage(e)}`);
			}

			const text =
				`Diagram rendered (${resolved.length} elements). Checkpoint id: "${checkpointId}".\n` +
				`To extend it, prefix your next draw_diagram call with [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...new elements...].\n` +
				`To remove elements, include {"type":"delete","ids":"id1,id2"}.\n` +
				`To save the file, call save_diagram with a path.`;

			return {
				content: [{ type: "text", text }],
				details: { checkpointId, elementCount: resolved.length },
			};
		},

		renderCall(args, theme) {
			const count = countElements(typeof args.elements === "string" ? args.elements : "");
			return new Text(
				theme.fg("toolTitle", theme.bold("draw_diagram ")) + theme.fg("muted", `(${count} elements)`),
				0,
				0,
			);
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

			const outPath = path.isAbsolute(params.path) ? params.path : path.join(ctx.cwd, params.path);
			await fs.mkdir(path.dirname(outPath), { recursive: true });
			await fs.writeFile(outPath, JSON.stringify(buildExcalidrawFile(elements), null, 2), "utf8");

			return {
				content: [{ type: "text", text: `Saved diagram to ${outPath}` }],
				details: { path: outPath, checkpointId: id, elementCount: elements.length },
			};
		},

		renderCall(args, theme) {
			const p = typeof args.path === "string" ? args.path : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("save_diagram ")) + theme.fg("muted", p),
				0,
				0,
			);
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
