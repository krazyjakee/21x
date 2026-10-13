# Portable recurrence scheduling

`RecurrenceSchedulerCore` owns cron/legacy pattern evaluation, database work, its timer and the active reconciliation pass. An explicit event host receives task-created and refresh events. The Electron adapter keeps guarded sends and replaces the window target when a window is recreated. Repeated starts replace the old timer, and overlapping starts/manual ticks share one pass.

Each occurrence inherits its template's project. Instance insertion and template advancement now commit in one SQLite transaction before any event is sent. A failed template update rolls the new instance back; a failed renderer event cannot leave the template due and duplicate an already committed occurrence. Existing recurring flags, fields, cron/legacy calculations and auto-start notification remain covered.

Final shutdown closes admission, cancels the timer and queued work, joins the accepted raw pass, and prevents later templates or automation callbacks from running. The application joins this owner before SQLite closes. Portable tests use real SQLite and fixture event hosts; the separate Electron adapter regression verifies events move to the recreated window. No production Tauri scheduling bootstrap or installed scheduler parity is claimed.

[Local evidence](evidence/recurrence-owner-local.json) records scope, source hashes and validation. Remaining scheduled coordination, heartbeat and workspace cleanup ownership plus full production/native integration remain tracked in [#212](https://github.com/krazyjakee/21x/issues/212) and [#208](https://github.com/krazyjakee/21x/issues/208).

Validation passed all 30 recurrence cases under both launchers plus the Electron window adapter regression. Full standalone/private-pipe suite: 1,311 cases with zero skips in 89 files. Full application suite: 5,307 assertions with 20 optional skips in 383 files, exit zero and no unhandled errors. Forced typecheck, changed-source lint, contract freshness and desktop/mobile build passed.
