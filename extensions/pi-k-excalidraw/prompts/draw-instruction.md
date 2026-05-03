Draw the following diagram with the `draw_diagram` tool. Use the Excalidraw element format from the system prompt. Stream a cameraUpdate first, then build the diagram progressively.

{{task}}

After you finish drawing, **you must visually verify the result before reporting back to the user**:

1. Call `screenshot_diagram` to capture the rendered canvas as a PNG.
2. Inspect the image carefully. Specifically check for:
   - Overlapping shapes, labels, or arrows that obscure each other.
   - Text that is truncated, clipped by the camera, or runs outside its container.
   - Labels with low contrast against their background (unreadable).
   - Arrows that miss their intended source/target, cross awkwardly, or have misplaced labels.
   - Elements positioned outside the final `cameraUpdate` viewport.
   - Empty / unbalanced regions, or content that is much smaller than the camera (font too small to read).
3. If the screenshot looks good, you are done — summarise the diagram for the user.
4. If anything is wrong, fix it with another `draw_diagram` call. Prefer extending the existing canvas via `{"type":"restoreCheckpoint","id":"<id>"}` as the first element, and use `{"type":"delete","ids":"..."}` to remove broken pieces before re-adding them. Then call `screenshot_diagram` again.
5. Repeat the screenshot → fix loop until the diagram is correct. Stop iterating once it looks right (do not over-polish), and bail out if you have already made several attempts without progress and ask the user for guidance instead.
