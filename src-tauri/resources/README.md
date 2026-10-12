The coordinator's `tauri:prepare` script stages ignored runtime artifacts here:

- `node/node` (`node/node.exe` on Windows), preserving executable permissions.
- `service/feasibility.mjs`, copied from `src/service/feasibility.mjs`.
- `service/node_modules/`, with standalone Node native addons (not Electron ABI).

The host uses Tauri's resource directory plus `resources/`, never a system Node
fallback. Native binaries, copied packages, and staged files are not committed.
