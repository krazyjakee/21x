# Private native OAuth authority

Issue #215 now has a private per-flow contract agreed with the #216 consumer
owner. This is callback authority infrastructure, not installed OAuth parity.
Global production `oauthBrowser` remains `unavailable`. The production preview admits
private loopback registration/open/retirement; its custom-scheme registration
is refused until app identity and OS registration authority are approved.

`src/shared/oauth-native-callbacks.ts` defines the finite pipe DTOs;
`src-tauri/engine/src/production_oauth.rs` owns native leases;
`src-tauri/src/native_oauth.rs` binds one native owner to its first engine epoch
inside the captured app/profile lifetime. `src/service/oauth-flow-owner.ts`
provides the consumer lease. The retained renderer command/event manifest
does not include these operations. Codes, state and callback URLs never become
renderer events or error messages in this bridge.

| Private operation | Request | Acknowledgement |
| --- | --- | --- |
| `host.oauth.register` | UUIDv4 `flowId`, `kind`, SHA-256 state digest, exact `redirectUri`, captured HTTPS `authorizationUrl`, `ttlMs` | `{flowId, registered:true}` |
| `host.oauth.open` | `{flowId}` | `{flowId, opened:true}` after the raw OS opener returns |
| `host.oauth.retire` | `{flowId}` | `{flowId, retired:true}` after raw open/delivery receipts settle |
| `engine.oauth.callback` | `flowId`, `kind:"custom-scheme"`, exact `redirectUri`, `state`, discriminated `outcome` | `{accepted:boolean}` immediately after Source validation and atomic claim |

`outcome` is exactly `{status:"code",code}`, `{status:"denied"}` or
`{status:"failed"}`. Native parsing discards provider `error_description` and
`error_uri`; it never forwards arbitrary provider errors. Code and error are
mutually exclusive. Duplicate fields, foreign schemes/paths, malformed percent
encoding, fragments, controls, unexpected fields and oversized inputs fail
before consuming a matching lease. A denial consumes its lease without any
token redemption. Delivery acknowledgement does not await exchange,
persistence or native retirement: doing so would create a delivery/retirement
join cycle. A Source-owned waiter performs those operations separately.

Registration precedes browser opening. The native owner checks the captured
HTTPS URL's unique state and redirect fields, verifies the state digest and
opens that exact URL once. The native launch also rechecks the physical current
main document, native work admission and engine epoch immediately before the
OS effect. `opened:true` acknowledges the opener handoff, not browser visibility
or browser exit; the app never kills an existing browser.

The consumer captures its provider, source/instance, configuration, intent,
storage choice and authorization fence in an application-owned closure. A
callback supplies no provider/source/connector IDs. Source rechecks that fence
at registration, opening and delivery, consumes pending state before resolving
its waiter, and must independently recheck it before credential persistence.
The legacy `OAuthManager.exchangeCode(providerId,code,state,sourceId)` is not
this private callback contract and is not called by the bridge. Its existing
binding/replay limitations remain a consumer migration prerequisite.

The Source SDK's optional synchronous `onOwnedLease` registration observer
publishes a frozen lease before awaiting raw registration. A consumer that
owns extra admission records that lease for cleanup even if the post-ack scope
check and native retirement both fail before `register` can return. The
observer only records ownership; `open()` refuses until native receipt
validation and the post-ack scope check succeed. Observer failure also cancels
and joins cleanup. Failed retirement retains the specific lease and admission
for retry; a connector never closes the parent SDK or unrelated flows. This is
a Source-only API addition, with no native DTO or wire change.

Loopback is a separate discriminator. Todoist keeps its current listener and
exact `http://localhost:3000..3010/callback` redirect URI. It receives native
register/open/retire receipts, not custom-scheme delivery. The #216 consumer at
`ee426b76` captures this authority during runtime construction. Only its
connector binding derives browser availability from that captured runtime;
MCP/Linear retain unavailable global browser capability. Source keeps PKCE,
provider/config/storage intent and its instance/scope/cancellation prewrite
fence. Controlled real-listener/SQLite tests do not establish an installed
browser or actual provider account flow.

Both owners admit at most 16 active leases with a maximum five-minute TTL.
Native retains at most 4096 issued/retired IDs and state digests for its
lifetime, refusing new registration at the ceiling instead of evicting replay
protection. Retirement also reserves an ID whose registration has not arrived:
a delayed registration cannot recreate a flow after its close acknowledgement.
At the permanent ID ceiling, unseen registrations are already refused, so
unknown retirement can acknowledge without growing the registry further.
Registration, raw opener calls and native retirement stay owned across public
timeouts. Stop fences new admission/delivery synchronously; retirement remains
available and failed close retains ownership for explicit retry. A fresh process
has no pending PKCE/source intent: callbacks from the previous process are
rejected. There is no durable cold continuation or token-mutation reconstruction.

