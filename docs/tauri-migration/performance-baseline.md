# Application performance baseline

`node scripts/desktop-baseline/run.mjs` measures the actual built Electron main
process, production preload/IPC, database and full renderer on Linux. Build the
desktop first and provide a graphical session (CI uses Xvfb/D-Bus). The manual
`Desktop Electron performance baseline` workflow builds once and runs three
starts sequentially. It shares the native Linux proof queue and uses one native
build worker. The harness is outside shipping bundles and exposes no automation
endpoint. It requires its own temporary profile marker and anonymous report pipe;
the application uses that fixture through its ordinary profile lock.

The first start creates one task; later starts reopen the same fixture. All runs
measure navigation/control readiness, task-list read, content edit, persisted
reload/read, three seconds of idle and quit. The first run also measures creation.
Remote renderer requests are blocked. Raw application logs, task IDs, task data
and command arguments are discarded; evidence contains fixed metrics and versions.

Memory is the peak sum of sampled Linux descendant RSS at 250ms intervals, with
process-start identity checks. Shared pages can be counted more than once, and
short-lived or escaping descendants can be missed. It is not physical memory or
a universal process-ownership proof. Shutdown is an upper bound from the child's
quit timestamp to the parent's close observation; process startup overhead is
included in that upper bound. OS/code caches remain uncontrolled, so reused
profiles are labelled explicitly rather than called cold or warm cache trials.

This supplies an Electron application baseline, pending a successful recorded
run. It does not establish a performance gain or complete T00/G0. The current
Tauri frontend contains a small synthetic task slice; comparison to the complete
Electron renderer would be misleading. A matched fixture, hardware, production
feature set and repetition count still need to cover interactive task list,
multi-agent load, transcript/terminal latency, hidden-window behavior, package
and profile disk use, then set regression budgets before accepting that gate.
