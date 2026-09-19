# Canvas — per-project state

Each project has its own canvas (panels, edges, viewport) and its own drawings.
The stores are `src/renderer/src/stores/canvas-store.ts` and
`src/renderer/src/stores/drawing-store.ts`; the rules below are the same for
both.

## Storage

| What | Settings key | Legacy key |
|---|---|---|
| Canvas: `viewport`, `panels`, `edges`, `nextZIndex` | `canvas_state:<projectId>` | `canvas_state` |
| Drawings: `objects`, `nextZIndex` | `drawing_state:<projectId>` | `drawing_state` |

A settings-key suffix, not a table: nothing in the schema changes, and a
project that was never opened simply has no row. Browser and terminal panels,
and the edges that connect them to a task, are part of `canvas_state`, so they
stay with their project's canvas. `src/renderer/src/lib/project-scoped-setting.ts`
builds the keys and runs the migration.

## Migration

On the first load the pre-project blob is copied into the Default project
(`canvas_state` → `canvas_state:default`) and a marker is written
(`canvas_state_migrated_to_projects` = `1`; likewise for drawings). The marker
is checked first on every load, so the copy never runs twice — even if the
user has since cleared the Default canvas. The old key is left in place: there
is no settings delete over IPC, and a stale row costs nothing.

## Following the current project

Both stores subscribe to `useProjectStore.currentProjectId` and reload when it
changes, whether or not the canvas is on screen — an agent tool or the
published UI state must never see the previous project's panels after a
switch. `InfiniteCanvas` also asks for the current project's canvas when it
mounts; a load already under way for the same project is joined, not repeated.

The state carries `projectId` (set as a load *starts*) and `isLoaded` (set
when it lands). Three guards keep projects from leaking into each other:

- **A pending save is written under its own project.** The debounced save
  captures `projectId` when it is scheduled and is dropped if the store has
  moved to another project by the time it fires. On a switch, the pending save
  for the project left behind is flushed first, under that project's key.
- **Nothing is saved while a project is still being read.** Until `isLoaded`,
  the store holds an empty placeholder; writing it would clobber the saved
  canvas.
- **A slower load for the project left behind is dropped.** Each load takes a
  sequence number and gives up if a newer one has started.

Transient state (drag, snap guides, connection-in-progress, selection, text
editing) is reset on a switch. The drawing tool and its style options are kept
— they belong to the user, not to a project.

## Opening a task on its project's canvas

A task's panel lives on its own project's canvas. Every "open on canvas" path
goes through `useUIStore.openTaskOnCanvas(taskId)`; `InfiniteCanvas` consumes
the pending task and, when the task belongs to another project, switches the
current project first and waits for that project's canvas to load before
adding the panel (or focusing it, if it is already there).

The Captain UI tools (`src/renderer/src/lib/ui-remote-control.ts`) do the
same: `open_task`, `move_task_panel` and `close_task_panel` switch to the
task's project when needed and act once its canvas has loaded. `navigate` and
`set_canvas_view` name no task and act on the current project. The published
UI state carries `projectId`, so main (`src/main/task-api/ui-routes.ts`) lets a
move or close for a task in another project through instead of refusing it for
having no panel on the canvas that is on screen.
