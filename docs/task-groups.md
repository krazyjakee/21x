# Captain task grouping

Task groups let small related tasks share one agent session, workspace and review. Each member keeps its own title, description, progress and task source. A hidden execution task owns the shared transcript and counts as one running session.

The Captain should group 2–10 ordinary unstarted root tasks from the same project, with exactly the same repositories and compatible agent assignments. Nearby copy changes, small fixes and related configuration edits are useful candidates when the combined change fits one review sitting. Keep large or unrelated changes, work with dependencies outside the batch, subtask trees, successor chains, recurring tasks, heartbeat tasks and existing active sessions separate. Groups do not bypass concurrency limits.

Use `list_task_groups` and `get_task_group` to inspect existing batches, then `create_task_group` to create one. Start its returned `execution_task_id` with `start_task`. The initial prompt lists every member’s ID, title and description. Each member must be addressed in the shared work; starting members separately would defeat the group’s purpose.

The execution agent uses `report_group_task` to report working, done or blocked progress for a current member. A blocked member should explain its obstacle and next step while other members continue where possible. Done is implementation progress; it grants no review approval, local completion or task-source completion. The user reviews the shared work and may approve or send back individual members. Completed members remain completed when unfinished work resumes.

The Captain can use `add_to_task_group`, `remove_from_task_group` and `dissolve_task_group`; users can also remove members through group controls. Stop queued or active ownership before changing the batch definition. Preserve membership history and the shared transcript, and respect refusal instead of directly editing member lifecycle or group IDs. The group moves on the board as one unit; dragging an individual member out is blocked.

Group tools are project scoped. Definition changes require the app-issued Captain MCP scope, and progress reports require the current signed group execution task, matching agent and session nonce. The legacy stdio bridge requires `TASK_MCP_URL` from the app to forward these calls through the signed MCP endpoint. A plain task API token, model-provided owner ID or list of task IDs cannot grant group authority.

Approval defaults to completing each selected task at its source. A failed source stays in review and can be retried; disabling **Complete at task sources** approves only in the app. Sending selected tasks back adds one instruction to the shared conversation, preserving unselected review work and approved members. Group review records feedback as each approved task’s resolution; it does not start separate per-member learning sessions or enable automatic completion.

Member attachments keep their original ownership and are copied into separate `attachments/task-<member ID>/` directories in the shared workspace. Equal filenames cannot overwrite another member’s attachment. Send new message attachments through the group conversation. Definition changes retire the idle backend with acknowledgement and retain the shared transcript for the next explicit instruction; they never silently restart work.
