# Captain terminology and persisted context

The coordinator is the Captain. Code, prompts, relay instructions, UI and docs
use that name. Legacy spellings are isolated in the version-17 migration and
its fixture, plus the exact shared read-compatibility declarations. The
terminology guard scans all tracked and untracked non-ignored text files,
including docs, scripts, fixtures and mobile UI, and checks the spaced spelling
too. A UI module no longer gets a whole-file exception for one old tool alias.

## What caused the Daccord wording (#136)

The read-only investigation on 2026-09-19 started at origin/main `167b14a`, after
the original rename in `b3c504c` (#71). Active prompt templates and report
formatting already used Captain. The stale phrase came from agent-authored
persisted context, then an agent-authored report:

- Daccord Captain task `hb4m7ujsf0bytqa76dgn6ga0`, native Claude session
  `08d4131f-5190-4e93-aaf5-f3bd617b8492`, called `report_to_commander` at
  **19:00:54.646 UTC** with “Daccord <retired coordinator name> chat”.
  Its correlation ID was `cmd-bdb3cd74026a4b33`.
- Commander stored that report as `myyuz9p2w2t0tnij9fbfxud3` and repeated the
  phrase in reply `w4sctf2u8377tmkjskactoj7` at **19:01:02.030 UTC**.
  Summary `v2ej5lgth5om2845c18dmgxu` subsequently preserved it.
- Daccord's workspace `MEMORY.md:1` still titled its notes with the retired
  coordinator name. `AGENTS.md:33-34` and `CLAUDE.md:74,78`, generated on
  September 18 at 22:34 UTC, still used it in the descriptions of
  `update_project_status` and `report_to_commander`.
- The same Captain had already used the old name in a `send_message` call at
  **15:22:59.580 UTC**, persisted in task `m8uydpk1ui5hd2tt2fgjy33r`, part
  `user-message-1789831379586`. The task agent repeated it.
- The database was at schema 17: all three coordinator rows had Captain titles
  and roles, Daccord's settings were empty, and no old app setting key or agent
  configuration remained. The single old seeded skill was soft-deleted; no
  active skill supplied the wording. Early Commander history still contained
  pre-rename delegation calls, tool results and summaries. Status journal prose
  also retained old wording (10 summaries and one next-steps field); its
  structured source values were already migrated. Other task/transcript matches
  were historical output or this rename task itself.

These records establish the report-to-relay chain exactly. The stale workspace
instructions and memory are confirmed inputs; which particular occurrence the
model copied cannot be proved. The legacy seeded skill is 20x heritage, but was
not an active skill in this incident. No Daccord files, database rows or native
session files were edited during the investigation.

## Refresh and compatibility

On resume, `AgentManager.resumeAdapterSession()` now regenerates managed
`AGENTS.md`, `CLAUDE.md` and assigned skill files before the backend loads the
conversation. It uses the same scoped MCP server map as a fresh start. It does
not rewrite the Captain's own `MEMORY.md` or native transcript.

`readCaptainMemory()` translates the retired role name in the text it injects.
`CommanderStore` translates report, assistant reply and summary prose on read,
so the UI, relay model and subsequent summary folding see Captain. Project status
snapshots and journal prose use the same projection for history tools and UI. Original stored bytes, user
messages, structured tool calls/results, correlation IDs and session bindings
remain intact. The prose alias also preserves identifiers, paths and URLs.
Prompts instruct new replies and summaries to use Captain. Old delegation tool calls
still display correctly, including calls without a project argument.

The built-in Captain system prompt is assembled on start, resume and follow-up.
Claude Code passes it on each query, OpenCode on each prompt and Pi when its
process starts or resumes. Codex now supplies current developer instructions on
`thread/resume`; ACP queues current instructions for the first prompt after
`session/load`, just as on a fresh session. Native history can still contain old
wording. The current prompt explicitly tells agents to use Captain in messages,
reports, task instructions and memory despite old history.

Install the updated app and let existing runtimes resume (an app restart also
releases them). This refreshes managed workspace instructions and backend
instructions without deleting conversations. An already-running backend may
keep its previously loaded instructions until that resume; source changes alone
do not modify its live context. Captains can update the headings in their own
memory during normal maintenance; no cross-project file rewrite is required.

No new migration is introduced: schema 17 already converts coordinator roles,
agent columns, settings keys and journal sources. This follow-up adds read
compatibility for prose rather than altering historical records. Contested
version 18 is untouched.

## Concurrent changes

PRs #115 and #117 also edit `src/main/commander/prompts.ts`; retain both their
behavior changes and these terminology instructions when integrating. PR #123
currently edits voice controls and `docs/commander.md`, not the prompt module,
but shares the documentation surface. This work does not change merge authority.
