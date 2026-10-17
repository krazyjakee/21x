# MCP probe lifetime

`McpProbeService` owns raw stdio and HTTP probe operations through process close, response consumption and response-body cleanup. It accepts explicit process, fetch, environment and task API credential hosts. The application wrapper preserves its existing host selection; a standalone bootstrap can supply its own environment and runtime paths.

At most sixteen operations can be active, including probes whose public deadline expired while raw work remained. A probe has a 30-second deadline. Shutdown closes admission, cancels accepted probes and waits for their raw work; a failed bounded close retains ownership for retry. A queued probe checks cancellation before calling a host. Final application shutdown joins the owner before SQLite close, and the IPC handler refuses to save a result that raced final shutdown.

Local success waits for native child close after the initialize/tools handshake. Every pipe has an error listener; only the owned child object receives termination and bounded force escalation. No process-name/PID sweep is added. The output budget is 256 KiB per stdout/stderr stream. Startup/error/close paths remain owned through native close, and reflected stderr or process errors never enter the result. Complete descendant process-tree cleanup and wrapper-shell behavior remain open.

HTTP initialization, the initialized notification and tools listing run sequentially. The notification is no longer detached. Negotiated session IDs accompany subsequent requests; all response bodies are consumed or cancelled, with raw reader/cancellation ownership retained after abort. JSON responses are bounded to 256 KiB; status and protocol errors are classified without reflecting request URLs, header values or server error bodies.

## Streamable HTTP continuation — issue #213, batch35

Both `application/json` and `text/event-stream` replies now complete the actual
initialize/notification/tools sequence. HTML, missing/unsupported content types,
empty/truncated streams, wrong response IDs and notifications without a response
cannot produce a connected result. SSE decoding accepts split UTF-8/BOM,
LF/CRLF/CR, comments, multiline data, message events and batched RPC messages.
Other event types do not select a new endpoint. The parser stops at the matching
response and joins reader cancellation before advancing, even if the server
keeps its stream open. The entire SSE response, including comments and unrelated
messages, has a 256 KiB budget and shares the existing probe deadline/admission
limits. Timeout/Stop cancels pending SSE reads; incomplete cancellation retains
ownership through failed close and retry.

The real MCP backend supplies current authority controls to the probe, including
configuration access, saved-server/source/task scopes, explicit environment names
and the selected executable/argv/endpoint grant. They run before host access,
while consuming data and after asynchronous cleanup. Auth probes also recheck
authority before their queued fetch and after body cleanup. Revocation cannot
start the next protocol effect or save newly discovered tools. A failed HTML
probe preserves existing tools and unrelated server records.

The transport behavior follows the POST JSON/SSE response sequence in the
[MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).
This change preserves the existing shared protocol-version messages. It adds no
automatic reconnect, mutation replay, server-request handling, legacy GET/endpoint
fallback, pagination or session DELETE. Those require separate protocol and
endpoint-authority work; a probe does not establish full client transport parity.
Legacy HTTP+SSE-only endpoints fail without being reported as connected.

The regressions use an actual authenticated loopback SSE server with open
responses, byte-split controlled streams, held cleanup acknowledgement and the
actual SQLite/AgentManager/MCP backend. Synthetic fixture credentials only;
no live profile, marketplace or provider is read. Exact source/report hashes,
runtime versions, checks and remaining acceptance gaps are recorded in
[batch35 evidence](evidence/batch35-213-mcp-sse.json).

Twelve portable tests cover a real owning Node subprocess, actual authenticated loopback HTTP handshake, held native close, late/ignored-abort fetches and readers, notification cleanup, byte limits, redaction, queued admission and saturation. Seven existing handshake-message tests now also run under standalone Node. An application handler control verifies the late result cannot write tools after shutdown; existing CLI MCP configuration tests remain passing. [Local evidence](evidence/mcp-probe-owner-local.json) records exact commands, source hashes and results.

The earlier local evidence above retains its original revision. Current master
also binds MCP CRUD and probes to the production owner with captured restricted
environments; that implementation is exercised by `src/service/mcp-backend.test.ts`.
Native OAuth stays explicitly unavailable pending warm/cold callback ownership
and final identity work in [#215](https://github.com/krazyjakee/21x/issues/215).
Installed supported-target production behavior, complete transports and retained
integration parity remain open under [#213](https://github.com/krazyjakee/21x/issues/213),
[#208](https://github.com/krazyjakee/21x/issues/208) and
[#202](https://github.com/krazyjakee/21x/issues/202). No issue acceptance checklist
is completed by a source fixture alone.
