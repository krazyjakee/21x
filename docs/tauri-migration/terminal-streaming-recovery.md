# Streaming terminal recent-text recovery

Issue #214 continues the real terminal owners already delivered on master; it
adds no command, event, shell policy, process factory or transport limit.

`TerminalServiceCore` now retains logical lines across PTY callbacks. A bounded
state machine carries CSI, OSC, DCS, SOS, PM, APC and intermediate ESC parsing
across callbacks, without retaining escape bodies. CAN/SUB cancel an unfinished
sequence. The text log ignores carriage returns, non-text controls and empty
lines, as a recent log rather than a terminal screen emulator. It preserves
tabs, Unicode text and an unfinished final line. The live `terminal:data`
stream remains byte-for-byte unchanged; xterm owns actual screen behavior.

The core retains at most 500 logical lines and one million UTF-16 code units.
An oversized single line retains its recent suffix, avoiding a surrogate-pair
split at the trimming boundary. Process replacement starts a fresh parser;
late output from a retired process cannot change the replacement's log.

Production `terminal:getBuffer` selects the newest text that fits the existing
512 KiB result codec, including UTF-8, JSON escaping and punctuation. It may
return only the suffix of the oldest included line. It reserves the retained
codec's conservative extra delimiter byte. Long lines, tabs, quotes, backslashes
and multibyte output therefore cannot make ordinary recent-text recovery fail
with `FRAME_TOO_LARGE`. The core's larger log remains intact. This is bounded,
volatile history; it promises neither lossless scrollback nor a screen image.

`createNodePty` keeps both native subscriptions through kill and until the real
native exit callback. It then disposes both before notifying the owning core.
Duplicate close and late data callbacks are fenced. After exit, the captured
handle refuses writes/resizes and performs no later kill. Subscription disposal
failure does not hide the actual exit receipt. PID/generation, directory and
caller guards remain with their existing owners.

Regression fixtures cover every split position in a Unicode/control stream,
a long incomplete escape, logical text joining, exact JSON byte bounds, late
callbacks and process replacement. The real staged Linux proof uses one shell
command with builtin read barriers; those barriers force separate PTY callbacks
without readline adding an actual newline between commands. It asserts joined
text, discarded OSC title data, a bounded 700,000-byte Unicode output tail,
same-PID reattachment and actual native close. The existing #207 workload is
also rerun through `ProductionService`/`ServicePeer` with four real PTYs,
attachment I/O, bounded transcript pages and epoch replacement.

Exact commands, fixture results, versions, source/artifact digests and initial
failures are recorded in
[evidence](evidence/issue-closing-20261017-terminal-streaming.json).
These are source and staged Node/native-module checks. WebView version is
absent because this harness does not launch a Tauri window or installed package.

## Remaining issue acceptance

| Criterion | Delivered scope and remaining acceptance |
| --- | --- |
| PTY operations, ownership, environment, cleanup | Existing six production commands plus streaming log and listener fixes. Actual installed shell/CLI environment and descendant cleanup on every target remain unaccepted. |
| Commander/chat/image/cancel/model and native input | Existing service/renderer bindings retained. Installed Tauri keyboard/focus, provider/model/image flows remain unaccepted; Electron keyboard checks do not establish WebKit/WebView2 parity. |
| Attachment/image paths, resources, throughput, listeners | Existing paths and workers retained; this slice verifies terminal listener lifetime and bounded output recovery. Native file picking/import, drag/drop/viewer and non-Linux file callbacks need the native host owner (#215); this slice does not invent alternate path authority. |
| Hidden window, crash/reconnect, shutdown on each OS | Source epoch replacement and PTY close controls pass only their stated scope. `ProductionEngine::start` rejects non-Linux launch with `PRODUCTION_CONTAINMENT_UNAVAILABLE`; Windows private-fd3 and macOS detached-descendant containment are prerequisite #208 work. The packaged diagnostic workflow builds a different feasibility/synthetic host and cannot close this production acceptance. |

#208 and the #202 contract umbrella remain open. No checklist item is marked
complete from this limited evidence. Installed supported-OS acceptance cannot
be obtained by dispatching the existing diagnostic workflow for this change.
No live profile, release, Electron retirement or hosted voice change is made.