## Identity decision required

The current preview identifiers remain configurable Tauri build configuration:
`com.krazyjakee.21x.tauri-feasibility` and
`com.krazyjakee.21x.tauri-production-preview`. Neither is selected as the final
application identity. Electron currently uses `com.krazyjakee.21x`, primary
scheme `twentyonex` and legacy scheme `nuanu`.

The user must approve either retaining the existing application ID and schemes,
with an explicit installer/handler ownership transfer, or a distinct final Tauri
ID and a separately approved scheme/provider registration migration. Retaining
the existing ID and `twentyonex` with `nuanu` read compatibility is recommended
to preserve registered provider redirect URLs. This recommendation does not
authorize a handler transfer, installation or cutover. Preview builds must not
automatically steal either installed Electron scheme.

## Linux callback ingress

The production Linux host installs the pinned single-instance plugin before
other plugins and Source/profile startup. The helper is published at
`a3a84fed`; the serialized host hook is published with #208 at `75cce3ad`.
Its transport uses the session bus only. The configured build identifier is
hashed into an unambiguous valid
D-Bus name; numeric segments in the existing preview identifiers cannot be used
as literal D-Bus name segments. No final identifier is chosen by this mapping.
The plugin's optional deep-link feature is disabled, and no plugin IPC grant
or global callback event is introduced.

The native callback accepts exactly an executable argument and one bounded,
strictly parsed `twentyonex://oauth/callback` or `nuanu://oauth/callback` URL.
Executable name and working directory confer no authority. Extra arguments,
unrecognized query fields and malformed callbacks are refused. A running owner
requires its captured engine epoch, open native work admission and a matching,
opened, unexpired, unconsumed native lease before sending bounded callback
fields through the private Source channel. A raw delivery permit remains owned
until that private claim RPC settles; retirement joins it. Untrusted same-user
bus clients can call the transport but cannot select a provider/source or
redeem a foreign nonce. Parser bounds apply after D-Bus decoding; they do not
bound all transport allocation.

A first process given a valid callback argument reports only the fixed native
diagnostic `PRODUCTION_OAUTH_FRESH_CONNECT_REQUIRED`. It does not queue or
reconstruct a previous process's lost PKCE/intent. The user must start Connect
again. This diagnostic is not an installed user-interface notification.

The actual plugin and D-Bus method are exercised under `dbus-run-session` in a
bounded subprocess with Tauri's MockRuntime and synthetic leases. The regression
proves warm forwarding, current and legacy URI parsing, denial sanitization,
foreign/multiple/extra-field rejection, one-shot claims, stop fencing and no
public deep-link event. It does not launch an installed Wry application or
complete a real provider/credential flow.

The pinned plugin permits ordinary startup if the session bus is unavailable.
Therefore installing this hook is not an attestation of available callback
routing. Custom-scheme registration remains refused by the production native
owner; future enablement needs both approved OS registration and positively
established transport authority. macOS and Windows do not install this plugin
in this slice. In particular, the plugin's macOS temporary-socket transport is
not adopted as an approved bounded callback authority.

The [retirement fence and consumer integration evidence](evidence/batch35-215-oauth-retirement-fence.json)
records the reproducible pre-fix native failure, verified repair, own checks
after #216 publication, test ELF checksums and remaining acceptance gaps.

## Remaining acceptance

OS scheme registration, installed warm/cold routing under the approved identity,
and an integrated real provider consumer/credential path remain unproven. The
isolated Linux transport regression is not installed OS-handler evidence. No
deep-link plugin, global callback event or scheme registration is introduced.
Source/MCP/Linear consumer migration, approved registration authority and
installed provider acceptance must precede enabling global `oauthBrowser`.
The #216 local loopback consumer is delivered; its installed real-provider
acceptance remains open. Durable encrypted cold continuation, if
required instead of rejecting stale flows and requiring Connect again, needs
its own approved design.

Installed desktop permission/navigation behavior and supported macOS/Windows
production services remain open under #215/#208/#202. Hosted Verify and packaged
platform workflows are unavailable: repository Actions is disabled pending a
user decision. No settings endpoint is changed and no workflow is dispatched.
