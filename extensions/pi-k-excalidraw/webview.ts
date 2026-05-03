/**
 * Webview HTML for the Excalidraw preview window.
 *
 * Loads React + @excalidraw/excalidraw from esm.sh inside the glimpse webview
 * and exposes window.__piRender({ elements, viewport }) so the extension can
 * push new diagrams via win.send(...).
 *
 * CSS, font URLs, and chrome-hiding rules mirror what excalidraw-mcp ships
 * (https://github.com/excalidraw/excalidraw-mcp/blob/main/src/global.css).
 */

const STYLES = `
  @import url("https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/index.css");

  @font-face {
    font-family: "Excalifont";
    src: url("https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2") format("woff2");
    font-display: swap;
  }
  @font-face {
    font-family: "Assistant";
    src: url("https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Assistant/Assistant-Regular.woff2") format("woff2");
    font-weight: 400; font-display: swap;
  }
  @font-face {
    font-family: "Assistant";
    src: url("https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Assistant/Assistant-Bold.woff2") format("woff2");
    font-weight: 700; font-display: swap;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root {
    height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #ffffff;
  }

  .excalidraw-container { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
  .excalidraw-container .excalidraw .SVGLayer { display: none !important; }

  /* Hide editing chrome by default — keep zoom/pan controls so users can navigate.
     The body.edit-mode class overrides these rules to reveal the native Excalidraw
     toolbar, menus, and undo/redo so the user can directly customise the diagram. */
  body:not(.edit-mode) .excalidraw-container .excalidraw .App-menu,
  body:not(.edit-mode) .excalidraw-container .excalidraw .App-toolbar,
  body:not(.edit-mode) .excalidraw-container .excalidraw .App-menu_top,
  body:not(.edit-mode) .excalidraw-container .excalidraw .undo-redo-buttons,
  body:not(.edit-mode) .excalidraw-container .excalidraw .HelpButton,
  body:not(.edit-mode) .excalidraw-container .excalidraw .UserList,
  body:not(.edit-mode) .excalidraw-container .excalidraw .main-menu-trigger,
  body:not(.edit-mode) .excalidraw-container .excalidraw .welcome-screen-center,
  body:not(.edit-mode) .excalidraw-container .excalidraw .welcome-screen-menu-hintContainer,
  body:not(.edit-mode) .excalidraw-container .excalidraw .layer-ui__wrapper__footer-right,
  body:not(.edit-mode) .excalidraw-container .excalidraw .layer-ui__wrapper__footer-center { display: none !important; }
  body:not(.edit-mode) .excalidraw-container .excalidraw .App-menu_top__left { visibility: hidden !important; }

  /* Hide the native zoom footer — we render our own #zoom-controls widget. */
  .excalidraw-container .excalidraw .layer-ui__wrapper__footer-left { display: none !important; }

  /* Hide the native help icon even in edit mode — it would overlap our chrome. */
  body.edit-mode .excalidraw-container .excalidraw .help-icon { display: none !important; }

  /* Hide the library sidebar trigger in all modes — we don't surface user libraries. */
  .excalidraw-container .excalidraw .sidebar-trigger { display: none !important; }

  #loading {
    position: fixed; inset: 0; z-index: 30;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: #ffffff;
    color: #555; font-size: 14px;
    transition: opacity 0.25s ease-out;
  }
  #loading.hidden { opacity: 0; pointer-events: none; }
  #loading .spinner {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2.5px solid rgba(0, 0, 0, 0.08);
    border-top-color: #4a9eed;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  #status { position: fixed; bottom: 8px; right: 12px; font-size: 11px; color: #aaa; pointer-events: none; z-index: 10; }

  .pi-control {
    position: fixed; top: 12px; z-index: 20;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; font: 500 12px system-ui, -apple-system, sans-serif;
    color: #1a1a1a; background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    cursor: pointer; user-select: none;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .pi-control:hover { background: rgba(255, 255, 255, 1); border-color: rgba(0, 0, 0, 0.2); }
  .pi-control:active { background: rgba(0, 0, 0, 0.04); }
  .pi-control svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* Edit-mode toggle reveals Excalidraw's native toolbar so the user can
     customise the diagram with the in-canvas tools. */
  #edit-toggle { right: 12px; }
  #edit-toggle .icon-edit, #edit-toggle .icon-done { display: none; }
  body:not(.edit-mode) #edit-toggle .icon-edit { display: block; }
  body.edit-mode #edit-toggle .icon-done { display: block; }
  body.edit-mode #edit-toggle {
    color: #ffffff; background: #4a9eed; border-color: #2563eb;
  }
  body.edit-mode #edit-toggle:hover { background: #2563eb; }

  /* Bottom-left zoom widget: − / 100% / + in a single rounded pill. */
  #zoom-controls {
    position: fixed; bottom: 12px; left: 12px; z-index: 20;
    display: inline-flex; align-items: stretch; overflow: hidden;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    font: 500 12px system-ui, -apple-system, sans-serif; color: #1a1a1a;
    user-select: none;
  }
  #zoom-controls button {
    background: transparent; border: 0; color: inherit; font: inherit;
    padding: 6px 10px; min-width: 32px; cursor: pointer;
    transition: background 0.15s;
  }
  #zoom-controls button:hover { background: rgba(0, 0, 0, 0.06); }
  #zoom-controls button:active { background: rgba(0, 0, 0, 0.1); }
  #zoom-controls #zoom-level { min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }

  /* Top-center pan hint. Muted by default, fades out after first interaction. */
  #canvas-hint {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 10; pointer-events: none;
    font: 12px system-ui, -apple-system, sans-serif; color: #888;
    white-space: nowrap;
    transition: opacity 0.4s ease;
  }
  #canvas-hint.hidden { opacity: 0; }
  #canvas-hint kbd {
    display: inline-block; padding: 1px 6px; margin: 0 2px;
    font: inherit; color: inherit;
    background: rgba(0, 0, 0, 0.04);
    border: 1px solid rgba(0, 0, 0, 0.18); border-bottom-width: 2px;
    border-radius: 4px;
  }
`;

