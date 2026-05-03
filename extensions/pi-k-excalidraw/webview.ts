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
    transition: background 0.2s ease;
  }
  body.dark { background: #000000; }

  .excalidraw-container { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
  .excalidraw-container .excalidraw .SVGLayer { display: none !important; }

  /* Hide editing chrome — keep zoom/pan controls (footer-left) so users can navigate. */
  .excalidraw-container .excalidraw .App-menu,
  .excalidraw-container .excalidraw .App-toolbar,
  .excalidraw-container .excalidraw .App-menu_top,
  .excalidraw-container .excalidraw .undo-redo-buttons,
  .excalidraw-container .excalidraw .HelpButton,
  .excalidraw-container .excalidraw .UserList,
  .excalidraw-container .excalidraw .main-menu-trigger,
  .excalidraw-container .excalidraw .welcome-screen-center,
  .excalidraw-container .excalidraw .welcome-screen-menu-hintContainer,
  .excalidraw-container .excalidraw .layer-ui__wrapper__footer-right,
  .excalidraw-container .excalidraw .layer-ui__wrapper__footer-center { display: none !important; }
  .excalidraw-container .excalidraw .App-menu_top__left { visibility: hidden !important; }

  /* Lift the zoom-control footer above our Copy SVG button + status text. */
  .excalidraw-container .excalidraw .layer-ui__wrapper__footer-left { z-index: 15 !important; }

  /* Excalidraw's dark theme normally applies an invert+hue-rotate filter to the
     canvas which clamps the darkest renderable color to ~#121212. We disable it
     so viewBackgroundColor wins and dark mode can actually be true black. */
  .excalidraw-container .excalidraw.theme--dark canvas { filter: none !important; }

  #loading {
    position: fixed; inset: 0; z-index: 30;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: #ffffff;
    color: #555; font-size: 14px;
    transition: opacity 0.25s ease-out, background 0.2s ease, color 0.2s ease;
  }
  body.dark #loading { background: #000000; color: #aaa; }
  #loading.hidden { opacity: 0; pointer-events: none; }
  #loading .spinner {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2.5px solid rgba(0, 0, 0, 0.08);
    border-top-color: #4a9eed;
    animation: spin 0.8s linear infinite;
  }
  body.dark #loading .spinner { border-color: rgba(255, 255, 255, 0.1); border-top-color: #4a9eed; }
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

  body.dark .pi-control {
    color: #e5e5e5; background: rgba(40, 40, 45, 0.92); border-color: rgba(255, 255, 255, 0.12);
  }
  body.dark .pi-control:hover { background: rgba(50, 50, 55, 1); border-color: rgba(255, 255, 255, 0.2); }
  body.dark .pi-control:active { background: rgba(30, 30, 35, 1); }

  .pi-control.copied { color: #15803d; border-color: #86efac; background: #f0fdf4; }
  .pi-control.error { color: #b91c1c; border-color: #fca5a5; background: #fef2f2; }
  body.dark .pi-control.copied { color: #4ade80; border-color: #166534; background: rgba(20, 83, 45, 0.4); }
  body.dark .pi-control.error { color: #f87171; border-color: #7f1d1d; background: rgba(127, 29, 29, 0.4); }

  #copy-svg { right: 12px; }
  #copy-png { right: 130px; }
  #theme-toggle { right: 248px; padding: 6px 10px; }
  #theme-toggle .moon, #theme-toggle .sun { display: none; }
  body:not(.dark) #theme-toggle .moon { display: block; }
  body.dark #theme-toggle .sun { display: block; }
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
  <meta name="color-scheme" content="light dark">
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
  <button id="theme-toggle" class="pi-control" type="button" title="Toggle light/dark mode" hidden>
    <svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z"/></svg>
    <svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/></svg>
  </button>
  <button id="copy-png" class="pi-control" type="button" title="Copy diagram as PNG to clipboard" hidden>
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="9" height="9" rx="1.5"/><path d="M3 10V3a1 1 0 0 1 1-1h7"/></svg>
    <span>Copy PNG</span>
  </button>
  <button id="copy-svg" class="pi-control" type="button" title="Copy diagram as SVG to clipboard" hidden>
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="9" height="9" rx="1.5"/><path d="M3 10V3a1 1 0 0 1 1-1h7"/></svg>
    <span>Copy SVG</span>
  </button>
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
    import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg, FONT_FAMILY } from "@excalidraw/excalidraw";

    const PSEUDO = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

    /** Convert raw shorthand elements (with label sugar) into Excalidraw format. */
    function convertRaw(els) {
      const real = els.filter((el) => !PSEUDO.has(el.type));
      const withDefaults = real.map((el) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el,
      );
      return convertToExcalidrawElements(withDefaults, { regenerateIds: false }).map((el) =>
        el.type === "text" ? { ...el, fontFamily: FONT_FAMILY.Excalifont ?? 1 } : el,
      );
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
      const bg = appState.theme === "dark" ? "#000000" : "#ffffff";
      return {
        elements,
        appState: { ...appState, exportBackground: true, viewBackgroundColor: bg },
        files: api.getFiles?.() ?? {},
      };
    }

    /** Serialize the current scene to an SVG string for export. */
    async function sceneToSvgString(api) {
      const snap = sceneSnapshot(api);
      if (!snap.elements.length) return { svg: "", count: 0 };
      const svg = await exportToSvg(snap);
      return { svg: svg.outerHTML, count: snap.elements.length };
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

    /** Apply a light/dark theme to the Excalidraw canvas + page chrome. */
    function setTheme(api, theme) {
      document.body.classList.toggle("dark", theme === "dark");
      api.updateScene({
        appState: { theme, viewBackgroundColor: theme === "dark" ? "#000000" : "#ffffff" },
      });
    }

    /** Wire the theme toggle button. Reads the saved choice from localStorage,
     *  defaults to the OS preference, and persists changes per-session. */
    function wireThemeToggle(api) {
      const btn = document.getElementById("theme-toggle");
      if (!btn) return;
      btn.hidden = false;
      const stored = (() => { try { return localStorage.getItem("pi-excalidraw-theme"); } catch { return null; } })();
      const initial = stored ?? (matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      setTheme(api, initial);
      btn.onclick = () => {
        const next = document.body.classList.contains("dark") ? "light" : "dark";
        try { localStorage.setItem("pi-excalidraw-theme", next); } catch { /* private mode */ }
        setTheme(api, next);
      };
    }

    /** One copy-button worth of state: DOM nodes + reset timer + the function
     *  that produces the clipboard payload to ship to the Node side. */
    const COPY_BUTTON_SPECS = [
      {
        target: "svg",
        elementId: "copy-svg",
        messageType: "copy-svg",
        progressLabel: null,
        export: async (api) => {
          const { svg, count } = await sceneToSvgString(api);
          return count ? { svg } : null;
        },
      },
      {
        target: "png",
        elementId: "copy-png",
        messageType: "copy-png",
        progressLabel: "Rendering…",
        export: async (api) => {
          const { base64, count } = await sceneToPngBase64(api);
          return count ? { base64 } : null;
        },
      },
    ];

    /** Wire the copy-to-clipboard buttons. WKWebView has no Clipboard API in
     *  opaque origins, so we ship payloads to the Node side via
     *  window.glimpse.send; the extension copies and pushes feedback back via
     *  window.__piOnCopyResult({ target, ok, error? }). */
    function wireCopyButtons(api) {
      // Build per-button state from the spec table.
      const wired = {};
      for (const spec of COPY_BUTTON_SPECS) {
        const btn = document.getElementById(spec.elementId);
        if (!btn) continue;
        btn.hidden = false;
        const label = btn.querySelector("span");
        wired[spec.target] = { spec, btn, label, originalLabel: label.textContent, resetTimer: null };
      }

      const setFeedback = (target, kind, text) => {
        const w = wired[target];
        if (!w) return;
        w.btn.classList.remove("copied", "error");
        if (kind) w.btn.classList.add(kind);
        w.label.textContent = text;
        if (w.resetTimer) clearTimeout(w.resetTimer);
        w.resetTimer = setTimeout(() => {
          w.btn.classList.remove("copied", "error");
          w.label.textContent = w.originalLabel;
          w.resetTimer = null;
        }, 1500);
      };

      window.__piOnCopyResult = (result) => {
        if (!result?.target) return;
        if (result.ok) setFeedback(result.target, "copied", "Copied!");
        else setFeedback(result.target, "error", "Copy failed");
      };

      for (const w of Object.values(wired)) {
        w.btn.onclick = async () => {
          try {
            if (w.spec.progressLabel) setFeedback(w.spec.target, null, w.spec.progressLabel);
            const payload = await w.spec.export(api);
            if (!payload) { setFeedback(w.spec.target, "error", "Nothing to copy"); return; }
            window.glimpse.send({ type: w.spec.messageType, ...payload });
          } catch (e) {
            console.error("export " + w.spec.target + " failed:", e);
            setFeedback(w.spec.target, "error", "Export failed");
          }
        };
      }
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

    function App() {
      const [api, setApi] = useState(null);
      const [fontsReady, setFontsReady] = useState(false);
      const status = useRef(document.getElementById("status"));
      const pending = useRef(null);

      const applyPayload = (payload, excApi) => {
        const elements = convertRaw(Array.isArray(payload?.elements) ? payload.elements : []);
        // Update only the elements — preserve theme/background set by setTheme.
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
          wireThemeToggle(api);
          wireCopyButtons(api);
        }
      }, [api, fontsReady]);

      return React.createElement(
        "div",
        { className: "excalidraw-container" },
        React.createElement(Excalidraw, {
          initialData: { elements: [], appState: { viewBackgroundColor: "#ffffff" } },
          excalidrawAPI: setApi,
          viewModeEnabled: true,
          zenModeEnabled: true,
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
