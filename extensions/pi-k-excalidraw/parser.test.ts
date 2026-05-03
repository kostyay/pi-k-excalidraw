/**
 * Unit tests for pi-extensions/excalidraw/parser.ts — the streaming JSON
 * parser and pseudo-element resolver used by the Excalidraw preview tool.
 *
 * Coverage:
 * - findJsonStringEnd: escape handling
 * - parsePartialElementArray: strict + recovery paths, partial flag semantics
 * - extractStreamingElements: JSON-string-inside-JSON unescaping
 * - collectDeleteIds: comma splitting, alias `id` field, whitespace
 * - extractViewport: last-cameraUpdate-wins, validity checks
 * - resolveElements: restoreCheckpoint, delete cascade, pseudo-element filtering
 * - End-to-end streaming simulation: chunk-by-chunk arrival
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test pi-extensions/excalidraw/parser.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	collectDeleteIds,
	extractStreamingElements,
	extractViewport,
	findJsonStringEnd,
	parsePartialElementArray,
	PSEUDO_TYPES,
	resolveElements,
	type ExcalidrawElement,
} from "./parser.ts";

// ── Test fixtures ────────────────────────────────────────────────────────────

/** A small but realistic three-element diagram (camera + box + arrow). */
const SAMPLE_ELEMENTS: ExcalidrawElement[] = [
	{ type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 } as ExcalidrawElement,
	{ type: "rectangle", id: "r1", x: 100, y: 100, width: 200, height: 100 },
	{ type: "arrow", id: "a1", x: 300, y: 150, width: 150, height: 0 },
];

/** Build the streaming-tool-call argument JSON the way pi-ai assembles it. */
function buildArgsJson(elements: ExcalidrawElement[]): string {
	return JSON.stringify({ elements: JSON.stringify(elements) });
}

/** Replay the streaming bridge: feed `args` to extractStreamingElements one
 *  character at a time and record the element count after every chunk. */
function streamCounts(args: string, step = 1): number[] {
	const counts: number[] = [];
	for (let i = step; i <= args.length; i += step) {
		counts.push(extractStreamingElements(args.substring(0, i)).length);
	}
	return counts;
}

// ── findJsonStringEnd ────────────────────────────────────────────────────────

describe("findJsonStringEnd", () => {
	it("returns index of first unescaped quote", () => {
		assert.equal(findJsonStringEnd('hello"world'), 5);
	});

	it("skips escaped quotes", () => {
		// Source `\\"` is a literal `\"` in the runtime string. Each `\"` is an escape
		// pair, so the first un-escaped `"` lands at index 20 (`he said \"hi\" then "`).
		assert.equal(findJsonStringEnd('he said \\"hi\\" then "done'), 20);
	});

	it("returns input length when no unescaped quote present", () => {
		assert.equal(findJsonStringEnd("no quotes here"), 14);
		assert.equal(findJsonStringEnd('only \\"escaped\\"'), 16);
	});

	it("treats \\\\ as a literal backslash, not an escape of next char", () => {
		// `\\\\"` in source = backslash + backslash + quote → escape pair, then unescaped quote at index 2
		assert.equal(findJsonStringEnd('\\\\"'), 2);
	});
});

// ── parsePartialElementArray ─────────────────────────────────────────────────

describe("parsePartialElementArray", () => {
	it("parses a complete array via the strict path", () => {
		const result = parsePartialElementArray('[{"type":"x"},{"type":"y"}]');
		assert.equal(result.partial, false);
		assert.equal(result.elements.length, 2);
	});

	it("recovers a valid prefix when the array is truncated mid-element", () => {
		const result = parsePartialElementArray('[{"type":"x"},{"type":"y"},{"type":"z","x":1');
		assert.equal(result.partial, true);
		assert.equal(result.elements.length, 2);
		assert.equal(result.elements[0].type, "x");
		assert.equal(result.elements[1].type, "y");
	});

	it("refuses to recover when the closing brace belongs to a nested object", () => {
		// The last `}` closes `{a:1}`, leaving the outer element's `{` unclosed.
		// Appending `]` produces invalid JSON, so we report 0 elements + partial.
		const result = parsePartialElementArray('[{"type":"box","nested":{"a":1}');
		assert.equal(result.partial, true);
		assert.equal(result.elements.length, 0);
	});

	it("returns empty + partial for non-array prefixes", () => {
		assert.deepEqual(parsePartialElementArray("not an array"), { elements: [], partial: true });
		assert.deepEqual(parsePartialElementArray("{ object: true }"), { elements: [], partial: true });
	});

	it("returns empty + partial for an open bracket with no closed elements yet", () => {
		assert.deepEqual(parsePartialElementArray('[{"type":"x"'), { elements: [], partial: true });
	});

	it("handles whitespace around the array", () => {
		const result = parsePartialElementArray('  \n[{"type":"x"}]\n  ');
		assert.equal(result.partial, false);
		assert.equal(result.elements.length, 1);
	});
});

