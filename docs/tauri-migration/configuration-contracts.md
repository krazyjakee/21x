# Configuration codecs and forwarding ownership

This G1 batch reviews the ten remaining generic event forwarding sites and supplies codecs for 22 retained configuration operations. It does not enable live migration, expand the native allowlist, or bind operations without their real domain owners. Existing Electron handlers remain unchanged.

## Ten forwarding sites

The authoritative finite map is `event-forwarding-review.json`; `scripts/tauri-contracts.mjs` copies it into the operation manifest and generates `src/shared/desktop-event-forwarding.ts`. The source base and exact file/line/column/callee expressions are recorded. Generation fails if a dynamic site is unreviewed, duplicated, or its review location becomes stale. Channel ownership must agree with the retained operation manifest; namespace wildcards and removed operations cannot satisfy the review.

| Site | Producer owner and allowed names | Destination/routing detail |
| --- | --- | --- |
| Agent Manager `broadcast` → guarded send | Eight forwarded Agent Manager names plus `artifact:updated` | Desktop and external listeners; nine names |
| Agent Manager `sendToRenderer` → `broadcast` | Eight outgoing names | Ten producer inputs include `agent:output` / `agent:output-batch`, which persist and return before forwarding |
| Updater `send` → guarded send | `updater:status` | Desktop; native updater owns its replacement |
| Guarded send direct path | Exact 50-name closure of reviewed direct producers and relays | Transport only; no independent domain permission |
| Guarded send chunk path | `transcript:changed`, legacy `agent:output-batch` | Explicit split branch; raw agent output batches are currently persistence inputs |
| Heartbeat sender → guarded send | `heartbeat:alert`, `heartbeat:disabled`, `task:updated`, `tasks:refresh` | Desktop |
| Task API notifier → guarded send | Six exact task/artifact/project/UI names | Desktop plus the separate authenticated mobile broadcaster |
| Mobile notifier → guarded send | Five exact task/pairing/device names | Desktop only |
| Voice desktop notifier → guarded send | Eighteen exact voice/task names | Five speech/TTS names are desktop-only; other voice/action state uses the separate mobile destination |
| Workspace cleanup sender → guarded send | Progress and completion names | Desktop |

`transcript:changed` uses the durable projection sender directly, outside Agent Manager `broadcast`. The review distinguishes accepted producer inputs, persistence-only branches, and actual outgoing names. Tests preserve this distinction and the speech/audio destination boundary.

The AST evidence remains `channel: null` with its original unresolved expression: the parser has not inferred runtime values. The manifest separately records ten reviewed references and zero unreviewed references. These are manual source ownership maps, not installed validators, permissions, or closed-world guarantees about future code. Every portable event still needs its concrete payload schema, producer authority, targeted destination, epoch, sequence, and overflow/recovery policy.

## Twenty-two configuration codecs

`src/shared/configuration-desktop-codecs.ts` exports `CONFIGURATION_COMMAND_CODECS` with the same structural methods as the existing database/renderer client codecs. Named payloads use `{ data }`, `{ id, data }`, `{ projectId, data }`, `{ id }`, `{ projectId }`, or `{ projectId, orderedIds }` according to the actual method signature. Archive's optional Boolean stays omitted when absent and preserves explicit false. Skill scope uses an explicit null for global scope. All results retain `OptionalResult<JsonValue>` and actual undefined/Boolean/record distinctions.

| Operations | Codec scope | Registration prerequisite |
| --- | --- | --- |
| Agent get/create/update/delete | Declared metadata/configuration fields, referenced IDs, HTTP(S) server URLs, model/backend/auth/sandbox enums and positive concurrency values | Trusted profile editor; referenced Agent/MCP/skill/secret IDs authorized; live update requires the actual `drainStartQueue` callback, live deletion requires reference/session reconciliation |
| Skill get/create/update/delete/setProject | Declared content/version/model/scope fields, confidence, usage, tags, nullable model/project | Project/global scope authority; destination project exists; optimistic version conflict rejects without overwrite and gets a stable error mapping |
| Project update/archive/reorder | Content/git fields, archive Boolean and exact ordered IDs | Database default-project rules, authorized project scope; settings/default-agent/Captain fields remain rejected until real queue/Captain effects are connected |
| Project repo list/add/update/remove/reorder | Declared repo/provider/org/branch metadata | Every referenced child belongs to the authorized project; metadata does not authorize git/network/filesystem work |
| Project resource list/add/update/remove/reorder | Declared label/URL/notes metadata | Every referenced child belongs to the authorized project; URL text does not authorize opening an external URL or reading a file |

Arrays are capped at 128 and records/strings have explicit bounds; transport frame limits still apply. Large lists/content require pagination/chunking before full parity can be claimed. Unknown fields, undeclared binary values, malformed references, and invalid missing/null shapes fail with redacted protocol errors. Optional undefined fields are omitted only where their declared schema permits it; there is no generic recursive conversion.

Public Agent projection selects the declared metadata/configuration keys, omits plaintext `api_keys` and private database columns, and retains secret IDs as trusted desktop assignment metadata. The shipping desktop IPC currently returns the complete Agent config; mobile already strips sensitive fields. This portable boundary deliberately blocks plaintext key reads/writes and awaits credential-owner integration. A future config replacement must preserve the existing hidden credential bucket or use an explicit credential transaction; omission from a DTO must never silently delete stored credentials. No database behavior or stored rows are changed by these codecs. Skill projection omits the internal deletion marker, preserving BOM/Unicode content and version cursors. Project configuration replies reject credential/private fields in generic settings rather than expose them or rewrite persisted data.

All 22 operations remain codec-only and unbound in this batch. `CONFIGURATION_OWNER_REQUIREMENTS` records the known effects that cannot be replaced with a no-op callback. No lifecycle, start/resume/stop, permission approval, or synthetic approval handler is added. G1 still needs the remaining retained command/event schemas, native callback codecs, caller/domain permissions, byte/undefined rules, large-payload recovery and installed host evidence.
