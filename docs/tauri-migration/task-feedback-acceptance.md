# Production task feedback acceptance

This is the bounded batch34 continuation of #210: exactly three existing owner
notices and their real consumers. It consumes the reviewed event/native/page
subset of #202/#209/#211; it does not establish those issues or #210 complete.
The explicit #202 closure prerequisite remains open. The user requested finishing
this current batch and stopping; no further feature or migration batch is part
of this acceptance.

## Wire and authority

| Existing notice | Exact service payload | Actual sender |
| --- | --- | --- |
| `agent:incompatible-session` | `{taskId,agentId,error}`; fixed `PRODUCTION_INCOMPATIBLE_SESSION_ERROR` | Manager incompatible resume/poll handling after classified durable session-loss recording |
| `task:checkpointAnswered` | `{taskId,approved:boolean}` | Authenticated task API checkpoint route after current pending request scope and actual acknowledged Manager response |
| `task:source-action-failed` | `{taskId,taskTitle,error}`; fixed `TASK_SOURCE_ACTION_ERROR` | Manager feedback idle transition after actual skill scan and failed SyncManager source-completion action |

IDs use the existing finite database ID grammar. Payload keys are closed and
total serialized UTF8 is at most 2048 bytes. Error literals are shared exported
constants, not raw backend/source diagnostics. The source title is nonblank
under JavaScript trim, NUL-free, well-formed Unicode and at most 512 UTF8 bytes.
The encoder bounds raw input to 65536 code units and truncates only complete
codepoints. Native validation separately enforces the same wire shape and byte
policy, including BOM/NEL trim differences. No epoch/document metadata is added
to these service payloads.

Event read grants are independent of mutation permission. The actual current
task, project and assigned agent must exist and be readable; incompatible also
matches the event agent to the current assignment. Source failure additionally
requires the current source grant where associated. Deleted tasks, denied current
scope, foreign caller and retired engine epoch cannot acquire delivery rights
from an old captured event. Checkpoint routes require a literal boolean, current
session/task/agent/project/controller through awaits, a real pending request ID
and response type, and `handled:true`. Missing/ignored/false/stale callbacks do
not manufacture successful approval or an answered notice.

## Actual source-owner proof

`scripts/production-task-feedback-proof.ts` creates a new disposable profile,
SQLite, sealed ProductionService/ProductionOwner and actual fragmented private
ServicePeers. Its controlled adapter implements real pending request callbacks;
it never writes private Manager session maps or emits fabricated owner events.
The adjacent helper test checks fixture title byte/Unicode boundaries. The actual
service wrapper is `src/service/production-task-feedback-acceptance.test.ts`.

| Scenario authored | Required actual receipt |
| --- | --- |
| Public incompatible resume | One real redacted notice, cleared durable binding, classified transcript loss retained, no automatically created replacement, same-epoch ping continuity |
| Current task/project/agent read withdrawn | Real Manager incompatible senders and actual checkpoint responses produce no recipient notice; restoring rights does not replay one |
| Authenticated checkpoint | Wrong bearer, foreign task, nonboolean value and actual adapter refusal cannot approve or publish success; actual `handled:true` acknowledgment of `approved:false` yields one unchanged false notice and consumes the pending request |
| Duplicate checkpoint | No repeated adapter approval and no second notice |
| Actual source-completion failure | Public user feedback choice reaches real learning/skill scan/idle owner and built-in GitHubIssuesPlugin/SyncManager; one bounded local CLI child returns failure, task remains durably ready for review and pending completion is consumed |
| Source error/title policy | Exact fixed error, bounded complete Unicode title prefix, no private fixture error marker in any notice; source/task/project/agent projection denials |
| Epoch/caller/document identity | Real captured payloads are refused by the actual service projector for retired epoch/foreign caller identity; Node does not claim physical document authority |
| Cancelled retiring checkpoint | Actual HTTP caller abort, acknowledged real generation Stop and held native adapter callback; no false answered notice, writer retained until raw callback settles and actual native process-owner drain acknowledges |
| Teardown | Original workload and cleanup failures retained together; actual source callback, child and both stdio closes, no signal requests, every accepted session destroyed, profile deleted only after successful owner drain |

The source command uses the existing `gitProviderProcess` external boundary to
run staged Node as a fixture `gh` executable. Only the exact local synthetic
issue-completion arguments are accepted. It returns a real nonzero child exit
with a private marker on stderr; actual GitProviderProcessOwner, GitHub manager,
plugin and SyncManager retain their real ownership and error paths. No GitHub
binary, network credentials, remote repository or user profile is accessed.
This is controlled source-failure evidence, not acceptance of a real configured
remote update. The fixture closes Captain wake delivery admission to avoid
unrelated background sessions and uses actual adapter nudges and acknowledged
Manager status transitions rather than fixed sleeps or fake runtime state.

The report preserves the actual three payloads under `notices[].payload`, with
transport epoch/sequence in separate report fields. Those exact encoded examples
can be compared to native literals; codec membership alone is not an effect
receipt. It records every expected/actual numeric counter, staged Node/SQLite
and fixture artifact SHA256, source hashes, OS/architecture, callback/process
receipts and explicit cleanup results. WebView is null for this Node proof.

## Native/page and remaining issue acceptance

The independent native/page owner supplies actual source regressions for native
validation and the current main document lease. Only these three native notices
carry `{engineEpoch,leaseId,event:<validated service event frame>}` on the page
channel. The transport rejects missing/stale/foreign stamps before DesktopClient
cursor advancement. Current callback registration and checkpoint task-refresh
invalidation must occur exactly once; `approved:false` stays false, unsubscribe
and stale-document delivery are suppressed, and receipt performs no approval or
other mutation. The Node proof does not import renderer source into the composite
Node project and cannot stand in for these source tests or installed WebView
evidence.

This local continuation covers legitimate failure/answer notices, current read
projection and acknowledged checkpoint response semantics. It does not prove all
checkpoint UX, full feedback-to-learning-to-skill-sync provider behavior, authorized
external source acceptance, all five vendor adapters, installed native document
delivery or every retained #202 command/event. Previously validated cleanup,
transcript pagination and approval semantics remain separate evidence. Whole
#210 and #202/platform prerequisites stay open.

The source-completion sender also depends on the service owner's narrow
`finishSessionFeedback` currentness guard. Its separate actual-row/barrier
regressions cover both success and failure after Stop or task/session/agent/
project/source/choice substitution: an already attempted external effect cannot
authorize stale local completion, fallback status writes, a stale failure notice
or silent replay. The Node proof's ordinary source failure demonstrates the
current-generation branch; it does not relabel those separate regressions as
executed Node race scenarios.

## Primary validation

All new engineer-authored scenarios are **UNRUN** until the primary freezes the
combined service/native/page/proof inputs and validates them. Suggested command:

```sh
rtk pnpm test:tauri -- --terminal-proofs src/service/production-task-feedback-acceptance.test.ts --reporter=default --reporter=json
```

Keep the `PRODUCTION_TASK_FEEDBACK_REPORT` console receipt as well as JSON, exact
revision/source hashes, command/log checksum, exit status and skips. JSON-only
reporting can suppress the console receipt. Primary also owns compiler, focused
codec/route/Manager/native/page regressions and generated inventory freshness.
No source-ready handoff, mocked bridge or skipped test establishes accepted
installed evidence or authorizes release/cutover.
