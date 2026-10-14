# Captured production CLI MCP configuration

The six retained controls (`snapshot`, `upsert`, `remove`, `setEnabled`,
`setToolEnabled`, `probe`) use the actual `CliMcpConfigManager` and the Claude
Code, OpenCode and Codex stores. Production imports the host-neutral `core.ts`.
The existing `index.ts` remains the Electron compatibility wrapper with its
lazy default probe and existing ambient file behavior.

`CliMcpFileOwner` captures a real approved home and constructor-selected config
paths: Claude's two files, OpenCode's JSON/JSONC or explicit environment path,
and Codex's config path. Supported trusted overrides are `OPENCODE_CONFIG`,
`XDG_CONFIG_HOME`, and `CODEX_HOME`. Requests cannot choose a path or environment.
Invalid/relative overrides or unsafe selected ancestors leave config operations
explicitly unavailable; they do not fall back to another writable file or stop
unrelated application services. Aggregate byte preflight occurs on operations,
so an oversized historical file does not fail the application's constructor.

Reads use actual no-follow FDs and compare named/opened/final physical identity,
mode, size and timestamps. Every file is limited to 256 KiB, and all four files
together to 512 KiB before JSON/TOML parsing. JSON syntax indexing limits depth
to 64 and nodes to 32,768, refuses ambiguous duplicate keys, and keeps BOMs,
comments and unknown sections. Portable JSON edits change only affected syntax
spans. The TOML store preserves unrelated table bytes and keeps comments and
unsupported lines in rewritten MCP blocks; understood values in those blocks
may be reformatted. Legacy OpenCode serialization retains its prior behavior.

Publication uses an exclusive sibling scratch file, actual partial-write loops,
mode preservation, fsync and byte/identity verification. The complete original
file is re-read and compared immediately before publication, including changes
outside the UI's MCP fingerprint. Unknown sections and saved env/header
credential values are retained. Concurrent edits, symlinks, devices, hardlinks,
changed parents, and aggregate-growth violations refuse publication. Actual FD
close failure blocks publication and stays owned for explicit close retry.
Changed/unproven scratch data is conservatively retained; an operator can remove
that retained scratch before retrying close. These Node namespace receipts do
not establish atomic cross-platform `openat` containment against same-user races.

The wire contract is finite and browser-pure, references `DesktopCommandMap`,
and retains the existing snapshot/mutation/probe result shapes. Names/tools are
bounded to 128 UTF-16 units, paths to 4,096, args to 128 × 4,096, env/header
entries to 128 × 16,384, servers/tools to 128, and public JSON to 900,000 UTF-8
bytes. NULs, malformed Unicode and prototype keys are refused, including names that
normalize to reserved keys during upsert. Read, mutation,
per-CLI and probe grants are separate; mutations also require read grants for
the complete returned snapshot. Store/probe diagnostics use fixed public text,
while genuine tool names/descriptions and conflict fingerprints remain useful.

Existing secret-looking env/header fields use the established masked marker;
unchanged markers retain a real nonempty saved value, and new secret-looking
values become environment references rather than newly written plaintext.
Missing/wrong-entry markers refuse before write. Stored URL userinfo/query/hash
parts are removed from public snapshots. Those saved entries refuse upsert,
since the public representation cannot safely roundtrip their private parts;
toggles/remove retain their existing store semantics. New remote URLs refuse
these parts. The original bytes remain available to the external CLI/user.
This preserves the existing credential convention; it does not invent a secure
storage format for credentials embedded in commands or arbitrary argument text.

Probes borrow the actual captured `McpProbeService`. Scoped guards apply before
each spawn, protocol write, fetch, response read and after awaited work. The
backend checks both the resolved actual transport input and every original
referenced source variable, including aliases into different destination keys.
Reserved/private launch variables are excluded by the production host. A supplied stale MCP fingerprint refuses before the first probe effect. Config
file hashes are rechecked throughout the probe, so stale discoveries cannot
update cache after an external edit. Portable probes refuse redirects and
implicit shell inference; Windows cmd/bat execution remains unavailable pending
reviewed host escaping. A user server named `task-management` receives no
implicit application token. Public timeout/cancellation does not release the
actual child/response cleanup receipt; manager/backend close joins it, and no
probe or mutation is automatically replayed.

Production supplies the actual optional configuration-mutation lease to fence
affected agent starts/live configuration and join actual notifications. The
backend calls it for exactly four file mutations inside the manager/file guard.
Snapshot/probe remain reads. Cached selected adapters require a real
`notifyConfigChanged` acknowledgement; OpenCode currently supplies it. A cached
Claude Code or Codex adapter without that capability refuses before file effects.
Cold adapters may apply changes and load their configuration on their next real
start. The manager never substitutes an implicit stop or a fabricated refresh.
Retired inherited scopes cannot reuse old grants.
Root registers the manager, file and probe drains before releasing the profile.

Authored tests use real temporary files/FDs and all three stores, bounded
JSONC/TOML fixtures, captured owner grants, controlled HTTP response streams,
and an actual local Node JSONL child with explicit unrelated-child preservation.
They cover all six controls, malformed/oversized legacy bytes, conflicts,
credential retention, ignored cancellation, failed close retry, grant/config
races and inherited-scope retirement. No live user CLI config, provider network,
installed platform, or validation result is claimed. Full #202/#208/#213
installed/historical cutover and integration acceptance remain open.
