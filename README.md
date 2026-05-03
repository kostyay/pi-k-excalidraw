<div align="center">

# pi-k-excalidraw

### Native Excalidraw diagram preview tool for [pi](https://pi.dev/)

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Let pi draw Excalidraw diagrams that preview live in a glimpse window — no
MCP child process, no extra services.*

An extension for **[pi](https://pi.dev/)** — an AI coding agent that runs in
your terminal. `pi-k-excalidraw` registers tools so the model can draw and
save Excalidraw diagrams. Inspired by
[`excalidraw-mcp`](https://github.com/excalidraw/excalidraw-mcp), but
reimplemented natively against the pi extension API.

---

## Install

```bash
# latest from main
pi install git:github.com/kostyay/pi-k-excalidraw

# pin to a release
pi install git:github.com/kostyay/pi-k-excalidraw@v0.1.0

# try without installing
pi -e git:github.com/kostyay/pi-k-excalidraw
```

Pi clones the repo, runs `npm install`, and registers the extension. Use
`-l` to install into the current project (`.pi/settings.json`) instead of
globally.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/kostyay/pi-k-excalidraw.git
cp -r pi-k-excalidraw/extensions/pi-k-excalidraw ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

---

## What's included

### Tools

| Tool | Description |
|------|-------------|
| `draw_diagram` | Render an array of Excalidraw elements in a glimpse preview window. Streams partial JSON so long diagrams update incrementally. |
| `draw_mermaid_diagram` | Convert a Mermaid diagram (flowchart, sequence, class, ER) into native Excalidraw elements and render in the same preview. |
| `screenshot_diagram` | Capture the current preview as a PNG and return it as image content so the model can visually inspect and self-correct. |
| `save_diagram` | Write the current diagram to a `.excalidraw` file. Pass `name` to save under `.pi/excalidraw-diagrams/`, or `path` for a custom location. |
| `list_diagrams` | List previously saved diagrams under `.pi/excalidraw-diagrams/`. |
| `load_diagram` | Load a saved `.excalidraw` file back into the preview as a new checkpoint so you can extend it with more `draw_diagram` calls. |

### Command

| Command | Description |
|---------|-------------|
| `/excalidraw <description>` | Kick off a drawing turn. The Excalidraw element-format cheat sheet is injected into the system prompt for the rest of the session, so the model never has to ask for it. After every drawing turn pi prompts you to send the screenshot back to the LLM with optional comments for another refinement pass — decline to exit the loop. |

### Clipboard export

The preview window includes PNG and SVG copy actions. PNG copy uses native
`osascript` on macOS so the image lands on the system clipboard, not just the
browser one.

---

## Usage

```
/excalidraw a sequence diagram of the OAuth 2.0 authorization-code flow
```

The model returns a `draw_diagram` call with an array of Excalidraw elements.
The preview window opens (or updates in place) and renders them. Iterate by
asking pi to extend or fix the diagram — the extension passes a checkpoint
id back so the next call extends the same canvas instead of replacing it.

When you're happy:

```
save it as oauth-flow
```

`save_diagram` writes the canonical `.excalidraw` JSON to
`.pi/excalidraw-diagrams/oauth-flow.excalidraw` (or a custom `path` if you
prefer), ready to open in [excalidraw.com](https://excalidraw.com) or any
Excalidraw editor.

Resume later:

```
list saved diagrams, then load oauth-flow and add a refresh-token step
```

`load_diagram` restores the file as a fresh checkpoint; the next
`draw_diagram` call extends it via `restoreCheckpoint`.

Visual self-check (sends a screenshot back to the model so it can see what
it drew):

```
take a screenshot and check if the labels overlap
```

The model is also prompted (via `draw-instruction.md`) to call
`screenshot_diagram` itself after each draw and self-correct overlaps,
truncated text, low-contrast labels, off-camera elements, and misaimed
arrows before reporting back.

Review loop: after every turn started by `/excalidraw`, pi opens a confirm
dialog asking whether to send the current screenshot back to the LLM. Accept
to enter free-form comments (or leave them empty for a generic review pass);
the screenshot + comments are forwarded as a new user message that extends
the latest checkpoint. Decline to leave the loop.

Mermaid shortcut:

```
draw the OAuth flow as a mermaid sequence diagram
```

---

## How it works

```
┌──────────────────────┐     ┌──────────────────────────┐
│  pi extension        │     │  Glimpse webview          │
│                      │     │                           │
│  draw_diagram        ├────►│  @excalidraw/excalidraw   │
│  save_diagram        │     │  (loaded from esm.sh)     │
│  /excalidraw cmd     │     │  PNG/SVG clipboard export │
└──────────────────────┘     └──────────────────────────┘
```

- Prompts live as standalone markdown files under
  `extensions/pi-k-excalidraw/prompts/` (`element-format.md` cheat sheet,
  `draw-instruction.md` for `/excalidraw` turns, `review-instruction.md` for
  the post-turn review loop) and are loaded from disk at module init — edit
  in place, just restart pi.
- Streaming partial JSON is parsed by `parser.ts` so long diagrams render
  element-by-element instead of waiting for the full payload (throttled to
  ~80 ms between webview pushes).
- Checkpoints let successive `draw_diagram` calls extend the previous canvas
  rather than replacing it; pass `{ "type": "restoreCheckpoint", "id": "<id>" }`
  as the first element. Use `{ "type": "delete", "ids": "id1,id2" }` to
  remove specific elements before re-adding them.
- `screenshot_diagram` runs an RPC into the webview, exports the canvas as
  PNG, and returns it as image content so the model can visually inspect its
  own work and self-correct.
- Mermaid diagrams (`flowchart`, `sequence`, `class`, `ER`) are converted to
  native Excalidraw elements inside the webview via
  `@excalidraw/mermaid-to-excalidraw`; other Mermaid types fall back to
  rendered images.

---

## Development

```bash
git clone https://github.com/kostyay/pi-k-excalidraw.git
cd pi-k-excalidraw
npm install
npm run typecheck
npm test
```

Then load the extension directly from your checkout:

```bash
pi -e ./extensions/pi-k-excalidraw/index.ts
```

---

## Credits

- [Excalidraw](https://github.com/excalidraw/excalidraw) — the canvas itself.
- [excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) — the
  element-format cheat sheet and drawing-instruction prompts originate here
  (MIT-licensed).
- [pi](https://pi.dev/) — the agent harness that hosts this extension.

## License

MIT — see [LICENSE](LICENSE).
