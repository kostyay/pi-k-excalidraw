# Excalidraw extension prompts

Standalone markdown prompts loaded from disk at module init by
`pi-extensions/excalidraw/index.ts` (see `loadPrompt`). Edit these files in
place — no rebuild required, just restart pi.

## Source

Both prompts were extracted from the upstream
**[excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp)** project
(MIT-licensed). To pull in upstream improvements, diff the relevant strings in
`excalidraw-mcp/src/server.ts` against the files here and reapply our local
edits (see per-file notes below).

## Files

### `element-format.md`

Excalidraw element-format cheat sheet injected into the system prompt while
`/excalidraw` mode is active.

- **Upstream**: the `RECALL_CHEAT_SHEET` constant in
  [`excalidraw-mcp/src/server.ts`](https://github.com/excalidraw/excalidraw-mcp/blob/main/src/server.ts).
- **Local edits**:
  - `create_view` → `draw_diagram` (matches this extension's tool name).
  - First line removed (`Thanks for calling read_me! …`) — this extension has
    no `read_me` tool; the sheet is injected directly into the system prompt.

### `draw-instruction.md`

User-message template sent by the `/excalidraw <task>` command. The literal
token `{{task}}` is replaced with the user's diagram description before the
message is dispatched.

- **Upstream**: derived from the equivalent draw-instruction prompt in
  [excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp).
- **Local edits**: tool name `draw_diagram`; `{{task}}` placeholder added.

## Adding a new prompt

1. Drop a new `*.md` file into this directory.
2. Load it in `index.ts`:
   ```ts
   const MY_PROMPT = loadPrompt("my-prompt.md");
   ```
3. Document it in this README (upstream source, any placeholders).
