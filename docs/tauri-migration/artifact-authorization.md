# Artifact authorization boundary

Retained artifact previews must use a separate Webview with no desktop capabilities. The privileged `main` Webview keeps `frame-src 'none'`. An iframe inside `main` cannot provide a portable native authorization boundary with the pinned Linux implementation. The current prototype does not migrate the production artifact viewer or restore embedded browsing.

## Pinned source review

The reviewed crate archives match the checksums in `src-tauri/Cargo.lock`:

| Crate | Version | SHA-256 |
| --- | --- | --- |
| tauri | 2.12.3 | `c404ecf956ff241bf6b39dd688614724e1bf1f63255abb4fc46d1c40371672ea` |
| tauri-runtime-wry | 2.12.1 | `7f9e7e0c9f80a5130773cfabb6df4dc924518fb1b2c923726966804634b57d22` |
| wry | 0.57.0 | `a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0` |

In the official [Wry archive](https://static.crates.io/crates/wry/wry-0.57.0.crate), `src/webkitgtk/mod.rs` constructs script-message IPC requests using the current **Webview** URI. Its handler does not receive the invoking frame's origin. The WKWebView implementation uses `frameInfo().request().URL()`, while WebView2 uses the message event's `Source()`. This platform difference prevents treating top-level URL checks as proof of frame isolation.

In the official [Tauri archive](https://static.crates.io/crates/tauri/tauri-2.12.3.crate), `src/webview/mod.rs::on_message` resolves capability access using window label, Webview label and the supplied IPC origin. `src/manager/webview.rs` marks the global API scripts as main-frame-only. The pinned Wry Windows implementation explicitly ignores that flag and adds initialization scripts to subframes (`src/lib.rs::with_initialization_script`, `src/webview2/mod.rs`). Missing globals on another platform therefore show a script-injection restriction, rather than proving that an authenticated native request would be denied.

The [Tauri capability documentation](https://v2.tauri.app/security/capabilities/) explicitly describes the Linux/Android iframe limitation and the need for an `AppManifest` to restrict custom commands. The existing build manifest enumerates our three custom commands, and `feasibility-main` grants them only to `main`. The [previous iframe IPC advisory](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7) gives additional context; this review concerns the currently locked source, rather than claiming an old vulnerability remains unfixed.

## Compile-selected diagnostic

The `artifact-authorization-proof` Cargo feature includes `synthetic-desktop`. Its diagnostic implementation additionally requires `debug_assertions` and the existing explicit `TWENTYONEX_NATIVE_SMOKE_REPORT` opt-in. Release builds omit its protocol and code. There is no renderer command to enable the diagnostic, choose an artifact path, supply code or create a privileged window.

The native diagnostic performs these bounded phases:

1. The trusted main screen successfully invokes `desktop_invoke` with `db:getTasks`, invokes `engine_status`, and registers `desktop:event`. These positive controls establish that the tested commands and transport actually work.
2. A native-created `artifact-proof` Webview loads the same bundled application URL. Its label has no capability match. It makes the same correctly formed requests and must receive recognized native authorization denials for all three. Missing APIs, generic errors and timeouts fail this phase. This tests exclusion independently from remote-origin policy.
3. The excluded Webview loads a fixed page with an opaque script-only sandbox frame. The frame must have an opaque origin and be unable to access its parent's DOM/globals. Its parent relay must receive all three native ACL denials. If frame APIs are injected, direct calls must receive either all three actual ACL denials or all three exact native invalid-Origin parser rejections. The latter remain separately recorded and do not claim authenticated frame IPC exclusion.
4. The same excluded Webview loads another fixed page whose sandboxed child uses a second diagnostic protocol and `allow-scripts allow-same-origin`. The child URL differs from its parent's origin, so parent DOM/globals must remain inaccessible. When its own APIs are injected, its origin must be non-opaque and all three direct requests must receive actual command-specific native ACL denials. Invalid-Origin errors, generic failures, accepted calls and deadlines fail this phase. API absence remains explicit on platforms that inject only into the top document.
5. A real synthetic database task creation produces a valid service event. The main listener must receive it. The artifact window closes, the diagnostic listener is removed, and existing native smoke checks still require main-window close, engine shutdown and owned-child exit.

Policy version 3 names the method `opaque-rejection-and-valid-origin-frame-acl`.
It retains `sameMainIframeIsolationProven: false` and
`opaqueFrameAuthenticatedIpcProven: false`. The second frame supplies the native
ACL control that opaque Windows origins cannot reach through the standard SDK.
An opaque parser rejection cannot satisfy the second frame's authorization check.

The two diagnostic protocols serve only compiled fixed fixtures to the excluded
label while smoke is active. Their response CSP permits those fixture frames and
scripts; application configuration and the main CSP stay unchanged. No external
website, capability wildcard or remote grant is added. Navigation, popups,
downloads and permission requests remain restricted. Native evaluation collects
Boolean metadata without a reporting command in the artifact.

Each navigation waits for document readiness at its exact fixed route and a
matching phase marker. The original 15-second overall deadline, bounded evaluation
waits and bounded canary request remain. Failure closes the owned window through
a scope guard. No mutation is replayed. Local v3 controls compile and pass. Installed Windows v3 passed at `144fab3`;
its receipt is recorded below. Current same-revision four-target acceptance
remains pending, and old v1/v2 receipts keep their original scope.

## Packaged initial URL correction

Three Linux diagnostic packages compiled and passed their ordinary synthetic desktop checks, but the excluded window never became ready. This did not provide artifact authorization evidence. The initial artifact navigation policy incorrectly required `/` or `/index.html` for the packaged application root.

The pinned Tauri archive's `src/manager/webview.rs::prepare_webview` deliberately ignores the `index.html` path and uses the application root URL unchanged. `src/manager/mod.rs` includes a packaged-URL assertion for `tauri://localhost` on Linux/macOS and `http://tauri.localhost/` on Windows. The custom-scheme root has an empty pathname. The corrected policy accepts that precise root form while still excluding unrelated paths, query strings, fragments, credentials and outside origins. Regression tests cover both URL forms and forbidden alternatives.

The Wry runtime dispatches worker-created windows onto its GUI event loop and waits for creation to complete. Its WebKitGTK navigation handler explicitly ignores rejected policy decisions. The observed lack of an application load is therefore consistent with the root-path rejection; source inspection did not identify a wrong-thread creation requirement for this case.

Evidence includes window-creation success and bounded navigation counts with a fixed classification (`app-empty-root`, `app-slash-root`, `app-index`, `initial-blank`, `fixed-artifact`, or a blocked category). It records no raw URL or native error. The [corrected installed Linux run](https://github.com/krazyjakee/21x/actions/runs/38300023337) passed at `a4a980f`, with no timeout increase. Its [retained report](evidence/linux-x64-artifact-authorization-installed-gui.json) records the excluded document becoming ready, all three excluded-label denials, sandbox/relay checks, a real main-targeted service event, diagnostic window cleanup and native shutdown with no surviving owned service.

## Central validation and remaining gates

After ordinary synthetic desktop smoke passes, stage the database service and build the existing isolated Debian diagnostic package with:

```sh
pnpm tauri:prepare:database
pnpm tauri:frontend:build
pnpm exec tauri build --debug --bundles deb --features artifact-authorization-proof
```

Use the existing installed-package Xvfb smoke runner with system Node hidden and its isolated synthetic profile. Compact evidence must contain `runtime.artifactAuthorizationProof.passed: true` alongside the ordinary synthetic receipt and shutdown checks. Upload logs separately from packages. The successful Linux report meets this diagnostic requirement; source checks alone provide no native security evidence.

The earlier Linux run demonstrates that revision's separate-Webview diagnostic. Current cross-platform results are recorded below. Production artifact content needs a separate viewer integration, narrow lifecycle/message mediation, content/path restrictions, and regression tests against all desktop/plugin/event grants. Same-`main` iframe isolation remains unsupported as the migration design.

The packaged-platform workflow now accepts `mode: artifact-authorization-proof` for each existing DMG, NSIS and AppImage target. It stages the synthetic database service, enables the exact Rust feature and uses the installed-package smoke runner. The runner checks all thirteen desktop receipts, the separate-WebView positive/negative controls, targeted event delivery, window cleanup, installed resource containment, host architecture, isolated profile and owned-child exit. `synthetic-agent` separately requires all twenty agent receipts. Evidence/package artifact names include the mode, so reports from different proofs cannot overwrite each other. These workflow changes make the outstanding platform runs executable; passing report-validator tests or compiling the host does not supply installed evidence.

## Windows frame-injection continuation

The original relay policy passed installed packages on macOS x64/arm64 and Linux at `8b9954a`. [Windows at `b995a2f`](https://github.com/krazyjakee/21x/actions/runs/38330478104) passed all thirteen desktop receipts, the same-origin excluded-window native denials, sandbox parent-access/relay denials and native shutdown. It failed because `frameBridgeAbsent` was false. Its [original failed report](evidence/installed-artifact-b995a2f-windows-x64-failed-gui.json) is retained unchanged. This agrees with the pinned Windows script-injection behavior; that report alone proves no direct frame authorization outcome.

The version-2 continuation tests actual direct calls when APIs are present. Its failure metadata distinguishes accepted calls, unrecognized failures and deadlines without publishing native error strings or paths. Six actual-script VM regressions cover API absence, both recognized denial shapes, successful calls/subscriptions, generic transport failure and bounded deadlines. Fifteen Python evidence-policy cases and three native tests require consistent absence/direct-denial claims; older policy reports cannot count as new direct-frame evidence. The Windows installed retry remains required before acceptance. Production viewer integration, all retained native/plugin grants and same-main-iframe constraints remain separate open work.

The first Windows version-2 retry at `f15cd46` failed closed: its facade was present and direct attempts completed with unrecognized failures, rather than native authorization denials. Parent/relay controls and shutdown still passed. Follow-up diagnostics record fixed Boolean internal-invoke/IPC availability and error-class observations without publishing raw exceptions. This is ongoing diagnosis; neither a generic failure nor API presence establishes a privilege escape or successful authorization exclusion.

The stricter v2 policy passed installed DMGs on both macOS architectures and the
Linux AppImage at `f15cd46`. The [retained Unix receipts](evidence/installed-artifact-v2-unix-scenarios.json)
keep the original reports and package checksums. That matrix failed overall on
Windows; the successful Unix jobs do not turn it into four-target acceptance.
These reports predate exact OS/WebView version collection. The latest Windows
GUI receipt at `942af9c` distinguishes an immediate string failure from a timeout,
TypeError or missing transport, but does not establish its native error class.
Exact pinned origin-parser classifications were added at `40f8061`; both remain
failures under v2, and no arbitrary error text is recorded.

The [Windows retry at `0604c83`](https://github.com/krazyjakee/21x/actions/runs/38340619029)
reached the installed GUI and identified `Origin header is not a valid URL` from
pinned Tauri's native request parser. Its [failed report](evidence/installed-artifact-0604c83-windows-x64-origin-failed-gui.json)
records `directInvalidOrigin: true`, no accepted call, no timeout, and all three
separate-WebView ACL denials. WebView2 reported `131.0.2903.86`. The parser rejects
the opaque frame before ACL evaluation; this remains a failed v2 authorization
receipt. It does not establish authenticated direct-frame IPC exclusion.

The denial matcher now accepts only the fixed native `UNAUTHORIZED` code or
command-specific release/debug ACL formats from the pinned Tauri source. Generic
denial wording, unknown command/plugin messages and another command's ACL error
fail the control. Both diagnostic documents use the same compiled matcher.
[Local evidence](evidence/artifact-denial-matcher-local.json) records fourteen
frame controls, twenty-one package policy/provenance controls and three native
tests. New package runs retain checksums even before the GUI starts and can retain
contained runtime/process observations on failure without changing acceptance.

## Installed Windows policy-v3 result

The [Windows NSIS run at `144fab3`](https://github.com/krazyjakee/21x/actions/runs/38351070116)
passed policy v3. The [retained scenario](evidence/installed-artifact-v3-windows-scenario.json)
includes the unchanged GUI report, package provenance, artifact digest and installer
SHA-256. Windows `10.0.20348`, default WebView2 `131.0.2903.86`, and bundled Node
`22.23.2` / ABI `127` were observed. System Node was hidden; no owned process
survived shutdown.

The valid-origin child had injected native APIs and a non-opaque origin. All
three direct calls received actual command-specific native ACL denials; no call
was accepted, timed out, failed generically or stopped at the origin parser. The
opaque child separately recorded all three exact invalid-Origin rejections. The
main positive controls, same-application-origin excluded-window denials, parent
access restrictions, targeted service event and artifact cleanup also passed.
This establishes this installed synthetic diagnostic's scope. Production viewer
integration and the remaining grants/content/lifecycle review stay open. A new
all-target run at `5bea453` is separate from this Windows receipt.
