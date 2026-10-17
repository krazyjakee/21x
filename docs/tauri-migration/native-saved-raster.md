# Saved attachment raster previews

This #214/#215 continuation adds the optional native-only typed operation
`attachments.readImage(taskId, attachmentId)`. It returns exactly
`{ mimeType, data }`: PNG/JPEG/GIF/WebP and canonical base64. The arguments are
literal database task IDs and UUID attachment IDs. No URL, filesystem path,
filename, callback, renderer lease or provider ID is accepted.

## Native and Source admission

The general production raw `app-attachment` scheme remains unregistered. A
label-only custom URI handler cannot distinguish an old physical document from
its replacement. The native ingress instead checks trusted main label/origin,
current physical document, engine epoch and current admission; it stamps the
private `engine.attachment.image` request and repeats the checks after the raw
Source response. The Tauri transport also requires its exact current document
receipt and rejects a late response without replay.

The sealed Source captures existing `attachmentFiles` and `ui` host authority;
unsupported platforms remain unavailable. No new bootstrap capability or global
filesystem permission is added. The catalog explicitly marks this as a reviewed
native-only addition with no invented Electron IPC/preload evidence. Existing
operation policies remain unchanged. The public Source registry cannot bind the
native-only operation or accept a renderer-selected lease.

Source captures current task/project/agent and group/former/anchor ownership,
read grants and exact saved attachment metadata. Read-only previews do not join
lifecycle mutations, append metadata, open an external viewer or read unrelated
full task/agent credential records. Sixteen owned requests are allowed, with one
serial file read; queued cancellation stays owned through the preceding raw
work. Before opening, before/after each 64 KiB read, and before returning, Source
obtains the native UI snapshot and requires the original lease. Source scope is
rechecked after every such wait and filesystem wait. A new document is never
substituted for the original one.

The existing protected attachment owner opens the literal saved namespace with
no-follow/symlink/hardlink/ancestor/size/version controls and holds the actual
file descriptor. It reads at most 512 KiB, checks the held descriptor and named
file again, and closes the actual descriptor before accepting bytes. Cancellation
or document/grant/metadata/owner changes withhold the result. Raw native
snapshots, reads and close failures retain ownership, so a failed drain keeps
the Source database/profile for explicit retry.

## Raster bounds and consumer contract

Source and the native facade independently require the same full container
admission before any browser image decode: maximum 4096 pixels on either edge,
8,388,608 total canvas pixels multiplied by frame count, at most 32 GIF frames,
4096 container blocks and 64 JPEG scans. Canonical base64 is bounded to 512 KiB
decoded. The native engine separately checks the exact finite wire envelope,
mime allowlist, byte ceiling and canonical padding; it does not decode a raster.

PNG requires a complete IHDR/IDAT/IEND chain and finite permitted metadata.
APNG and compressed/unknown PNG metadata remain unavailable. JPEG admits bounded
8-bit baseline/progressive frames and rejects extra frame/DNL/hierarchical
redefinition. GIF bounds the logical canvas, every image rectangle and total
frame canvas pixels. WebP requires a consistent RIFF canvas/VP8/VP8L image;
animated WebP is unavailable. SVG/HTML and malformed or unsupported containers
have no path/URL fallback. These checks admit headers/containers, not entropy or
CRC correctness; the platform decoder may still refuse malformed image content.

Layout references: [PNG Recommendation](https://www.w3.org/TR/png-3/),
[JPEG T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf),
[GIF89a](https://www.w3.org/Graphics/GIF/spec-gif89a.txt), and
[WebP RIFF container](https://developers.google.com/speed/webp/docs/riff_container).

Engineer A owns Markdown/UI integration: exact legacy attachment-ID parsing,
optional-operation support, bounded concurrent/resident previews, host/component
and connection-generation capture, stale-result refusal and retirement of data
URLs. Electron URL behavior remains unchanged. Native legacy hyperlinks must
use existing explicit Open/Download controls rather than raw scheme navigation.
Backend/facade proof alone does not establish installed Markdown viewer parity.
Native drag/drop, group/Captain file import metadata append, protected orphan
reconciliation and platform/installed acceptance remain open.

Hosted Verify unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings changes,
workflow dispatch, app identity/scheme choice, live profile or release is made.
