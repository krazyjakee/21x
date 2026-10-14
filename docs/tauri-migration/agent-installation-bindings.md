# Portable CLI installation owner

This bounded continuation uses the shipping fixed npm package plans for
`claudeCode`, `opencode`, `codex`, `pi` and `pnpm`. The caller supplies only the
finite target name. It cannot choose a package, executable, URL, argument
vector, filesystem path, environment, shell or elevated installer. Other
known detection targets return a fixed unsupported result with a genuine
current detection snapshot. Missing reviewed npm/runtime capabilities remain
explicitly unavailable. Cursor, system Node/npm/Git installers, vendor
pipe-shell scripts and Windows command-wrapper installation are not enabled.

`PortableAgentInstallationOwner` captures the actual detection owner, trusted
physical home/profile roots, selected standalone Node, immutable finite
environment and optional resolved npm CLI JS resource. The npm target prefix
is exactly `<captured profile>/agent-cli`. The real npm CLI runs directly
through selected Node, with no ambient `npm`, `.cmd` or shell fallback.
The managed cache is below that prefix; registry arguments select the public
npm registry and Unix config arguments point to `/dev/null`, keeping host
`.npmrc` credentials and preferences out of this child path. PATH changes
are private to the captured child environment; Root owns any application
runtime PATH activation/restoration lease.

The global npm vectors retain their existing package names and Pi's existing
`--ignore-scripts` first step. Fixed prefix/cache/config arguments isolate the
new managed installation. Vendor package installation can perform its normal
package lifecycle work; this owner is a process and authority boundary, not
a filesystem sandbox for third-party package code. It does not rewrite
existing external CLI definitions, user MCP settings or unrelated files.

Admission uses Root's actual AgentManager installation fence. The owner
rechecks current caller and profile authority before every filesystem
primitive, process/substep and result/progress publication, and after awaited
work. Runtime/npm file identities, physical roots and known managed parents
are checked before child creation. Manifest reads use bounded no-follow FDs,
regular single-link files, actual fstat identity and before/after receipts;
JSON is capped before parsing. Linked/changed managed roots, programs or
package entries refuse. Same-user changes between a final pathname check and
program execution are not claimed to be atomically excluded on every OS.

Exit zero alone is insufficient. The owner verifies the actual managed
package name/version/bin declaration, a contained physical entry file,
an owned selected-Node `--version` invocation and the real detection owner's
matching installed version. An old external CLI cannot stand in for missing
managed package evidence. Public failures and progress use fixed finite
strings; private output is bounded and never streamed to the renderer.

Pi adds the owned `install npm:pi-mcp-adapter` step through its actual verified
JS entry. It uses the captured managed `.pi-agent` root, verifies the real
adapter manifest, and confirms the MCP flag through an owned `--help` call.
First installation refuses when existing external Pi or nonempty original
Pi configuration would be redirected. Existing user auth, preferences and
extensions are never copied, moved or replaced. Root activates a managed
Pi configuration only after genuine verification. Read-only startup
`verifyManagedPiRuntime` returns null for missing installation/adapter, refuses
malformed claimed metadata, and reconstructs evidence without replaying an
installation. Credential/preferences carryover for external Pi remains open.
An explicit original Pi configuration override different from the managed
root remains unavailable for installation and startup activation, even when
a managed package manifest exists.

One installer operation is admitted at a time. Whole work caps at 150 seconds,
individual child phases at 90 seconds; the aggregate timer covers initial and
final detection, manifests and all Pi substeps. Cancellation/deadline stops
the exact owned live Unix process group and retains actual child plus both
pipe close receipts. Error, timeout, kill request or parent exit alone cannot
release raw work. Group signalling is used while its owned leader is still
live; escaped/independent daemon lifetimes and full supported-platform process
tree containment are not claimed. After leader exit, continued group identity
cannot be proved from a pipe holder alone: the owner refuses signalling a
potentially recycled group and retains blocked raw ownership instead.
A blocked raw close prevents final profile
release. Failed FD/directory closes retain exact handles for explicit drain
retry. Completed request guards cannot be reused. Partial accepted package
effects may remain after cancellation; there is no automatic replay or
invented rollback.

Integration exports are `PortableAgentInstallationOwner`,
`PortableAgentInstallationOwnerOptions`, `PortableInstallationControls`,
`PortableInstallationResult`, `PortableInstallationProgress`,
`PORTABLE_INSTALLATION_PLANS`, `PORTABLE_INSTALLATION_LIMITS` and
`AgentInstallationError`. Methods include `install`, `canInstall`,
`verifyManagedPiRuntime`, `assertOwners`, `shutdown` and `close`, with guarded
home/cwd/Pi-runtime evidence and raw ownership counters. Per-call progress is
limited to five phase messages. Constructor spawn/open seams are trusted
real-I/O test boundaries and are not public capabilities.

Authoring consulted primary sources on 2026-10-14: npm documents the
[global install and prefix options](https://docs.npmjs.com/cli/v11/commands/npm-install/)
and [configuration behavior](https://docs.npmjs.com/cli/using-npm/config/).
Pi documents [personal package declarations and installations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md);
its [package manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/package-manager.ts)
uses the agent npm directory for managed user packages, and
[`--help` handling](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/main.ts)
includes loaded extension flags. These describe the verification premise,
not a live package installation result.

Authored Unix fixtures use actual standalone Node children and real temporary
filesystem/package/version probes. They cover all five plans, managed Pi
registration/restart proof, missing/unsupported capability, old-user config
preservation, exit-zero without evidence, version/adapter mismatch, private
output/overflow, quiet-child shutdown and unrelated-process preservation,
controlled raw child/pipe ordering, late grants/opened FDs, replaced resources
and failed-close retry. Their controlled npm scripts are explicit fixtures;
they do not prove real publisher downloads, package lifecycle behavior,
installed GUI/provider parity or Windows installation. This worker executed
no tests or installation commands. Integrated validation belongs to Root;
full #202/#208/#213 and installed/historical cutover gates remain open.

The production service exposes `agent-installer:install` as a finite retained
command and `agent-installer:progress` as fixed phase data. Native ingress
checks the actual requesting document before private `engine.agent.install`
work and after its response. Public Source ingress cannot manufacture a
lease. Progress uses private `host.ui.installerProgress` and dedicated
`desktop:agent-installation-progress` delivery with matching epoch/document;
it does not use the global desktop event sequence. Missing/retired recipients
suppress progress without redirecting it. Serialized callback acknowledgements
remain within the actual manager mutation lease and service drain ownership.

Exact installation operations have a 180-second transport deadline. Other
operations keep 30 seconds; each fixed private progress callback has five
seconds. Selected live/idle/cached adapters and affected queued/admitted starts
refuse installation before package work. A failed or uncertain accepted
installation retains the backend failure fence; verified success can clear it.
Global, affected-agent and project grants and immutable bindings are rechecked
through all phases without loading stored credentials. The private application
PATH and verified managed Pi root restore only their own current values during
acknowledged shutdown. Bundled-runtime fixtures are registered in the default
standalone suite.

Root verification and limitations are recorded in
[the installation evidence](evidence/issue-closing-20261014-agent-installation.json).
