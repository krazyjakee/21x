# Protected saved attachment execution

This #214 continuation gives the production AgentManager a private Source
attachment copy/preview owner. It adds no renderer operation, native capability,
grant, public filesystem path or mobile availability flag. The Electron host
retains its existing helper behavior. Metadata-only `attachments.save`, captured
full-array CAS and Source exact-ID removal retain their published contracts.

## Observed defects and authority

Actual production-owner regressions first demonstrated that a saved-file
symlink and a workspace `attachments` directory symlink both allowed a real
AgentManager start to reach its controlled adapter. The latter can overwrite a
synthetic outside file. The existing preview helper also read synthetic foreign
workspace symlink bytes into a prompt. These were filesystem effects in the
published Source path, not an inference from matching saved IDs.

A further retained-agent-API regression held a real saved-file read, withdrew
the original caller's task/project/agent grants, then observed one adapter
prompt before the late result check refused the reply. A reply refusal cannot
revoke an admitted copy or prompt. Production attachment-producing manager
calls now retain a bounded original task/project/agent and hierarchy/group
request scope through the existing manager request owner. Stop/abort and
accepted detached scheduler lifetimes are not replaced by this request guard.
An ordinary prompt acknowledged by the adapter retains its durable delivery
nonce after caller cancellation, while further polling/state effects are
suppressed. Heartbeat checks retain their separate stale-instruction cancellation
rule and are never replayed.

The private `AgentManagerHost.attachmentExecution` port is captured by the
production owner. Its real `TaskAttachmentFileOwner` is constructed before the
execution owner; no missing/optional callback is treated as permission. The
Source host delegates only to that captured instance and joins both owners at
shutdown. There is no path fallback when protected execution is refused.

## Copy and preview boundaries

Production start, resume, send and question-response synchronization use the
same private copy operation. It captures canonical attachment metadata and
task/project/agent/parent/role/group ownership, including current group-member
membership receipts, then rechecks that scope at raw I/O boundaries. Group
files retain member-ID/attachment-ID namespaces. Saved metadata validation and
file/byte bounds precede file effects; an ambiguous duplicate destination name
is refused rather than silently selecting one record.

Source bytes pass through `TaskAttachmentFileOwner.readForExecution`: the
no-follow FD stays private, the reader yields detached chunks of at most 64 KiB,
and complete source verification/close finishes before workspace publication.
Neither an ambient attachment directory nor a renderer-provided path can
reopen that source. Cancellation still joins accepted reads and FD cleanup. Even a consumer that ignores a raw read promise cannot release its FD early; late bytes are withheld and the reader joins its pending work.

Linux destination operations use held workspace/root/attachment directory FDs.
Child access is relative to `/proc/self/fd/<held-fd>` with no-follow directory
opens; a temporary destination uses exclusive creation. A verified readback
digest matches the acknowledged source chunks before rename publishes the
exact directory entry. Rename replaces a hostile final symlink entry without
opening or truncating its target. Directory identity checks fence replacement;
cleanup uses the held directory receipt and never retargets a replacement.
An admitted rename may complete after cancellation. Accepted copied files are
not rolled back or automatically replayed.

Message previews use the verified saved-file reader, never mutable workspace
paths. Actual saved size is at most 24 KiB for a preview; at most 3 previews and
1,200 characters per preview enter the existing message formatting. Public
message attachment references must exactly match the saved record's ID,
filename, size and MIME type. A forged small size cannot authorize a large read.

One execution owner admits at most 4 owned requests, serializes their file work,
and bounds a copy to 128 records/64 MiB total. Queued requests retain their
original scope and cancellation. Close stops admission, joins raw work and
retains failed temporary/FD cleanup for explicit retry; the application profile
cannot be released while those receipts remain unacknowledged.

## Platform and acceptance limits

Linux is the implemented destination authority. macOS and Windows saved-file
execution fail closed until equivalent anchored directory publication is
implemented and proven; there is no ambient path-copy fallback. Empty-file
operations still use the existing production manager. Linux tests of the
unsupported branch are policy controls, not macOS/Windows runtime evidence.

The later scoped Linux mobile handoff in `bd898f99` delegates saved-attachment
start/startTask/resume/send and current permission/question replies through the
same retained Source backend and captured manager/FileOwner. Its original pair,
server, graph, metadata and live-session fences remain independent admission
requirements. Incoming nonempty create/send payloads and full-array attachment
writes remain refused, as does saved-file execution on macOS/Windows. Merely
having this port or matching saved records is not an execution grant.

Workspace contents remain agent-editable after accepted publication. This
does not provide a sandbox against arbitrary same-user processes, restore bytes
after admitted effects. The later [private attachment journal](native-attachment-journal.md)
records publication/removal facts through clean restart and controlled SIGKILL
checkpoints; it supplies no automatic orphan cleanup or resumed intent.
Installed supported-OS lifecycle, physical UI,
remaining #208/#202 prerequisites and the user identity/scheme decision remain
open. Evidence will record the exact implementation revision, commands, raw
results, negative controls, failures/repairs and source/artifact hashes in
`evidence/issue-214-protected-attachment-execution-local-20261018.json`.

Synthetic temporary profiles/files and controlled adapters only; no live
provider, OS credential account, microphone, release or profile cutover.
Hosted Verify unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings endpoint
or workflow dispatch; hosted voice stays deferred.
