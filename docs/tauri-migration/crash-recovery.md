# Crash recovery and crash log

Linux only. Windows and macOS compile as before and this makes no claim about them; WebView2 `ProcessFailed` belongs to a later slice. None of this has been compiled or run: see [what is unverified](#what-is-unverified).

Electron's behaviour is in `src/main/index.ts` (`render-process-gone`) and `src/main/crash-logger.ts`. Electron itself is unchanged.

## Renderer recovery

`NativeWindowOwner::watch_renderer` connects to WebKit's `web-process-terminated` signal on the main webview. The handler runs on the GTK thread and reads no Tauri getter.

1. If the app is quitting or the window has gone, it does nothing.
2. `NativeUiOwner::document_terminated` retires the dead document at once: its lease and generation stop being valid, and any load it left unfinished is forgotten, so the next load cannot look ambiguous.
3. Attachment drops and artifact viewers owned by that document are retired, as a navigation would retire them.
4. `RecoveryLimit` decides what happens next, and the outcome is logged.
5. On `Reload`, after one second, the window reloads through `navigation_current`, the same app-owned path as View > Reload, which invalidates document authority before dispatch. The focus rule of the menu path is left out, because a crash does not wait for the user.
6. The new page connects and rehydrates from the service, as it does after any reload.

| Case | What happens |
| --- | --- |
| First crash, or the first after 60 seconds | One reload after about one second |
| Another crash within 60 seconds of an automatic reload | No reload. It is logged, and View > Reload is the way forward |
| A termination the app requested (`TerminatedByApi`) | No reload, and it spends no reload. The app has no caller of this today |
| Quit, or the window has gone | Nothing, including no log entry |
| View > Reload during the one-second delay | The pending reload stands down, because the document has moved on |
| The window is hidden in the tray | The reload waits until the window is shown, because a hidden window gets no document lease and the page would stay without one |
| An app-owned reload | No web process ends, so the signal does not fire |

### View > Reload with a dead web process

By reading, it works. The menu is native GTK, so it does not depend on the web process. `Action::Reload` needs only a focused, current window, and `document_terminated` deliberately leaves the window attached. `window.reload()` reaches `webkit_web_view_reload` through wry, not through page script. Whether WebKit then starts a new web process is C library behaviour that the crate source cannot show.

## No write replay

| Where | What enforces it |
| --- | --- |
| Renderer | An in-flight request lives only in the page's memory (`DesktopClient`), which dies with the web process. Nothing is written to storage for a later retry, and rehydration only reads (`rehydrateProductionDesktop`) |
| Host | Recovery only reloads the webview. `desktop_invoke` holds no queue, and nothing in the path re-sends a command |
| Service | A command that reached the host before the crash finishes once. Its response has nowhere to go, and the reloaded page sees the result by reading |
| Callbacks | `document_terminated` advances the generation and clears the lease at the moment of death, so `assert_publish`, `assert_window_action`, the drop guards and document notices all refuse the dead document |

## Crash log

The log is `<Tauri profile>/logs/crash.log`, where the profile is `<app local data>/profile`. It is never written to the Electron folders, even when a profile shares them. The native host and the Node service both append to it.

| Kind | Writer | Content |
| --- | --- | --- |
| Session header | Host | Version, OS and architecture |
| `renderer-terminated` | Host | Reason, and the action taken |
| `renderer-reload-failed` | Host | A fixed error code |
| `service-ended` | Host | Exit status, when nothing here asked the service to stop |
| `uncaught-exception`, `unhandled-rejection` | Service | Error name, code, syscall and stack frames |
| `benign-stream-error` | Service | The same, for errors `isBenignStreamError` recognises |

Each entry also has a timestamp in the same format as Electron's log.

- **No secrets.** Environment and arguments are never read. Host entries are built from fixed text, a reason and an exit status. A service error keeps its message only when the message is a bare constant such as `OWNER_CLOSING`; any other message is replaced by its length, because a message can quote a prompt or a token and no filter can recognise them all. This is less detail than Electron's log, which records every message. The stack frames still give the location. A thrown value that is not an Error is recorded by type only.
- **Bounds.** Each file stops at 1 MiB and rotates once to `crash.log.1`, so at most 2 MiB is kept. A service entry is at most about 10 KiB.
- **Permissions.** The folder is 0700 and the files 0600, tightened if they already exist. A symbolic link at the folder or the file, or a hard link at the file, is refused.
- **Failures.** A write failure is swallowed. Host writes run off the GTK thread.
- **Refused launches.** The service installs its logger only after it holds both profile locks, and the host opens its log only after the service has started. A launch refused by the lock, or by the single-instance check, writes nothing.
- **Rotation race.** Both writers can rotate at the same moment. The cost is losing the older rotated entries; neither file can pass its bound.
- **First launch.** A `logs` folder does not count against the "new profile must be empty" check, so a first launch that crashed can start again.

The service logs through `uncaughtExceptionMonitor`, which observes without changing what happens next.

## Differences from Electron

- An uncaught exception or unhandled rejection ends the Tauri service, exactly as it did before this change. Electron keeps running after one. This includes `benign-stream-error`: the entry marks it as benign, but the service still ends, unlike in Electron.
- There is no error dialog. Electron shows one for an uncaught exception.
- WebKit's network and GPU processes are not logged, because the crate exposes no signal for them. Electron logs its GPU and child processes.
- Rust panics in the host are not logged.

## Limits

- An error before the service holds the profile lock is not logged.
- If some dependency installs its own `unhandledRejection` listener, Node stops raising rejections as uncaught exceptions and this monitor misses them. Nothing in the service does this today.
- A crash while the first page is still the inert `about:blank` start page is logged, but the reload is refused as untrusted (`renderer-reload-failed code=UNAUTHORIZED`).
- A service exit is logged once the service has been reaped. If the app exits first, the entry is lost.

## What is unverified

Everything here needs the patch-release pass.

- **Not compiled.** All the Rust is unbuilt, and every new Rust and TypeScript test is hand-traced only. `web-process-terminated`, `TerminatedByApi`, `WebProcessTerminationReason`, `PlatformWebview::inner`, `with_webview`, `reload`, `spawn_blocking` and the wry and tauri-runtime-wry paths were read in the pinned crate sources. `webkit2gtk` 2.0.2 gets feature `v2_40` from tauri and tauri-runtime-wry, which enables `v2_20`.
- **C library behaviour, not visible in the crates.** That killing the web process fires the signal with `Crashed`; that `webkit_web_view_reload` starts a new web process after a crash; that `webkit_web_view_get_uri` keeps returning the last URI after a crash, which `authorize` depends on; and whether `on_navigation` fires for such a reload. Recovery does not rely on that last one, because the host retires the document itself.
- **Hand checks.** A real crash, a second crash inside 60 seconds, a crash in the tray, and a real service crash reaching the log.