// ── extractStreamingElements ─────────────────────────────────────────────────

describe("extractStreamingElements", () => {
	it("returns all elements once the full args JSON has streamed in", () => {
		const got = extractStreamingElements(buildArgsJson(SAMPLE_ELEMENTS));
		assert.equal(got.length, SAMPLE_ELEMENTS.length);
	});

	it("returns [] before the elements key has even been emitted", () => {
		assert.deepEqual(extractStreamingElements(""), []);
		assert.deepEqual(extractStreamingElements('{"'), []);
		assert.deepEqual(extractStreamingElements('{"el'), []);
	});

	it("returns [] when only the elements key prefix exists", () => {
		assert.deepEqual(extractStreamingElements('{"elements":"'), []);
		assert.deepEqual(extractStreamingElements('{"elements":"['), []);
	});

	it("tolerates a dangling backslash at the end of the buffer", () => {
		// Mid-escape: trailing `\` would corrupt JSON.parse, so we drop it.
		assert.doesNotThrow(() => extractStreamingElements('{"elements":"[{\\"id\\":\\'));
	});

	it("yields a non-decreasing element count as the stream grows", () => {
		const args = buildArgsJson(SAMPLE_ELEMENTS);
		const counts = streamCounts(args, 4);
		for (let i = 1; i < counts.length; i++) {
			assert.ok(
				counts[i] >= counts[i - 1],
				`count decreased at step ${i}: ${counts[i - 1]} → ${counts[i]}`,
			);
		}
		assert.equal(counts[counts.length - 1], SAMPLE_ELEMENTS.length);
	});

	it("does not throw on any prefix of a valid stream", () => {
		const args = buildArgsJson(SAMPLE_ELEMENTS);
		for (let i = 0; i <= args.length; i++) {
			assert.doesNotThrow(() => extractStreamingElements(args.substring(0, i)));
		}
	});

	it("survives malformed input without crashing", () => {
		assert.deepEqual(extractStreamingElements("not even json"), []);
		assert.deepEqual(extractStreamingElements("{[broken"), []);
	});

	it("recovers all complete elements before a mid-stream truncation", () => {
		// Two complete elements, then a third still being filled in.
		const partial = '{"elements":"[{\\"type\\":\\"a\\"},{\\"type\\":\\"b\\"},{\\"type\\":\\"c\\",\\"x';
		const got = extractStreamingElements(partial);
		assert.deepEqual(got.map((e) => e.type), ["a", "b"]);
	});

	it("returns [] when truncation lands inside a nested object (cannot recover)", () => {
		// `{nested:{x:1}` — the outer brace of element 2 is unclosed, so the
		// recovery path's `]` produces invalid JSON and we fall through to [].
		const partial = '{"elements":"[{\\"type\\":\\"a\\"},{\\"type\\":\\"b\\",\\"nested\\":{\\"x\\":1}';
		assert.deepEqual(extractStreamingElements(partial), []);
	});
});

// ── collectDeleteIds ─────────────────────────────────────────────────────────

describe("collectDeleteIds", () => {
	it("returns empty set when no delete elements", () => {
		assert.equal(collectDeleteIds(SAMPLE_ELEMENTS).size, 0);
	});

	it("collects ids from the `ids` field (comma-separated)", () => {
		const set = collectDeleteIds([{ type: "delete", ids: "a,b,c" }]);
		assert.deepEqual([...set].sort(), ["a", "b", "c"]);
	});

	it("falls back to `id` when `ids` is missing", () => {
		const set = collectDeleteIds([{ type: "delete", id: "lone" }]);
		assert.deepEqual([...set], ["lone"]);
	});

	it("trims whitespace and skips empty segments", () => {
		const set = collectDeleteIds([{ type: "delete", ids: " a , , b ,c," }]);
		assert.deepEqual([...set].sort(), ["a", "b", "c"]);
	});

	it("merges ids across multiple delete elements", () => {
		const set = collectDeleteIds([
			{ type: "delete", ids: "a,b" },
			{ type: "delete", ids: "b,c" },
		]);
		assert.deepEqual([...set].sort(), ["a", "b", "c"]);
	});

	it("ignores non-delete elements", () => {
		const set = collectDeleteIds([
			{ type: "rectangle", id: "r1" },
			{ type: "delete", ids: "x" },
			{ type: "arrow", id: "a1" },
		]);
		assert.deepEqual([...set], ["x"]);
	});
});

