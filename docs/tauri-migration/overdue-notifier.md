# Application-owned overdue reminder clock

Window recreation previously installed another untracked 60-second overdue timer. `OverdueNotifier` now starts with application services and shuts down before service teardown. Repeated starts retain one clock and its cadence. Dispatch resolves the current live window; closing or hiding a window does not replace the timer. Final shutdown cancels it and fences already queued callbacks.

Four portable lifecycle cases cover repeated start/cadence, absent/hidden/recreated hosts, shutdown and stale callbacks, and delivery failure/early shutdown. Together with the three forwarding-contract cases, seven targeted cases passed under both standalone Node and the Electron test launcher. Forced typecheck, changed-source lint and source freshness passed. [Evidence](evidence/overdue-notifier-local.json) distinguishes these targeted runs from the previous complete suite at `8614daa`.

This event asks the renderer to check overdue tasks. It does not fabricate provider activity, session transitions or freshness observations. Production Tauri event binding and native hidden-window acceptance remain tracked in #212/#208.
