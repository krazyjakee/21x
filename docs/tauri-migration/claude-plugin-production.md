# Production Claude plugin controls

This domain supplies the eleven retained Claude plugin marketplace controls:
source list/add/remove, catalog fetch/discovery, installed list, install,
uninstall, enable, disable and resource metadata. Registration uses exact names
and bounded codecs; it is separate from caller and resource authorization.
This is scoped progress for #213, not installed production parity, a live profile
migration or release authorization.

The backend borrows the actual plugin manager, DatabaseManager, AgentManager
and SyncManager from the production owner. No second manager or downloader is
constructed by the production binding. Native WebView/origin/epoch identity and
live singleton ownership precede access. Marketplaces, names, installed IDs,
source transport/local-root authority and affected skill/MCP/agent/source/task/
project scopes are independent grants. Renderer arguments cannot supply a
resource path, DB owner, authorization envelope or arbitrary manifest.

Public rows keep the existing DTO shapes but omit marketplace private metadata,
headers, environment values, credential fields, agent prompts and executable
arguments. Local marketplace paths use a fixed opaque marker. Installed
manifests expose reviewed descriptive fields only. Authors normalize to names;
legacy named command objects normalize to bounded display names. Unsupported
or oversized legacy rows remain stored and return a fixed failure rather than
being truncated into a successful operation. Mutation scope currently supports
user installation only, because an unqualified project scope carries no project
authority.

Marketplace source removal refuses installed references instead of triggering
the current installed_plugins foreign-key cascade. Historical shared directory
or resource-name collisions are preserved and require explicit reconciliation.
The actual downloader retains private staging, containment/symlink checks,
bounded bytes/depth/count/redirects and cooperative atomic publication. Existing
files are not claimed as owned data by the production binding. Cooperative
publication locking is not an adversarial no-replace rename primitive.

Runtime mutations must use the actual lifecycle owner and authorize the planned
contained resources before filesystem publication or DB materialization. Scope
and exact resource/reference snapshots are rechecked after asynchronous joins.
Raw catalog/download work remains owned after caller cancellation or public
failure. Accepted mutations are never replayed on reconnect; unsuccessful drain
requires retaining database, credentials and filesystem ownership. No transport
or native browser/MCP capability is enabled by a plugin installation.

The actual AgentManager resource mutation guard acknowledges accepted Stop,
joins queued/start/send work and refreshes affected cached adapters. The root
production owner composes this with Chat/Commander/provider/scheduler leases.
Relevant SyncManager source leases drain raw imports/exports before resource
changes. Existing resource namespaces must be empty before download; owned MCP
provenance, skill tags and duplicate resource names are checked before destructive
operations. Referenced resources, sources, tasks, groups, projects, fallback or
default agents conservatively prevent uninstall instead of cascading data.

Catalog/discovery/install callbacks check current caller/scope at every initial,
redirect and nested request address. Discovery passes only authorized source IDs
to the actual manager. Public cancellation retains the real manager/download
flight until reader/response/staging cleanup completes. Reconnect has no mutation
replay. Planned writes cap each resource kind at 128 to match the actual mutation
guard. Task skill JSON is bounded and validated before affected-owner projection; historic public reads cap arrays at 256. Larger datasets remain explicit
unsupported bounds rather than being silently truncated.

Authored suites use portable SQLite/schema, authenticated credential encryption,
the real ClaudePluginManager and downloader on isolated synthetic local trees,
actual resource materialization and AgentManager/SyncManager ownership with a
controlled coding adapter. Cases cover public projections, namespace/provenance,
foreign resource scope and FK preservation, lifecycle Stop/refresh, symlink
containment, endpoint redirection grants, cancellation/drain and bounded legacy
rows. They do not execute downloaded tools or live model/marketplace accounts.

The coordinator owns the final execution and evidence. The implementation worker
does not run tests/builds/checks. Packaged supported-target acquisition,
representative retained marketplace/CLI/plugin integration, containment proof
and remaining #213 workstreams require their stated independent evidence.
Hosted issue #92 remains deferred.