// ── extractViewport ──────────────────────────────────────────────────────────

describe("extractViewport", () => {
	it("returns null when no cameraUpdate is present", () => {
		assert.equal(extractViewport([{ type: "rectangle", id: "r1" }]), null);
	});

	it("picks the LAST cameraUpdate when multiple are present", () => {
		const result = extractViewport([
			{ type: "cameraUpdate", x: 0, y: 0, width: 100, height: 100 } as ExcalidrawElement,
			{ type: "rectangle", id: "r1" },
			{ type: "cameraUpdate", x: 50, y: 60, width: 200, height: 150 } as ExcalidrawElement,
		]);
		assert.deepEqual(result, { x: 50, y: 60, width: 200, height: 150 });
	});

	it("returns null when the cameraUpdate has missing dimensions", () => {
		assert.equal(extractViewport([{ type: "cameraUpdate" } as ExcalidrawElement]), null);
		assert.equal(
			extractViewport([{ type: "cameraUpdate", x: 0, y: 0 } as ExcalidrawElement]),
			null,
		);
	});

	it("returns null when x or y is not a number", () => {
		const bogus = { type: "cameraUpdate", x: "0", y: 0, width: 800, height: 600 };
		assert.equal(extractViewport([bogus as unknown as ExcalidrawElement]), null);
	});
});

// ── resolveElements ──────────────────────────────────────────────────────────

describe("resolveElements", () => {
	const noCheckpoint = (): undefined => undefined;

	it("strips pseudo-elements from the resolved output", () => {
		const result = resolveElements(SAMPLE_ELEMENTS, noCheckpoint);
		assert.equal(result.resolved.length, 2); // camera dropped, rect + arrow kept
		for (const el of result.resolved) {
			assert.ok(!PSEUDO_TYPES.has(el.type), `pseudo type leaked: ${el.type}`);
		}
	});

	it("captures the viewport from the cameraUpdate", () => {
		const result = resolveElements(SAMPLE_ELEMENTS, noCheckpoint);
		assert.deepEqual(result.viewport, { x: 0, y: 0, width: 800, height: 600 });
	});

	it("applies a restoreCheckpoint and appends new elements on top", () => {
		const stored: ExcalidrawElement[] = [
			{ type: "rectangle", id: "old", x: 0, y: 0, width: 50, height: 50 },
		];
		const result = resolveElements(
			[
				{ type: "restoreCheckpoint", id: "abc123" } as ExcalidrawElement,
				{ type: "ellipse", id: "new", x: 100, y: 100, width: 60, height: 60 },
			],
			(id) => (id === "abc123" ? stored : undefined),
		);
		assert.equal(result.resolved.length, 2);
		assert.equal(result.resolved[0].id, "old");
		assert.equal(result.resolved[1].id, "new");
	});

	it("removes elements named in delete pseudo-elements from the restored base", () => {
		const stored: ExcalidrawElement[] = [
			{ type: "rectangle", id: "keep", x: 0, y: 0, width: 50, height: 50 },
			{ type: "rectangle", id: "drop", x: 0, y: 0, width: 50, height: 50 },
		];
		const result = resolveElements(
			[
				{ type: "restoreCheckpoint", id: "cp" } as ExcalidrawElement,
				{ type: "delete", ids: "drop" } as ExcalidrawElement,
			],
			() => stored,
		);
		assert.equal(result.resolved.length, 1);
		assert.equal(result.resolved[0].id, "keep");
	});

	it("removes elements whose containerId is in the delete set (label cascades)", () => {
		const stored: ExcalidrawElement[] = [
			{ type: "rectangle", id: "box", x: 0, y: 0, width: 50, height: 50 },
			{ type: "text", id: "boxLabel", containerId: "box" } as ExcalidrawElement,
		];
		const result = resolveElements(
			[
				{ type: "restoreCheckpoint", id: "cp" } as ExcalidrawElement,
				{ type: "delete", ids: "box" } as ExcalidrawElement,
			],
			() => stored,
		);
		assert.equal(result.resolved.length, 0);
	});

	it("throws when restoreCheckpoint references an unknown id", () => {
		assert.throws(
			() =>
				resolveElements(
					[{ type: "restoreCheckpoint", id: "nope" } as ExcalidrawElement],
					() => undefined,
				),
			/Checkpoint "nope" not found/,
		);
	});

	it("returns viewport=null when no cameraUpdate is emitted", () => {
		const result = resolveElements(
			[{ type: "rectangle", id: "r1", x: 0, y: 0, width: 50, height: 50 }],
			noCheckpoint,
		);
		assert.equal(result.viewport, null);
	});
});

