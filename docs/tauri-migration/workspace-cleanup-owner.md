# Portable workspace cleanup and shutdown

`WorkspaceCleanupSchedulerCore` owns delayed startup, hourly scheduling, manual cleanup and node_modules pruning through an explicit workspace path/event host. The Electron adapter supplies existing workspace paths and two literal guarded event names. Starting again replaces both timers; stopping cancels the delayed startup as well as the interval.

Final shutdown rejects new work and joins the raw accepted process scan/termination or worktree cleanup before SQLite closes. A deadline failure retains ownership for retry. Queued work performs no SQL, and late results cannot begin the next workspace removal, dependency-pruning phase, event or last-run write. An already accepted worktree operation may finish its own cleanup and database writes while the owner remains held.

An unreadable workspace listing remains distinct from an empty directory: node_modules pruning now skips rather than performing a second scan without a trustworthy liveness set. Existing process selection, retention and active-task fallback rules remain in place. Actual native process termination is injected out of the owner fixtures; only owned OS temporary directories are removed. One test exercises the real dependency-pruning implementation and verifies active workspaces and repository directories survive.

Ten existing scheduler cases and eight lifetime/policy cases run under standalone Node. The lifetime controls use actual portable SQLite. The desktop adapter has a separate guarded-event/window-recreation test. [Local evidence](evidence/workspace-cleanup-owner-local.json) records source/report hashes and validation. Production Tauri bootstrap, native paths, real worktree/process integration and overall background orchestration remain open under [#212](https://github.com/krazyjakee/21x/issues/212) and [#208](https://github.com/krazyjakee/21x/issues/208).

Full validation passed 1,441 standalone/private-pipe tests with zero skips in 95 files and 5,331 application tests with 20 optional skips in 389 files. Both commands exited zero without unhandled errors. Forced typecheck, changed-source lint, contract freshness and desktop/mobile build passed.
