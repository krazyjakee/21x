# Native approval request scope

Production agent replies require the exact current native session key, task,
agent and pending request ID. Persisted transcript cards and session redirects
never grant authority. All five adapters expose live pending requests; the
manager rechecks ownership before dispatch and serializes replies to one
request. Actual refusal is returned as unhandled without a continuation prompt.

OpenCode reads pending native questions/permissions and matches the requested
ID; unsuccessful HTTP/SDK replies cannot report success. ACP, Codex and Pi
retain exact responses until their private writable callback acknowledges bytes
or the pipe closes. Claude tracks native question IDs separately from restored
history and consumes them before an accepted follow-up. A question rejection
uses acknowledged native abort; an abort failure retains live ownership and
polling rather than manufacturing idle/cancelled state. An accepted interrupt
whose native status remains busy is also unconfirmed; the strict production
response cannot manufacture completion from a successful cancellation write.

Codex structured question replies follow the generated v2
`ToolRequestUserInputResponse` schema from local `codex-cli 0.162.1`: an answers
map keyed by the provider's question IDs, with string arrays per answer.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes version-specific schema generation and `serverRequest/resolved`
notifications. This schema inspection runs no inference. Unknown request IDs,
foreign native thread/turn IDs and terminal requests cannot authorize a reply.
User questions remain human input even when tool permissions are set to allow.

These changes establish request/transport ownership; a successful pipe write
is not a successful tool result. Actual provider status and terminal events
remain the execution outcome owners. Live authenticated SDK/CLI sessions,
platform packaging and installed native UI proof remain separate acceptance
criteria for issue #211.
