/**
 * Unit tests for diagrams.ts — pure helpers extracted from index.ts.
 *
 * Covers:
 *  - slugifyDiagramName: normalization, fallback, length cap
 *  - errorMessage: Error / string / unknown
 *  - countElements: valid / partial / non-array
 *  - buildExcalidrawFile: shape, round-trip with parseExcalidrawFile
 *  - parseExcalidrawFile: invalid JSON, non-object, missing/invalid elements
 *  - resolveDiagramPath: name → slug path; relative path; absolute path
 *  - relativeDisplay: inside cwd vs outside
 *  - findDiagramByName: missing dir, stem match, slug match, .excalidraw suffix
 *
 * Run with:
 *   node --experimental-strip-types --test extensions/pi-k-excalidraw/diagrams.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	buildExcalidrawFile,
	countElements,
	DEFAULT_DIAGRAM_DIR,
	errorMessage,
	findDiagramByName,
	parseExcalidrawFile,
	relativeDisplay,
	resolveDiagramPath,
	slugifyDiagramName,
} from "./diagrams.ts";
import type { ExcalidrawElement } from "./parser.ts";

// ── slugifyDiagramName ───────────────────────────────────────────────────────

describe("slugifyDiagramName", () => {
	it("lowercases and replaces spaces with dashes", () => {
		assert.equal(slugifyDiagramName("My Cool Diagram"), "my-cool-diagram");
	});

	it("collapses runs of non-alphanumerics to a single dash", () => {
		assert.equal(slugifyDiagramName("hello___world!!!plot"), "hello-world-plot");
	});

	it("strips leading and trailing dashes", () => {
		assert.equal(slugifyDiagramName("  --hello--  "), "hello");
	});

	it("preserves digits", () => {
		assert.equal(slugifyDiagramName("v2 release plan"), "v2-release-plan");
	});

	it("falls back to 'diagram' for empty / all-punctuation input", () => {
		assert.equal(slugifyDiagramName(""), "diagram");
		assert.equal(slugifyDiagramName("   "), "diagram");
		assert.equal(slugifyDiagramName("!!!---???"), "diagram");
	});

	it("caps slug length at 64 characters", () => {
		const long = "a".repeat(200);
		const slug = slugifyDiagramName(long);
		assert.ok(slug.length <= 64, `expected <=64, got ${slug.length}`);
		assert.match(slug, /^a+$/);
	});

	it("is idempotent on already-clean slugs", () => {
		const slug = "already-clean-slug";
		assert.equal(slugifyDiagramName(slug), slug);
	});
});

// ── errorMessage ─────────────────────────────────────────────────────────────

describe("errorMessage", () => {
	it("extracts message from an Error", () => {
		assert.equal(errorMessage(new Error("boom")), "boom");
	});

	it("returns string for non-Error values via String()", () => {
		assert.equal(errorMessage("plain string"), "plain string");
		assert.equal(errorMessage(42), "42");
	});

	it("falls back to String() when message is missing", () => {
		assert.equal(errorMessage(null), "null");
		assert.equal(errorMessage(undefined), "undefined");
	});

	it("handles plain objects with a message property", () => {
		assert.equal(errorMessage({ message: "fake" }), "fake");
	});
});

// ── countElements ────────────────────────────────────────────────────────────

describe("countElements", () => {
	it("returns the array length for a valid JSON array", () => {
		assert.equal(countElements("[]"), 0);
		assert.equal(countElements('[{"a":1},{"b":2},{"c":3}]'), 3);
	});

	it("returns ellipsis for partial / invalid JSON", () => {
		assert.equal(countElements(""), "…");
		assert.equal(countElements("[{"), "…");
		assert.equal(countElements("[{not json"), "…");
	});

	it("returns ellipsis for non-array JSON", () => {
		assert.equal(countElements('{"a":1}'), "…");
		assert.equal(countElements('"string"'), "…");
		assert.equal(countElements("42"), "…");
	});
});

// ── buildExcalidrawFile / parseExcalidrawFile ────────────────────────────────

describe("buildExcalidrawFile", () => {
	const elements: ExcalidrawElement[] = [
		{ type: "rectangle", id: "r1", x: 0, y: 0, width: 50, height: 50 },
	];

	it("produces the canonical v2 wrapper shape", () => {
		const f = buildExcalidrawFile(elements);
		assert.equal(f.type, "excalidraw");
		assert.equal(f.version, 2);
		assert.equal(f.source, "https://excalidraw.com");
		assert.deepEqual(f.elements, elements);
		assert.deepEqual(f.appState, { gridSize: null, viewBackgroundColor: "#ffffff" });
		assert.deepEqual(f.files, {});
	});

	it("round-trips through JSON.stringify → parseExcalidrawFile", () => {
		const json = JSON.stringify(buildExcalidrawFile(elements));
		assert.deepEqual(parseExcalidrawFile(json), elements);
	});

	it("preserves an empty element array", () => {
		const f = buildExcalidrawFile([]);
		assert.deepEqual(f.elements, []);
	});
});

describe("parseExcalidrawFile", () => {
	it("returns the elements array for a well-formed file", () => {
		const body = JSON.stringify({ type: "excalidraw", version: 2, elements: [{ type: "rectangle" }] });
		assert.deepEqual(parseExcalidrawFile(body), [{ type: "rectangle" }]);
	});

	it("throws on invalid JSON", () => {
		assert.throws(() => parseExcalidrawFile("{not json"), /Invalid JSON:/);
	});

	it("throws when the body is not a JSON object", () => {
		assert.throws(() => parseExcalidrawFile("null"), /not a JSON object/);
		assert.throws(() => parseExcalidrawFile('"string"'), /not a JSON object/);
		assert.throws(() => parseExcalidrawFile("42"), /not a JSON object/);
	});

	it("throws on a bare array (no `elements` field)", () => {
		// `typeof [] === "object"` so it slips past the object check and hits
		// the missing-elements branch — documents the actual code path.
		assert.throws(() => parseExcalidrawFile("[]"), /Missing or invalid `elements` array/);
	});

	it("throws when `elements` is missing or not an array", () => {
		assert.throws(() => parseExcalidrawFile("{}"), /Missing or invalid `elements` array/);
		assert.throws(
			() => parseExcalidrawFile('{"elements":"oops"}'),
			/Missing or invalid `elements` array/,
		);
		assert.throws(
			() => parseExcalidrawFile('{"elements":{"a":1}}'),
			/Missing or invalid `elements` array/,
		);
	});
});

// ── resolveDiagramPath ───────────────────────────────────────────────────────

describe("resolveDiagramPath", () => {
	const cwd = "/tmp/proj";

	it("uses the slugified name under the default diagram dir", () => {
		const out = resolveDiagramPath(cwd, { name: "My Diagram" });
		assert.equal(out, path.join(cwd, DEFAULT_DIAGRAM_DIR, "my-diagram.excalidraw"));
	});

	it("falls back to 'diagram' for empty name input", () => {
		const out = resolveDiagramPath(cwd, { name: "!!!" });
		assert.equal(out, path.join(cwd, DEFAULT_DIAGRAM_DIR, "diagram.excalidraw"));
	});

	it("joins relative path under cwd", () => {
		const out = resolveDiagramPath(cwd, { path: "out/foo.excalidraw" });
		assert.equal(out, path.join(cwd, "out/foo.excalidraw"));
	});

	it("returns absolute path unchanged", () => {
		const abs = "/var/tmp/foo.excalidraw";
		assert.equal(resolveDiagramPath(cwd, { path: abs }), abs);
	});

	it("path takes precedence over name when both supplied", () => {
		// Caller is expected to validate exclusivity; this just documents behavior.
		const out = resolveDiagramPath(cwd, { name: "ignored", path: "x.excalidraw" });
		assert.equal(out, path.join(cwd, "x.excalidraw"));
	});
});

// ── relativeDisplay ──────────────────────────────────────────────────────────

describe("relativeDisplay", () => {
	it("returns relative path when target lives under cwd", () => {
		assert.equal(relativeDisplay("/a/b", "/a/b/c/d.excalidraw"), path.join("c", "d.excalidraw"));
	});

	it("returns absolute path when target is outside cwd", () => {
		const outside = "/x/y/z.excalidraw";
		assert.equal(relativeDisplay("/a/b", outside), outside);
	});

	it("returns an empty string when target equals cwd (path.relative convention)", () => {
		assert.equal(relativeDisplay("/a/b", "/a/b"), "");
	});
});

// ── findDiagramByName ────────────────────────────────────────────────────────

describe("findDiagramByName", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-excalidraw-test-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	/** Create the diagram dir with a single .excalidraw file and return its absolute path. */
	async function seedDiagram(filename: string): Promise<string> {
		const dir = path.join(tmp, DEFAULT_DIAGRAM_DIR);
		await fs.mkdir(dir, { recursive: true });
		const full = path.join(dir, filename);
		await fs.writeFile(full, "{}");
		return full;
	}

	it("returns null when the diagram dir does not exist", async () => {
		assert.equal(await findDiagramByName(tmp, "missing"), null);
	});

	it("matches an exact stem with .excalidraw suffix added", async () => {
		const full = await seedDiagram("my-diagram.excalidraw");
		assert.equal(await findDiagramByName(tmp, "my-diagram"), full);
	});

	it("matches when caller already includes the .excalidraw suffix", async () => {
		const full = await seedDiagram("thing.excalidraw");
		assert.equal(await findDiagramByName(tmp, "thing.excalidraw"), full);
	});

	it("matches via slugified candidate when stem differs in casing/spaces", async () => {
		const full = await seedDiagram("my-diagram.excalidraw");
		assert.equal(await findDiagramByName(tmp, "My Diagram"), full);
	});

	it("returns null when nothing matches", async () => {
		await seedDiagram("other.excalidraw");
		assert.equal(await findDiagramByName(tmp, "missing"), null);
	});
});