// ── End-to-end streaming simulation ──────────────────────────────────────────

describe("streaming end-to-end", () => {
	const elements: ExcalidrawElement[] = [
		{ type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 } as ExcalidrawElement,
		{ type: "rectangle", id: "r1", x: 100, y: 100, width: 200, height: 80 },
		{ type: "rectangle", id: "r2", x: 400, y: 100, width: 200, height: 80 },
		{ type: "arrow", id: "a1", x: 300, y: 140, width: 100, height: 0 },
		{ type: "ellipse", id: "e1", x: 500, y: 300, width: 80, height: 80 },
	];
	const args = buildArgsJson(elements);

	it("converges to the full element count by stream end", () => {
		assert.equal(extractStreamingElements(args).length, elements.length);
	});

	it("never observes a count higher than the final count at any prefix", () => {
		for (let i = 0; i < args.length; i++) {
			const count = extractStreamingElements(args.substring(0, i)).length;
			assert.ok(
				count <= elements.length,
				`prefix ${i}: count=${count} exceeds final ${elements.length}`,
			);
		}
	});

	it("produces resolvable output (resolveElements never throws on a stream prefix)", () => {
		for (let i = 0; i < args.length; i += 8) {
			const partial = extractStreamingElements(args.substring(0, i));
			assert.doesNotThrow(() => resolveElements(partial, () => undefined));
		}
	});

	it("preserves cameraUpdate across the whole stream once emitted", () => {
		const prefix = '{"elements":"[{\\"type\\":\\"cameraUpdate\\",\\"x\\":0,\\"y\\":0,\\"width\\":800,\\"height\\":600}';
		const elementsAtPrefix = extractStreamingElements(prefix);
		// The single cameraUpdate is the only complete element, but it's a pseudo —
		// it's preserved in raw, then stripped by resolveElements (and viewport extracted).
		assert.equal(elementsAtPrefix.length, 1);
		assert.equal(elementsAtPrefix[0].type, "cameraUpdate");
		const { resolved, viewport } = resolveElements(elementsAtPrefix, () => undefined);
		assert.equal(resolved.length, 0);
		assert.deepEqual(viewport, { x: 0, y: 0, width: 800, height: 600 });
	});
});

// ── Property-style invariants ────────────────────────────────────────────────

describe("invariants on every prefix of a valid stream", () => {
	const elements: ExcalidrawElement[] = [
		{ type: "rectangle", id: "r1", x: 100, y: 100, width: 200, height: 80, containerId: undefined },
		{ type: "rectangle", id: "r2", x: 400, y: 100, width: 200, height: 80 },
		{ type: "arrow", id: "a1", x: 300, y: 140, width: 100, height: 0 },
	];
	const args = buildArgsJson(elements);

	it("never throws", () => {
		for (let i = 0; i <= args.length; i++) {
			assert.doesNotThrow(() => extractStreamingElements(args.substring(0, i)));
		}
	});

	it("returns elements that all have a string `type`", () => {
		for (let i = 0; i <= args.length; i++) {
			const got = extractStreamingElements(args.substring(0, i));
			for (const el of got) assert.equal(typeof el.type, "string");
		}
	});

	it("returns either [] or a strictly-smaller-than-final array on incomplete prefixes", () => {
		// Stop at one char before the full args length.
		for (let i = 0; i < args.length - 1; i++) {
			const got = extractStreamingElements(args.substring(0, i));
			assert.ok(got.length <= elements.length);
		}
	});
});
