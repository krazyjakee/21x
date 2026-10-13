# Portable scheduled coordination

Scheduled Captain reviews and Commander briefings now run in an Electron-free core with explicit notification, Commander, provider and speech hosts. The desktop adapter supplies existing native defaults. Repeated application startup with the same database returns its current owner; a stopped owner remains retained until its raw work drains, and final close prevents that database source from being restarted.

Shutdown closes admission, cancels the timer and signals summary cancellation. It joins accepted Captain sends, provider iteration, notifications and speech before SQLite closes. A provider that ignores cancellation remains owned through bounded close failure and retry. A summary arriving after shutdown creates no Commander session, notification or speech; after an accepted review, the next project and briefing phase are skipped. Overlapping ticks share the same pass.

The existing schedule/settings/briefing suite uses portable SQLite. Six lifecycle controls exercise real database and Commander persistence with fixture providers/agents/notification/speech, including ignored abort, pending host operations, multiple projects, queued admission and deadline validation. A separate application adapter control proves coalesced startup, retained stopped-owner failure/retry and source-replacement/revival rules. No real provider request, installed native speech/notification or production Tauri bootstrap is claimed.

[Local evidence](evidence/scheduled-coordination-owner-local.json) records exact scope, commands and source/report hashes. Heartbeat monitoring, workspace cleanup and complete installed/native background acceptance remain under [#212](https://github.com/krazyjakee/21x/issues/212) and [#208](https://github.com/krazyjakee/21x/issues/208).

Validation passed 17 core cases under each launcher and the application owner regression. Full standalone/private-pipe suite: 1,328 passed, zero skips, 91 files. Full application suite: 5,314 passed, 20 optional skips, 385 files, exit zero and no unhandled errors. Forced typecheck, changed-source lint, source/contract freshness and desktop/mobile build passed.
