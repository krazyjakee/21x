# Private native static artifact viewer

This continuation supplies the native counterpart of the private v1 contract
in `artifact-production.md`. The production desktop API has no viewer operation.
No renderer can submit HTML, a URL, a native label, a title, a profile, or a path
to this owner. Public viewer controls remain unavailable pending a separately
reviewed consumer contract. This is independent of external OAuth identity and
scheme decisions, which remain unchanged.

## Captured snapshot and parent

The private Source producer accepts only task ID, artifact-relative path and the
original trusted caller. The existing ArtifactBackend reads one authorized,
immutable UTF-8 HTML snapshot of at most 128 KiB. It retains the original task,
project, workspace, document and connection checks. Source observes ownership
before raw read/registration, refuses early or repeated open, and retains raw
work and failed cleanup through explicit retry and profile shutdown.

The sealed launch can supply private `artifactViewer` authority only alongside
native UI authority. This capability is not a renderer grant or a public viewer
availability flag. The native host binds one engine epoch and captures the actual
main WebView object and physical document lease during registration. It stores
the actual parent object rather than looking up a replacement main at open.
Register acknowledges reservation; open acknowledges one committed fixed
document, not paint or observation by a person.

Native limits are 16 active leases, 4096 epoch IDs including tombstones, and a
monotonic lifetime of at most 600 seconds. Retire-before-register cannot revive
an ID. Open is one-shot, including unknown outcomes. Parent navigation, native
hide and destruction fence admission synchronously and start owned retirement.
Ordinary parent focus changes do not grant or transfer authority.

## Excluded static document

Each child has an excluded `artifact-<UUID>` label and its own document in an
internal WebView content protocol registered on that exact ephemeral WebKit
context, not Wry's shared persistent runtime context. Initial blank realization
precedes acknowledged native handler installation and the one allowed document
load. The internal transport is not registered as
an OS/app URL handler. Only the exact child label, GET and exact document URI
receive the single snapshot response; aliases, query/fragment paths, other
labels and repeated delivery fail closed. There are no resource routes.

The native owner fixes the title and MIME, disables JavaScript, uses an incognito
WebView, and supplies a fixed sandbox CSP. It permits inline CSS only: script,
images, fonts, media, connections, frames, objects, base URLs and form submission
are denied. Native navigation, popup, download and permission callbacks deny
other effects. The main screen's `frame-src 'none'` and existing main-only
capability file stay unchanged. There is no child-to-app message channel or new
plugin/event grant. Interactive JavaScript artifacts and external resources are
unsupported by this policy.

## Actual retirement

The native owner retains a late created child before any post-await guard can
fail. Cancellation does not abandon raw build, document delivery, destruction
or callback work. Retire fences first, requests destruction, and then waits for
the actual native `Destroyed` event plus all raw work. A successful destroy call
or a missing window lookup alone is not the receipt. Failed cleanup retains the
fenced owner for explicit retry; normal admission closure does not disable
retirement.

The fixed private closed callback contains only viewer ID and one of `closed`,
`parent-retired`, `expired`, or `failed`. Source atomically fences and returns a
boolean claim receipt before scheduling retirement outside that delivery RPC.
Native joins the callback's settlement without claiming that a failed delivery
was accepted. This avoids a retire/delivery join cycle. Source pipe loss/crash
fences native viewer admission synchronously, retains raw destruction cleanup,
and joins it after the existing process-containment cleanup; a GUI delay does
not postpone killing the owned Source process tree.

## Verification boundary

The revision-bound evidence must distinguish actual private Source/profile
controls with synthetic native receipts from the actual separate Wry component
fixture and its excluded executable IPC probe. Neither establishes an installed
all-platform viewer or privileged-main iframe isolation. The static production
child keeps JavaScript disabled; a separate executable excluded probe tests
actual command/plugin/event authorization without weakening that child policy.
The static child's actual sandbox refuses even a native diagnostic JavaScript
evaluation. Hostile loopback image/frame/style/script/navigation requests stay
at zero; a separate excluded no-CSP WebKit resource page supplies the positive
loopback request control. Native hide/reload/destruction, retained closed
callback work, 16-active/4096-ID bounds and retire-before-register rejection are
observed in the actual component fixture.

The native host advertises this private authority only on Linux. macOS/Windows
remain unsupported pending equivalent native and installed proof. HTML byte,
lease and timer limits do not constitute a complete WebKit CPU/resident-memory
bound. Source shutdown, hostile layout/resource exhaustion, installed physical
UI interaction and all supported-platform acceptance retain their explicit
evidence limits. No new public operation/grant, live profile/provider run,
release/cutover, voice enablement or Electron retirement is authorized here.
Hosted Verify remains blocked by disabled repository Actions; no settings change
or workflow dispatch is made.