/**
 * Returns a complete HTML document that mounts a read-only Excalidraw canvas
 * and waits for diagram payloads via window.__piRender.
 */
export function getWebviewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>Excalidraw Preview</title>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19.0.0",
      "react-dom": "https://esm.sh/react-dom@19.0.0?deps=react@19.0.0",
      "react-dom/client": "https://esm.sh/react-dom@19.0.0/client?deps=react@19.0.0",
      "react/jsx-runtime": "https://esm.sh/react@19.0.0/jsx-runtime",
      "@excalidraw/excalidraw": "https://esm.sh/@excalidraw/excalidraw@0.18.0?deps=react@19.0.0,react-dom@19.0.0"
    }
  }
  </script>
  <style>${STYLES}</style>
</head>
<body>
  <div id="root"></div>
  <div id="loading">
    <div class="spinner"></div>
    <div id="loading-text">Loading Excalidraw…</div>
  </div>
  <button id="edit-toggle" class="pi-control" type="button" title="Toggle edit mode — customize the diagram with the Excalidraw toolbar" hidden>
    <svg class="icon-edit" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 1.5l3 3-9 9H2.5v-3z"/><path d="M9.5 3.5l3 3"/></svg>
    <svg class="icon-done" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>
    <span class="label">Edit</span>
  </button>
  <div id="zoom-controls" hidden>
    <button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">−</button>
    <button id="zoom-level" type="button" title="Reset zoom to 100%" aria-label="Reset zoom">100%</button>
    <button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
  </div>
  <div id="canvas-hint" hidden>
    To move canvas, hold <kbd>Scroll wheel</kbd> or <kbd>Space</kbd> while dragging
  </div>
  <div id="status"></div>
  <script>
    // Buffer payloads that arrive BEFORE the React module finishes loading.
    // WKWebView fires "ready" on DOM ready, which is well before <script type="module">
    // execution completes. The module replaces this stub once it mounts.
    window.__piPending = [];
    window.__piRender = (payload) => { window.__piPending.push(payload); };
  </script>
  <script type="module">
    import React, { useState, useEffect, useRef } from "react";
    import { createRoot } from "react-dom/client";
    import { Excalidraw, convertToExcalidrawElements, restoreElements, exportToBlob, FONT_FAMILY } from "@excalidraw/excalidraw";

    const PSEUDO = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

    // Lazy-load mermaid only when draw_mermaid_diagram is actually used. The
    // mermaid bundle is ~1MB, so we don't want to pay for it on every preview.
    let mermaidPromise = null;
    function loadMermaid() {
      if (!mermaidPromise) {
        mermaidPromise = import("https://esm.sh/@excalidraw/mermaid-to-excalidraw@2.2.2");
      }
      return mermaidPromise;
    }

    /** Convert raw shorthand elements (with label sugar) into Excalidraw format.
     *  Per the Excalidraw skeleton-API docs, callers that feed elements through
     *  updateScene MUST run them through restoreElements first — otherwise
     *  arrows are missing the internal fields the linear-element editor needs,
     *  so dragging midpoints to bend them produces broken geometry. */
    function convertRaw(els) {
      const real = els.filter((el) => !PSEUDO.has(el.type));
      const withDefaults = real.map((el) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el,
      );
      const converted = convertToExcalidrawElements(withDefaults, { regenerateIds: false }).map((el) =>
        el.type === "text" ? { ...el, fontFamily: FONT_FAMILY.Excalifont ?? 1 } : el,
      );
      return restoreElements(converted, null, { repairBindings: true, refreshDimensions: false });
    }

    /** Eagerly load Excalidraw's hand-drawn fonts. Without this, the canvas
     *  paints with a serif fallback because the woff2 hasn't fetched yet. */
    async function ensureFonts() {
      if (!document.fonts?.load) return;
      await Promise.allSettled([
        document.fonts.load('16px "Excalifont"'),
        document.fonts.load('20px "Excalifont"'),
        document.fonts.load('16px "Assistant"'),
        document.fonts.load('700 16px "Assistant"'),
      ]);
    }

    /** Snapshot the live scene + appState + files so all exporters use the same input. */
    function sceneSnapshot(api) {
      const elements = api.getSceneElements().filter((el) => !el.isDeleted);
      const appState = api.getAppState();
      return {
        elements,
        appState: { ...appState, exportBackground: true, viewBackgroundColor: "#ffffff" },
        files: api.getFiles?.() ?? {},
      };
    }

    /** Render the current scene to a PNG blob, return base64 + element count. */
    async function sceneToPngBase64(api) {
      const snap = sceneSnapshot(api);
      if (!snap.elements.length) return { base64: "", count: 0 };
      const blob = await exportToBlob({ ...snap, mimeType: "image/png" });
      const buffer = await blob.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { base64: btoa(binary), count: snap.elements.length };
    }

    /** Set zoom while keeping the viewport center fixed. Excalidraw applies
     *  zoom around screen origin by default, so we adjust scrollX/scrollY to
     *  compensate. Clamps to a sane range so the canvas stays usable. */
    const ZOOM_STEP = 1.1;
    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 30;
    function setZoom(api, nextZoom) {
      const z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
      const { zoom, scrollX, scrollY } = api.getAppState();
      const z1 = zoom.value;
      if (z1 === z2) return;
      const w = window.innerWidth, h = window.innerHeight;
      api.updateScene({
        appState: {
          zoom: { value: z2 },
          scrollX: scrollX + (w / 2) * (1 / z2 - 1 / z1),
          scrollY: scrollY + (h / 2) * (1 / z2 - 1 / z1),
        },
      });
    }

    /** Reveal the top-center pan hint, then auto-fade after a few seconds.
     *  Also dismisses on first canvas interaction (wheel / mousedown / keydown). */
    function wireCanvasHint() {
      const hint = document.getElementById("canvas-hint");
      if (!hint) return;
      hint.hidden = false;
      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        hint.classList.add("hidden");
      };
      const fadeTimer = setTimeout(dismiss, 6000);
      const onInteract = () => { clearTimeout(fadeTimer); dismiss(); };
      const opts = { once: true, passive: true };
      window.addEventListener("wheel", onInteract, opts);
      window.addEventListener("mousedown", onInteract, opts);
      window.addEventListener("keydown", onInteract, opts);
    }

    /** Wire the bottom-left zoom widget. The percent display is refreshed on
     *  every animation frame so wheel/pinch gestures stay in sync. */
    function wireZoomControls(api) {
      const panel = document.getElementById("zoom-controls");
      const out = document.getElementById("zoom-out");
      const reset = document.getElementById("zoom-level");
      const inn = document.getElementById("zoom-in");
      if (!panel || !out || !reset || !inn) return;
      panel.hidden = false;

      out.onclick = () => setZoom(api, api.getAppState().zoom.value / ZOOM_STEP);
      inn.onclick = () => setZoom(api, api.getAppState().zoom.value * ZOOM_STEP);
      reset.onclick = () => setZoom(api, 1);

      let lastShown = -1;
      const tick = () => {
        const z = api.getAppState().zoom.value;
        if (z !== lastShown) {
          reset.textContent = Math.round(z * 100) + "%";
          lastShown = z;
        }
        requestAnimationFrame(tick);
      };
      tick();
    }

    /** Send an RPC success/failure reply over the glimpse reverse channel. */
    function rpcOk(id, data) { window.glimpse.send({ type: "rpc-result", id, ok: true, data }); }
    function rpcErr(id, error) { window.glimpse.send({ type: "rpc-result", id, ok: false, error }); }

    /** Wire the Node→webview RPC channel. The Node side calls
     *  window.__piRpcRequest({method, id, args}) via win.send; we dispatch on
     *  method, run the handler, and ship the result back through glimpse.send. */
    function wireRpc(api) {
      const handlers = {
        screenshot: async () => sceneToPngBase64(api),
        mermaid: async (args) => {
          const definition = args?.definition;
          if (typeof definition !== "string" || !definition.trim()) {
            throw new Error("Mermaid definition must be a non-empty string.");
          }
          const mod = await loadMermaid();
          const { elements, files } = await mod.parseMermaidToExcalidraw(definition);
          // Skeleton elements ready for convertToExcalidrawElements; ship them
          // back to Node so they can flow through the standard checkpoint +
          // render pipeline like any other draw_diagram payload.
          return { elements, files: files ?? {}, count: elements.length };
        },
      };
      window.__piRpcRequest = async (req) => {
        if (!req || typeof req.id !== "string" || typeof req.method !== "string") return;
        const handler = handlers[req.method];
        if (!handler) { rpcErr(req.id, "Unknown RPC method: " + req.method); return; }
        try { rpcOk(req.id, await handler(req.args ?? {})); }
        catch (e) { rpcErr(req.id, e?.message ?? String(e)); }
      };
    }

    /** Compute scrollX/scrollY/zoom that center the cameraUpdate viewport in the canvas. */
    function viewportAppState(vp) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const zoom = Math.min(w / vp.width, h / vp.height);
      return {
        scrollX: -vp.x + (w / zoom - vp.width) / 2,
        scrollY: -vp.y + (h / zoom - vp.height) / 2,
        zoom: { value: zoom },
      };
    }

    /** Wire the Edit-mode toggle button. Clicking flips React state, which
     *  re-renders Excalidraw with viewModeEnabled/zenModeEnabled inverted so
     *  the native toolbar + menus appear, and toggles the body.edit-mode class
     *  so our CSS reveals the chrome that's normally hidden. */
    function wireEditToggle(setEditMode) {
      const btn = document.getElementById("edit-toggle");
      if (!btn) return;
      btn.hidden = false;
      const label = btn.querySelector(".label");
      btn.onclick = () => setEditMode((prev) => {
        const next = !prev;
        document.body.classList.toggle("edit-mode", next);
        if (label) label.textContent = next ? "Done" : "Edit";
        btn.title = next
          ? "Exit edit mode — return to view-only preview"
          : "Toggle edit mode — customize the diagram with the Excalidraw toolbar";
        return next;
      });
    }

    function App() {
      const [api, setApi] = useState(null);
      const [fontsReady, setFontsReady] = useState(false);
      const [editMode, setEditMode] = useState(false);
      const status = useRef(document.getElementById("status"));
      const pending = useRef(null);

      const applyPayload = (payload, excApi) => {
        const elements = convertRaw(Array.isArray(payload?.elements) ? payload.elements : []);
        excApi.updateScene({ elements });
        // Honor cameraUpdate viewport when present (drives the streaming pan/zoom
        // animation), otherwise fit the whole scene so nothing falls off screen.
        const vp = payload?.viewport ?? null;
        if (vp && vp.width > 0 && vp.height > 0) {
          excApi.updateScene({ appState: viewportAppState(vp) });
        } else if (elements.length) {
          excApi.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.9 });
        }
        status.current.textContent = elements.length + " elements";
        document.getElementById("loading")?.classList.add("hidden");
      };

      useEffect(() => { ensureFonts().then(() => setFontsReady(true)); }, []);

      // Surface progress in the loading overlay so the window doesn't look frozen
      // while we wait for the first draw_diagram tool call to arrive.
      useEffect(() => {
        const text = document.getElementById("loading-text");
        if (!text) return;
        if (!fontsReady) text.textContent = "Loading Excalidraw…";
        else if (!api) text.textContent = "Initializing canvas…";
        else text.textContent = "Waiting for diagram…";
      }, [api, fontsReady]);

      useEffect(() => {
        const tryApply = (payload) => {
          try { applyPayload(payload, api); }
          catch (e) { status.current.textContent = "Render error: " + (e?.message ?? String(e)); }
        };

        // Drain any payloads that arrived before this module finished loading.
        const queued = window.__piPending ?? [];
        window.__piPending = null;
        const lastQueued = queued.length ? queued[queued.length - 1] : null;
        if (lastQueued) pending.current = lastQueued;

        window.__piRender = (payload) => {
          if (!api || !fontsReady) { pending.current = payload; return; }
          tryApply(payload);
        };
        if (api && fontsReady) {
          if (pending.current) { tryApply(pending.current); pending.current = null; }
          wireZoomControls(api);
          wireCanvasHint();
          wireRpc(api);
          wireEditToggle(setEditMode);
        }
      }, [api, fontsReady]);

      return React.createElement(
        "div",
        { className: "excalidraw-container" },
        React.createElement(Excalidraw, {
          initialData: { elements: [], appState: { viewBackgroundColor: "#ffffff" } },
          excalidrawAPI: setApi,
          // When edit mode is on we drop view + zen modes so the user gets the
          // full Excalidraw toolbar (shape tools, eraser, text, etc.) and can
          // tweak the diagram. The exit-side controls (export, save, load) stay
          // hidden via uiOptions — we own those flows from the agent side.
          viewModeEnabled: !editMode,
          zenModeEnabled: !editMode,
          uiOptions: { canvasActions: { saveToActiveFile: false, loadScene: false, export: false } },
        }),
      );
    }

    const root = createRoot(document.getElementById("root"));
    root.render(React.createElement(App));
  </script>
</body>
</html>`;
}
