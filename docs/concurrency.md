# Agent concurrency: hard cap and Captain-managed level (#150)

Two numbers decide how many jobs of one agent run at once.

| | Set by | Scope | Stored in |
| --- | --- | --- | --- |
| **Hard cap** | the user (agent form, "Hard cap") | the agent, across every project | `agents.config.concurrency_cap` |
| **Working level** | the project's Captain (`set_concurrency`), or the user (pin, or Captain control off) | one project and one agent | `projects.settings.concurrency` |

Admission (`src/main/agent-manager/admission.ts`) checks the requested start
against these limits, in this order:

1. the pauses and the daily cap (#65);
2. the global limit;
3. the agent's **hard cap** (`agent_limit`), which counts the agent's jobs in
   every project;
4. the project's **working level** for that agent (`concurrency_level`);
5. **file overlap** with the project's running jobs (`file_overlap`);
6. the project's concurrent-agent limit (#65).

Coordinator, heartbeat and triage sessions are never counted and never queued.

## Defaults

- **Hard cap:** min(the agent's old `max_parallel_sessions`, 5). This applies
  to new agents and, through migration 20, to existing ones. The user chose a
  cap of 5 for 21x; an agent reaches 5 once its cap is set to 5, or once
  `max_parallel_sessions` was already 5 or more before migrating. The
  migration only fills a missing cap. It never raises a limit that is lower,
  and it changes nothing until the upgraded app starts.
- **Captain control:** on, per project.
- **Working level:** starts at 1 per project and agent. The Captain raises it
  when the work allows.

## Rules

- **Clamped to the cap, refused above it.** A stored level above the cap reads
  as the cap (for example after the user lowers the cap). `set_concurrency`
  with a level above the cap is refused and changes nothing.
- **Lowering never stops running work.** It only defers new starts of that
  project and agent until fewer jobs than the new level are running.
- **User overrides.** A pinned level wins, and the Captain cannot move it.
  With Captain control off, every agent runs up to its cap in that project.
  Both are set in the project editor under Concurrency, and apply at once.
- **Resource pressure.** The main process samples free memory and the
  one-minute CPU load every 30 s (`ResourceMonitor` in
  `src/main/concurrency-control.ts`). Pressure means free memory below 10% or
  below 1 GiB, or a load above 1.5 per core. When two readings in a row show
  pressure, every Captain-controlled level above 1 drops one step. It drops at
  most once every 2 minutes. Pins and projects with control off are left
  alone. Under pressure, `set_concurrency` refuses any raise.
- **File overlap.** A task declares the paths it will change with
  `set_task_touches` (a directory covers everything under it). The branch
  diff of every running task (committed, uncommitted and untracked files
  against its upstream default branch) is re-read on each resource tick.
  A start whose touches overlap a running job of the same project waits.
  Tasks that name repos and share none never overlap.
- **Serial chains.** A subtask whose parent sequences its children, while a
  sibling still runs, does not count as parallel demand in
  `get_concurrency`'s suggested level.

## Queue order

The start queue is no longer plain FIFO:

- **Within a project:** by priority, critical > high > medium > low. Starts of
  the same priority stay FIFO. A priority changed while a start waits takes
  effect at the next drain.
- **Across projects:** round robin, one start per project per round. The
  project that least recently had a start admitted goes first. Priority never
  crosses a project boundary, so one project's urgent tickets cannot starve
  another project.

## Audit

Every change is recorded in two places:

- a `concurrency_audit` row: the kind, the previous and new level, the cap,
  the actor (`captain`, `user` or `system`) and the reason;
- a line in the project status journal (#72), under decisions.

The project editor lists the recent changes. `get_concurrency` returns them
too.

## Tools

| Tool | Who | What |
| --- | --- | --- |
| `get_concurrency` | anyone in the project | caps, levels, running and queued counts, pressure, suggested level, recent changes |
| `set_concurrency({agent_id, level, reason, project?})` | the project's Captain only | moves its own project's level; refused as above |
| `set_task_touches({task_id, paths})` | the Captain and the project's task agents | declares a task's hot files |
