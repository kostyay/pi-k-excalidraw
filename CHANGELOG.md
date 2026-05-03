# Changelog

All notable changes to this project are documented here.

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
