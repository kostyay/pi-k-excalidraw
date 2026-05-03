# Changelog

All notable changes to this project are documented here.




## docs/excalidraw-architecture-diagram

Added comprehensive architecture documentation for the pi-k-excalidraw extension (#2), including a detailed Excalidraw diagram that visualizes the interaction between the LLM agent, extension components (index.ts, parser.ts, diagrams.ts), registered tools (draw_diagram, draw_mermaid, screenshot, save/load), system prompts, and the Glimpse webview preview powered by @excalidraw/excalidraw. The refactored codebase clarifies the tool registration flow, RPC communication channels between host and webview, and filesystem persistence patterns for diagram storage in `.pi/excalidraw-diagrams/`. This documentation serves as a reference guide for understanding the extension's modular architecture and agent-driven diagram generation workflow.

## [0.1.0](https://github.com/kostyay/pi-k-excalidraw/pull/1) - 2026-05-03

Introduces comprehensive diagram tooling and code quality gates for the Excalidraw extension (#1). Adds four new tools—`draw_mermaid_diagram` for converting Mermaid flowcharts/sequences to native Excalidraw elements, `screenshot_diagram` for visual self-correction, `load_diagram` to restore saved diagrams as checkpoints, and `list_diagrams` to browse the diagram library—alongside persistent storage under `.pi/excalidraw-diagrams/` with slug-based naming. Extracts diagram helpers (`slugifyDiagramName`, `parseExcalidrawFile`, `resolveDiagramPath`, etc.) into a testable `diagrams.ts` module with comprehensive unit tests, and introduces ESLint with a pragmatic TypeScript config to catch syntax errors and obvious bugs while filtering noisy stylistic rules. CI now runs linting before typecheck, enforcing code quality gates on every commit.

## [0.1.0] - 2026-05-03

### Added

- Initial release of `pi-k-excalidraw`.
- `draw_diagram` tool — render an array of Excalidraw elements in a live
  glimpse preview window with streaming partial-JSON support and per-element
  throttling.
- `save_diagram` tool — persist the most recently rendered diagram to a
  `.excalidraw` file.
- `/excalidraw <description>` command — kicks off a drawing turn and injects
  the Excalidraw element-format cheat sheet into the system prompt for the
  rest of the session.
- Clipboard export helpers (PNG/SVG) including macOS-native PNG clipboard
  support via `osascript`.
- Webview preview powered by `@excalidraw/excalidraw` loaded from `esm.sh`,
  with checkpoint-based diagram persistence so successive draws can extend
  the previous canvas instead of replacing it.
- Standalone prompt files in `extensions/pi-k-excalidraw/prompts/` so the
  element-format cheat sheet and drawing instructions can be edited without
  rebuilding.
