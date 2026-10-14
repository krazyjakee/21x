# Native workspace file authority

`NativeWorkspaceFileOwner::open(PathBuf)` receives the workspace root from trusted native bootstrap. It captures metadata-only descriptors for every literal absolute directory from `/` through that root before accepting a Node receipt. The root must already exist and use a normalized absolute UTF-8 path. Symlink aliases and non-directory root ancestors are refused. The production host owns lifetime, current-main caller and engine-epoch authorization; a receipt does not supply those grants.

`NativeWorkspaceReceipt::from_value(&Value)` accepts only the version-1 Node receipt: `taskId`, `workspaceRoot`, absolute target `path`, `root`, ordered `ancestors`, and `target`. Identity records have exactly `path`, `dev`, `ino`, `kind`, `size`, and `nlink`. Numbers are canonical unsigned decimal strings within `u64`. Each path is bounded to 4096 UTF-8 bytes, with no controls, aliases, empty components, or dot traversal. The root absolute chain is bounded to 64 directories, and depth below the literal task directory and receipt ancestors are independently bounded to 64. The target lies under the literal `workspaceRoot/taskId`. Ancestors include the task directory through the target parent, excluding the workspace root and target. A task-directory target has no ancestors and must be a directory.

`owner.validate(&receipt)` opens each component relative to a retained descriptor, using Linux `openat` with `O_PATH`, `O_NOFOLLOW`, `O_CLOEXEC`, and `O_NONBLOCK`, plus `O_DIRECTORY` for directories. Linux ignores ordinary data-open flags for `O_PATH`; these handles cannot read file data or activate substituted FIFO/device data streams. Descriptor metadata rejects symlinks, special files, and hard-linked regular files. Files require exact device, inode, size, and a link count of one. Directories require matching device, inode, and kind; their changing size/link metadata does not invalidate harmless content edits.

The returned `NativeWorkspaceFileGuard` holds the trusted owner and exact root, task ancestor, and target handles. `guard.path()` supplies the already-validated absolute path. The host calls `guard.recheck()` immediately before the real OS opener/reveal invocation and retains the guard for the actual blocking API call. Rechecks verify both retained metadata and the current literal path chain, including absolute parents above the root. Replacement, missing paths, links, or file-size changes return fixed path-free errors. Other platforms explicitly return `WORKSPACE_NATIVE_UNAVAILABLE` until an equivalent descriptor authority is reviewed.

This narrows the authority of the native invocation; it does not make later reads by an external application atomic. External application lifetime remains independent. Same-inode, same-size edits are not detectable from the receipt fields. No file contents are read by this native owner. Inline Linux tests use real temporary files and descriptors for replacement, symlink, hard-link, FIFO, scope, parser, retention, and harmless directory-edit cases. They do not invoke an OS opener or claim cross-platform acceptance.

The production descriptor optionally advertises `workspaceFiles: 'host'`;
absence means unsupported. Exact private callbacks are
`host.workspace.openPath` and `host.workspace.showItemInFolder`, with only a
bounded `{receipt}` payload and empty acknowledgement. These callbacks are
separate from renderer-facing service admission. Native work is limited to four
actual invocations, and each worker rechecks the current main window and engine
epoch before any filesystem or opener work. Native callback drain joins all
accepted work and then drops the captured root/parent descriptor owner before
acknowledging Node's protected-profile release. No direct opener plugin or
generic path permission is given to a WebView. The integration retains the
existing [pinned opener release](https://tauri.app/release/opener/v2.5.4/);
no dependency or Cargo lock change is required.
