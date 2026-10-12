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

In the official [Tauri archive](https://static.crates.io/crates/tauri/tauri-2.12.3.crate), `src/webview/mod.rs::on_message` resolves capability access using window label, Webview label and the supplied IPC origin. `src/manager/webview.rs` installs the global API scripts for the main frame only. Missing globals inside a sandbox therefore show a script-injection restriction, rather than proving that an authenticated native request would be denied.

The [Tauri capability documentation](https://v2.tauri.app/security/capabilities/) explicitly describes the Linux/Android iframe limitation and the need for an `AppManifest` to restrict custom commands. The existing build manifest enumerates our three custom commands, and `feasibility-main` grants them only to `main`. The [previous iframe IPC advisory](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7) gives additional context; this review concerns the currently locked source, rather than claiming an old vulnerability remains unfixed.

## Compile-selected diagnostic

The `artifact-authorization-proof` Cargo feature includes `synthetic-desktop`. Its diagnostic implementation additionally requires `debug_assertions` and the existing explicit `TWENTYONEX_NATIVE_SMOKE_REPORT` opt-in. Release builds omit its protocol and code. There is no renderer command to enable the diagnostic, choose an artifact path, supply code or create a privileged window.

The native diagnostic performs these bounded phases:

1. The trusted main screen successfully invokes `desktop_invoke` with `db:getTasks`, invokes `engine_status`, and registers `desktop:event`. These positive controls establish that the tested commands and transport actually work.
2. A native-created `artifact-proof` Webview loads the same bundled application URL. Its label has no capability match. It makes the same correctly formed requests and must receive recognized native authorization denials for all three. Missing APIs, generic errors and timeouts fail this phase. This tests exclusion independently from remote-origin policy.
3. The same excluded Webview loads a fixed debug-only protocol page containing a script-only sandbox frame. The frame must be unable to access the parent's DOM or Tauri globals and must lack its own Tauri global. It requests three attempts through its **unprivileged parent**, which actually invokes the APIs and returns Boolean denial results. Evidence calls this `unprivileged-parent-relay`; it does not authenticate IPC from the iframe itself and does not prove that an iframe in `main` would be safe.
4. A real synthetic database task creation produces a valid service event. The main listener must receive it. The artifact window closes, the diagnostic listener is removed, and existing native smoke checks still require main-window close, engine shutdown and owned-child exit.

The custom protocol serves only three compiled fixtures to the fixed excluded label while native smoke is active. Its own response CSP permits that fixture frame/script; application configuration and the main CSP stay unchanged. Navigation is restricted to the initial bundled document and fixed fixture routes; popups, downloads and permission requests are denied. No capability wildcard or remote grant is added. Native evaluation collects Boolean metadata without granting a reporting command to the artifact.

The phases wait for a document-specific `PageLoadEvent::Finished` result and matching phase marker. The proof has a 15-second deadline, bounded evaluation waits and a bounded canary request. Failure closes the owned diagnostic window through a scope guard. No mutation is replayed.

## Central validation and remaining gates

After ordinary synthetic desktop smoke passes, stage the database service and build the existing isolated Debian diagnostic package with:

```sh
pnpm tauri:prepare:database
pnpm tauri:frontend:build
pnpm exec tauri build --debug --bundles deb --features artifact-authorization-proof
```

Use the existing installed-package Xvfb smoke runner with system Node hidden and its isolated synthetic profile. Compact evidence must contain `runtime.artifactAuthorizationProof.passed: true` alongside the ordinary synthetic receipt and shutdown checks. Upload logs separately from packages. Native compilation and launch are deferred to that centralized batch; source checks alone provide no native security evidence.

A successful Linux run demonstrates this fixed separate-Webview diagnostic on that target. Windows and both macOS targets still need the same negative/positive native proof. Production artifact content needs a separate viewer integration, narrow lifecycle/message mediation, content/path restrictions, and regression tests against all desktop/plugin/event grants. Authenticated hostile IPC from a child frame is explicitly unproven here. Same-`main` iframe isolation remains unsupported as the migration design.
