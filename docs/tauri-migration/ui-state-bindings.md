# Production UI state and command ownership

This slice binds `ui:publishState` to the actual protected database,
AgentManager and `ProductionUiOwner`. It retains the existing
`UiStateSnapshot` and undefined command result. The public request is exactly
`{state}`. A native-established `DesktopCallerContext.uiLeaseId` associates
publication with the current main document; a state payload cannot supply a
lease, availability, timestamp, owner or authority grant.

The borrowed native host exposes `snapshot()` and
`send(command, leaseId, signal)`. Missing/hidden windows report
`{available:false}`. A visible current document reports a bounded opaque
ASCII lease. Delivery returns `{ok:true,leaseId}` only after actual native
emission acceptance, or `{ok:false,detail}`. Failure detail is bounded and
replaced with a fixed public explanation. This acknowledges intent, without
claiming that the renderer applied it. The native host targets its exact
current document; Node does not also broadcast a generic UI event.

The owner refreshes the native lease before publication, every cached-state
read and every delivery, then again after delivery. Missing or changed leases
clear the published cache. Older asynchronous lease responses cannot restore
an earlier document. Task API commands derived from a published canvas carry
the trusted observed lease internally, so a reload cannot redirect those
premises into a replacement document. No accepted or uncertain command is
automatically replayed.

Publication requires independent current publish, task, project and agent
read grants. Root supplies separate immutable system callbacks for state
reads and command delivery. Reference checks select bounded scalar SQLite
fields before materialization; they do not deserialize task descriptions,
agent credentials or project configuration. Current-project visible tasks
and canvas task panels must belong to that project. Selected and previewed
tasks also require their actual current project and assigned-agent grants.
Panel IDs remain UI identifiers, never inferred agent aliases.

Production task API routes use the registered owner and real native
acknowledgement instead of the Electron notifier. Supplied signed task scopes
are checked out of band before and after native awaits. Task-only and
artifact-only scopes cannot expose sibling cached selections or panels;
parent scopes retain parent/sibling boundaries and project Captains retain
their project scope. Agent/nonce bindings are reread when present. Ordinary
trusted internal full scope keeps its established defaults. Without a
registered production owner, the legacy Electron state setter and notifier
keep their original behavior.

`open_artifact` checks the actual bounded workspace registration around its
asynchronous read before delivery. The synchronous command-reference helper
validates literal task scope and the registered-artifact ID grammar; it does
not invent a database artifact registry. Future senders must perform the real
registration check. The current Commander sender only switches projects.

Both codecs are browser-pure and finite. Publication has eleven exact fields,
at most fifty unique visible task IDs and fifty unique panels, 4,096 UTF-16
title limits, finite known views/modals/settings tabs/panel types, bounded
coordinates/dimensions and the existing zoom range. Request bytes cap at
256 KiB. NUL, malformed Unicode, unknown keys and public lease fields refuse.
Passive historical browser/webpage panel metadata remains readable; no such
creation or control command exists. The public `ui:command` event retains the
seven existing intent variants.

Shutdown fences admission and aborts request signals. Ignored cancellation
does not release accepted native callbacks: owner/backend close retains and
joins the actual raw promises, refuses a timed-out drain, and supports a later
drain retry before profile release. Late replies cannot publish state or
export a stale command result. No real OS window is opened by unit fixtures.

Authored regressions use the real portable SQLite manager and AgentManager
with controlled native boundaries: hidden/replaced documents, native
acknowledgement, rejected/private results, caller revocation, task movement,
signed scope/nonce changes, malformed publication, large legacy JSON without
getter materialization, ignored cancellation and shutdown retry. The [integrated verification record](evidence/issue-closing-20261014-ui-state.json)
records coordinator checks and their exact scope. Installed interactive WebView, window/tray services, supported-target
behavior and full migration/cutover acceptance remain open.

Native bootstrap captures the actual OS window handle and its attachment ticket;
label equality does not establish identity. Tauri `raw-window-handle` 0.6.2 is
now an explicit optional production-feature dependency using the existing locked
package and checksum. No package version, runtime pin or OS plugin changes.
Native intent uses the dedicated `desktop:ui-command` envelope
`{engineEpoch,leaseId,command}`; it does not consume the Node event sequence.
The renderer captures this lease from bootstrap, supplies it separately only for
state publication, and disposes its document listener across reconnect/closure.
Ambiguous overlapping or cancelled page-load sequences may leave UI commands
unavailable until an unambiguous completion or window recreation; they cannot
activate an uncertain generation.
