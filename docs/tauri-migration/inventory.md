# Electron source inventory

Run `node scripts/tauri-inventory.mjs` from the repository to refresh
`docs/tauri-migration/inventory.json`. Run with `--check` to fail when that file
is missing or differs from current source; `--stdout` prints a concise summary
without writing. Use `--check --stdout` for a freshness check with summary.

The scanner reads source files under `src/main`, `src/preload`,
`src/renderer/src`, `src/shared`, and `src/mobile` once each. It skips tests,
declarations, generated/build/dependency/fixture directories, and symlinks.
TypeScript AST parsing ignores comments and string contents; it does not run a
compiler, load native addons, or resolve dependency trees. Output uses sorted
paths/references/object keys and contains no timestamps.

It records Electron imports/re-exports (including type-only bindings), IPC
registrations/invocations/listeners, guarded sends, structural webContents/sender
sends, maximal direct `window.electronAPI` accesses, and JSX `<webview>` elements.
Named/namespace imports, local and destructured aliases, commonJS require, and
import-equals bindings are followed within lexical scopes. Function parameters
and block declarations shadow aliases; reassigned aliases are discarded.
Direct Electron `WebContents` type annotations and their `Pick`/`Omit` wrappers
identify additional send candidates without requiring a type checker.

Literal strings, local literal constants/concatenations, and repository-local
imported constant maps resolve channel names. Exact reviewed producer forms in
`EVENT_WRAPPERS` also record agent, updater, scheduler, voice, task API and
mobile API event callers; arbitrary same-named methods in other files are not
treated as IPC. Computed methods, dynamic templates and generic forwarding
remain explicit unresolved records. Visible local constant-object writes
invalidate further resolution; this remains syntactic analysis rather than
evaluation of runtime mutation or control flow. API consumer
paths use `null` for computed segments. Each reference includes a source line
and column; repeated identical references are deduplicated.

Package identity, declared dependency ranges, packaging resource patterns,
platform targets, and the AST-derived database schema version accompany the
references. The native dependency list identifies the known SQLite/PTY addons
rebuilt by the repository script; it does not verify installed binaries, ABI
compatibility, or discover every transitive native dependency.

This is a syntactic inventory, not a permission proof or complete runtime call
graph. It does not trace API aliases, re-export chains, arbitrary control flow, wrappers outside
the recognized forms, generated code, dynamic imports with computed specifiers,
or actual resource existence. Structural webContents/sender matches require
review of their runtime types. Use unresolved rows and source references to
guide the bridge/host audit, then validate behavior and permissions separately.

The [ownership audit](ownership-audit.md) assigns the observed channel
families and records the historical fourteen-reference review. Generic
forwarders remain visible rather than becoming a wildcard allowlist.
[Desktop contracts](desktop-contracts.md) generate explicit operation
ownership, declaration types, argument transformation evidence and removed
browser dispositions; their manifest is not a permission grant.
