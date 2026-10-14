# Production record credentials

Protected native profiles now encrypt agent `api_keys` values, MCP
`headers`/`environment` values and OAuth registration `client_secret`, and
the retained task-source fields `client_secret`, `access_token`, and
`api_token`. The finite source policy lives in
`src/shared/task-source-credentials.ts`.

Each nonempty string uses a versioned record envelope around the existing
authenticated AES-256-GCM setting format. The actual protected application
key and profile identity come from the singleton owner. Runtime getters
restore the original strings for their actual provider/plugin consumers.
Whitespace, Unicode and BOM are preserved. Empty values clear the selected
field. Unchanged encrypted values retain their exact ciphertext during
configuration merges. Electron retains its existing record representation.

The agent desktop boundary accepts only the three existing vendors:
OpenAI, Anthropic and Cursor. Each input is bounded to 16 KiB UTF-8 and
rejects control characters. Responses expose presence markers. An echoed
marker requires an existing saved value; omitted vendors preserve their
values. A host without the captured authenticated storage provider rejects
key writes before lifecycle effects.

Agent runtime edits use the actual manager's configuration fence: accepted
sends and starts are joined, session destruction must acknowledge, then the
database changes and the actual cached backend receives its configuration
notification. An unchanged marker does not trigger a runtime restart. A
shared backend's unrelated live owners continue to prevent disruptive
single-agent changes. Failed refresh keeps future dispatch fenced. The
authenticated task API omits agent credentials entirely.

MCP edits derive affected agents from actual server references and cached
backend refresh ownership. The same derivation drives authorization and
the mutation. No request can supply an arbitrary list of owners to stop.
Actual queued starts, accepted sends and acknowledged session destruction
remain owned until the change completes. MCP probes have a separate raw
child/network lifetime; public cancellation is not a process-exit receipt.

Before migrations or seeding, production startup reads existing agent, MCP
and task-source credential fields and checks their authenticated envelopes.
Plaintext, incompatible formats, unknown reserved envelopes, and unreadable
ciphertext fail without replacing the key or converting database records.
This does not implement historical-profile credential conversion, installed
OS-store acceptance, or release cutover; those migration requirements remain
open.
