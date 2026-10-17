# Private native OAuth authority

Issue #215 now has a private per-flow contract agreed with the #216 consumer
owner. This is callback authority infrastructure, not installed OAuth parity.
Production `oauthBrowser` remains `unavailable`. The production preview admits
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

Loopback is a separate discriminator. Todoist keeps its current listener and
exact `http://localhost:3000..3010/callback` redirect URI. It receives native
register/open/retire receipts, not custom-scheme delivery. Connector integration
remains owned by #216; its existing instance/scope/cancellation prewrite fence
must remain in place. This slice does not replace that listener or enable the
connector browser capability.

Both owners admit at most 16 active leases with a maximum five-minute TTL.
Native retains at most 4096 issued IDs/state digests for its lifetime, refusing
new registration at the ceiling instead of evicting replay protection.
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

## Remaining acceptance

OS scheme registration, native warm single-instance forwarding, cold-launch
ingress/queue retirement, and an integrated real provider consumer/credential
path remain unproven. The authority's warm parser/claim tests are not OS routing
evidence. No deep-link plugin, global callback event or scheme registration is
introduced. End-to-end Source/MCP/Linear and #216 connector consumer migrations
must precede enabling `oauthBrowser`. Durable encrypted cold continuation, if
required instead of rejecting stale flows and requiring Connect again, needs
its own approved design.

Installed desktop permission/navigation behavior and supported macOS/Windows
production services remain open under #215/#208/#202. Hosted Verify and packaged
platform workflows are unavailable: repository Actions is disabled pending a
user decision. No settings endpoint is changed and no workflow is dispatched.
