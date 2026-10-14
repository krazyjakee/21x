# Captured native suspend inhibition

This Source slice supplies `ProductionEnergyOwner` behind the actual
AgentManager's existing synchronous energy host. It introduces no public
command, event, path, native cookie or caller-selected grant. The production owner constructs
it only for a captured native energy capability, registers its shutdown/drain
before the manager and passes its `host` into that actual manager. Unsupported
hosts remain unsupported rather than acquiring a callback-shaped capability.

The constructor is exactly `{assertCurrent, setActive(active): Promise<boolean>}`.
The callback's boolean describes applied native state: true means active;
false means inactive. Therefore a successful `setActive(false)` release returns
false. An error, malformed result or true result during release cannot be
interpreted as cleanup acknowledgement. The service reuses the existing private
`host.sleep.set {enabled:boolean} -> {enabled:boolean}` contract; it does not
add another private energy route.

`host.start() -> number` returns a monotonically allocated **local intent
ticket**, not an OS blocker ID or proof of applied inhibition. Up to sixteen
logical tickets aggregate into desired active state while any ticket remains.
`host.stop(ticket)` retires only that owner's ticket; foreign, malformed and
already-retired numbers grant no release action. The actual manager retains
its existing session aggregate and background semantics. The manager log
says inhibition was requested, avoiding a claim that pending intent already
became an OS grant.

One serial raw callback reconciles demand. Rapid start/stop coalesces, and an
owned release barrier precedes activation for a new aggregate intent. A denied
activation remains optional and is not retried while the same intent remains.
An uncertain activation is never blindly replayed: the owner follows it with
an owned false request. Healthy release does not permanently close the owner;
later actual session demand may request inhibition again. Failures emit fixed
diagnostics, never raw native/provider error text, and do not stop durable
sessions or request transport reconnection.

`shutdown()` fences new tickets, clears demand and queues final release.
`close(timeoutMs)` joins the actual accepted raw callback and final false;
a bounded timeout does not abandon either receipt. Late true after shutdown
must be followed by false. The trusted cleanup callback retains release
authority after ordinary admission closes; losing owner currentness cannot
abandon an accepted inhibition. Failed release retains unresolved cleanup
ownership and blocks profile release. Only an explicit subsequent `close()`
retries false; successful acknowledged final release makes later close calls
idempotent. `inflightCount` includes retained uncertain/failed cleanup, not
only pending Promise callbacks. The enclosing production owner retains the profile
until actual cleanup is acknowledged, including native-side raw receipts.

The reviewed primary [XDG Desktop Portal Inhibit documentation](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Inhibit.html)
was read on 2026-10-14. Its Inhibit flags distinguish Suspend (4) from Idle (8),
and removal uses `Request.Close` on the returned request handle. This native
slice targets Suspend only. It does not claim display wakefulness, screensaver
suppression, logout/user-switch inhibition or a policy that overrides the
user's desktop. The Source ticket never exposes or substitutes for that native
portal request handle. The Linux binding owns its portal connection and request independently of the renderer.

Authored tests use deferred raw callbacks for aggregation, refused/uncertain
activation, rapid release/restart, one-flight sequencing, late activation after
close deadline, failed/malformed release with explicit retry, captured callback
identity and lost-owner cleanup. A separate real portable SQLite/AgentManager
fixture starts two actual managed sessions with the existing controlled
adapter, verifies one aggregate request, and stops the actual sessions before
final release. It is a controlled backend ownership regression, not a live
model or portal grant claim. Validation results are recorded in the batch evidence. These controlled checks do not establish an installed portal grant.

This is partial #202/#208/#212/#215 progress. Real installed Linux portal
permission/cancellation/suspend behavior, session-bus/host crash recovery,
all supported OS families and complete desktop/background parity remain open.
Hosted voice remains deferred, and no live release/profile cutover is claimed.

The Linux binding opens a private GIO session-bus connection, captures the
portal's unique owner, and registers exact response handling before requesting
Suspend inhibition. It uses an unpredictable request token and accepts active
state only after both the expected method handle and Response 0. Requests use
a fixed reason and empty parent; no caller can supply a bus name, flags or path.
Scope loss, portal loss, cancellation and shutdown retire the owned connection
and join retained callbacks. Release runs before the general work drain, so a
pending permission interaction cannot prevent cancellation. Failed cleanup
retains ownership for an explicit retry; activation is never blindly replayed.

The ownership retirement model follows the pinned portal implementation
[Inhibit](https://github.com/flatpak/xdg-desktop-portal/blob/1.20.4/src/inhibit.c),
[peer lifetime](https://github.com/flatpak/xdg-desktop-portal/blob/1.20.4/src/xdg-desktop-portal.c#L227),
and [request cleanup](https://github.com/flatpak/xdg-desktop-portal/blob/1.20.4/src/xdp-request.c#L283).
Closing this private connection retires only this owner's portal requests.
Protocol acknowledgement and connection retirement do not establish hardware
suspend prevention by the installed desktop backend.
