# Platform minimum review

Reviewed 2026-10-13 for [#206](https://github.com/krazyjakee/21x/issues/206), D1/D7. This separates component requirements, tested build environments and the product support decision. It does not accept new minimums or change packaging configuration.

## Pinned source and tested builders

The source pins Tauri 2.12.3, tauri-build 2.7.2, CLI 2.12.2, Node 22.23.2, SQLite 13.0.3 and node-pty 1.1.0. Rust 1.90 is declared by the workspace; the native workflows install 1.98.0. The CI matrix uses macOS 15 Intel, macOS 14 arm64, Windows Server 2022 x64 and Ubuntu 24.04 x64. Those are builder/test environments, not a customer OS compatibility promise.

Node's tagged platform table gives these component floors and separately excludes vendor-EOL platforms. These values alone do not cover the native host, addons or renderer. [Node 22.23.2 build/platform contract](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md).

| Requested target | Node component table | Remaining compatibility evidence |
| --- | --- | --- |
| macOS x64 | macOS 11 or later | Host/addon deployment targets, WKWebView APIs, installer and signed-store behavior on the chosen oldest supported OS |
| macOS arm64 | macOS 11 or later | Same checks on actual arm64; Intel/Rosetta execution is not a substitute |
| Windows x64 | Windows 10 / Server 2016 or later | Chosen client OS, WebView2 version/installation policy, clean/offline install, addons, PTY and job ownership |
| Linux x64 | Kernel 4.18 and glibc 2.28 or later | Actual host/addon symbol requirements, WebKitGTK/system libraries, media/PTY behavior and installed execution on the chosen oldest distribution |

Tauri's prerequisites identify WebView2 on Windows and WebKitGTK 4.1 development packages on Linux. Its generic prerequisites are not this application's complete runtime floor. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Microsoft lists Windows 10/11 and supported Server variants for WebView2; a Server 2022 runner does not exercise the selected customer client OS. [Microsoft WebView2 supported Windows versions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/).

The Linux builder requires particular attention: Tauri recommends building AppImages on the oldest supported base with the required WebKitGTK packages, with Ubuntu 22.04/Debian 12 as examples. A newer builder can introduce newer glibc symbol requirements. **Inference for this repo:** successful Ubuntu 24.04 packaging cannot establish Ubuntu 22.04/Debian 12 compatibility. The final support range needs an accepted build base and actual installed evidence. [Tauri AppImage compatibility guidance](https://v2.tauri.app/distribute/appimage/).

## Concrete acceptance work

1. Choose supported customer OS releases/security-maintenance policy, separate from architecture coverage and CI runner labels. Record the decision in D7.
2. Inventory deployment targets/symbol requirements for the packaged host, Node, selected native addons and PTY helpers. Verify every binary's architecture and loader dependencies; inspect installed artifacts rather than only source/toolchain declarations.
3. Run the current renderer API/CSP/permission, approval/reload, terminal/worker and required media flows on the chosen oldest OS/WebView. Include a current supported version as well.
4. Decide Windows Evergreen/fixed WebView2 distribution and offline/missing-runtime behavior. Record actual WebView2 versions in installed evidence.
5. Select the Linux build base and inspect/test the resulting AppImage on the lowest supported distribution. A successful newer distribution does not replace this test.
6. Set macOS deployment/installer metadata to the accepted range and verify the host and every bundled binary agree. Clean-machine, signing/credential access and native permission tests remain required.
7. Retain the complete upstream/runtime/dependency notices in the actual package and validate redistribution inventory for each platform. The notice generator and existing package evidence are preparation; final release resource/signature audits remain #221 work.

The installed synthetic-agent/artifact matrix is useful scoped feature evidence on its recorded runners. It cannot close #206 without this support/build-base decision and lowest-version evidence. No unsupported older-OS compatibility claim follows from a Tauri or Node headline minimum.
