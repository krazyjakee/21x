# Agent configuration service boundary

`AgentConfigurationBackend` supplies a separate production-owner domain for six retained commands. It does not expand the content-only `ConfigurationBackend` or the synthetic agent-session fixture. Source implementation is separate from native registration, packaged proof results and installed application parity.

| Command | Codec and authority | Actual owner effect |
| --- | --- | --- |
| `agent:getAll` | Exact empty request; global read, agent visibility and referenced-project read scope | Reads `DatabaseManager`; projects declared public fields and saved-key markers |
| `agent:create` | Exact bounded public configuration; global write and configuration reference scope | Transactional database create, real start-queue drain, `tasks:refresh` invalidation |
| `agent:update` | Exact agent ID and public configuration; global/agent write and every affected project | `AgentManager.runAgentConfigurationMutation`, transactional write, actual backend notification and queue reconciliation |
| `agent:delete` | Global/agent delete and affected-project authority; active groups preflight before Stop | Actual owned queued/start/live teardown before deletion; retained task/source history; fallback/default references reconciled |
| `agentConfig:getProviders` | Optional authorized HTTP(S) server URL and one of five backend types; no client path | Actual read-only manager provider query; bounded public provider/model projection and model cache |
| `agentConfig:listModels` | One of five exact backend types and backend-query authority | Actual manager model listing; `null` retains missing CLI or unsupported listing semantics |

Trusted caller, epoch, project access and global configuration permissions originate in the host. The command payload cannot establish them. Configuration references must name existing skills, secrets, MCP servers and fallback agents. Server URLs exclude embedded credentials, query strings and fragments; callers cannot choose a workspace, executable, CLI argument or arbitrary backend.

The actual lifecycle owner distinguishes metadata/admission-cap changes from runtime changes. Name and cap edits preserve live sessions and drain the queue. Runtime changes and deletion fence affected starts, sends and resumes, then acknowledge owned teardown before writing. Shared backend adapters must not disrupt an unrelated live agent; conflicting edits are refused. A notification failure after an accepted write does not undo or repeat that write. The bridge emits only the exact `tasks:refresh` invalidation after accepted CRUD; actual session/queue events remain with their existing owner and transport.

Cancellation before a mutation prevents its database effect. Cancellation after an accepted effect suppresses its reply without replaying the effect. Provider/model operations remain owned until their raw promises settle. `close()` rejects new admission and joins those flights; a drain timeout requires the host to retain the database, profile lock and provider owner. Late replies cannot refresh the model cache after cancellation or shutdown. Fatal event delivery is latched and reported to the host instead of silently retrying accepted CRUD.

Agent `config.api_keys` remains a legacy plaintext JSON storage format in `DatabaseManager`. This boundary **rejects all new `api_keys` writes**, preserves existing raw keys server-side when replacing public configuration, and returns only `__21x_api_key_set__` markers by vendor. It does not convert that legacy format, provide an encrypted agent-key owner, clear keys, or claim the credential editor is fully supported. Encrypted provider settings and secret BLOBs use different owners and remain separate work.

The new unit tests exercise exact DTO bounds, saved-key masking, trusted/global/project authority, actual `AgentManager` mutation fences, owned Stop/queue behavior, backend notifications, cancellation/drain, and fatal invalidation. Their backend transport is explicitly controlled; these tests do not establish real provider SDK or CLI parity. Integrated validation and the source revision, runtime versions, hashes and expected/actual results must be attached by the coordinator before claiming this slice proven.

Issue #210 also requires task lifecycle/source effects, lifecycle-dependent settings, complete credential formats, retained-command reconciliation and native production registration. Those remain outside this agent-configuration slice. No installed Tauri parity, live-profile migration, release or data cutover is authorized or established here.
