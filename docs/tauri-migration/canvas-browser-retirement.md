# Canvas, browser and terminal removal

Earlier versions of this page described keeping Canvas data dormant. That contract
has ended. On 2026-11-04 the user asked for Canvas to be deleted in full, and on
2026-11-05 decided that the embedded browser and the embedded terminal go with it.
The removal applies to both hosts.

## What is gone

- The Canvas view, its panels and its drawings.
- The 15 live `browser_*` tools and the 4 `browser_recording_*` read tools.
- Browser and web page panels, recording capture and the "Open in Chrome" sign-in.
- The embedded terminal: the six `terminal:*` commands, `terminal:data` and
  `terminal:exit`, the terminal service and its backend, and `node-pty`.
- `move_task_panel`, `close_task_panel` and `set_canvas_view`. `navigate` no longer
  offers `canvas`, `open_task` no longer offers `where: canvas`, and `get_ui_state`
  no longer carries a `canvas` block.

Electron no longer sets `webviewTag`. `browser:*` stays a removed family in
`scripts/tauri-contracts.mjs`, so a new browser channel is recorded as removed
rather than quietly retained.

## Saved data

Schema 40 deletes `canvas_state`, `drawing_state`, their `:<projectId>` forms and
the two `*_migrated_to_projects` markers (`dropCanvasSettings`, covered by
`src/main/database/canvas-removal-migration.test.ts`). They held panel positions,
panel links, viewport, z-order and drawing objects. A panel held a task ID, never
the task, so no task, transcript or artifact row is touched.

Saved browser recordings under `browser-recordings/` are not deleted. No code reads
them now. The profile migration still carries that folder across, so a user who
wants the files keeps them.

The last-open view was never stored. The renderer starts on `dashboard`, so no
setting can land a user on a view that no longer exists.

## Still required

External URL opening, provider, connector and MCP sign-in, and sandboxed artifact
previews are separate from this removal and remain required. Production HTML
artifact viewing keeps its own contract in
[native artifact viewer](native-artifact-viewer.md).

## Left in place on purpose

- `session.defaultSession` still strips `X-Frame-Options`,
  `Cross-Origin-Resource-Policy` and related headers on Electron. Web panels were
  the reason it was added, but it also affects remote images, so removing it needs
  its own check.
- The Electron renderer CSP keeps `frame-src https: http:` for the same reason:
  artifact previews inherit that policy. Narrowing it is separate work.
