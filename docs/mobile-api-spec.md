# 20x Mobile API Specification

> HTTP + WebSocket API served by the Electron main process for mobile clients.
> Default port: `20620`. The server only runs while **mobile access** is on in
> Settings → General → Connect Phone, and binds to `127.0.0.1` unless **LAN
> access** is explicitly opted into (which exposes plain HTTP to the local
> network). Remote access goes through the HTTPS cloudflared tunnel (or a
> custom URL), which dials `http://127.0.0.1:20620` locally.

---

## Table of Contents

- [Authentication](#authentication)
- [REST API](#rest-api)
  - [Projects](#projects)
  - [Tasks](#tasks)
  - [Agents](#agents)
  - [Agent Sessions](#agent-sessions)
- [WebSocket API](#websocket-api)
  - [Connection](#connection)
  - [Events: Server → Client](#events-server--client)
- [Type Definitions](#type-definitions)

---

## Authentication

All requests (HTTP and WebSocket) other than the pairing endpoints require a
session bearer token, obtained by pairing (QR init code → 6-digit PIN).

```
Authorization: Bearer <token>
```

For WebSocket connections, pass the token as a query parameter:

```
ws://<host>:20620/ws?token=<token>
```

### Exposure

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Mobile access | `mobile_access_enabled` | `false` | Off: nothing listens on 20620 |
| Allow LAN access | `mobile_lan_access` | `false` | Off: bind `127.0.0.1`; on: bind `0.0.0.0` |
| Sign out idle devices | `mobile_session_idle_days` | `7` | Idle days before a session expires |

Toggling either switch starts, stops or rebinds the server immediately — no
app restart. Turning mobile access off also stops the cloudflared tunnel.

### Session expiry

Every authenticated request (and WebSocket upgrade) refreshes the session's
`last_seen`. A session unused for longer than `mobile_session_idle_days` is
revoked on its next use: the request answers `401` and the device disappears
from the connected devices list, so it must pair again.

### Pairing rate limit

`/api/auth/pair/*` shares one global budget of **20 requests per 60 s** across
all clients (the tunnel makes every request look local, so a per-IP limit would
not hold). Requests over the budget answer:

```
429 Too Many Requests
Retry-After: 60
{ "error": "Too many pairing attempts. Try again in a minute." }
```

Rate-limited requests never reach the handler, so a one-time init code or PIN
attempt is not consumed.

---

## REST API

All endpoints accept and return `application/json`.
All timestamps are ISO 8601 strings (e.g., `"2026-03-01T12:00:00.000Z"`).

### Common Response Envelope

Success responses return the data directly.
Error responses return:
```json
{ "error": "Human-readable error message" }
```
with an appropriate HTTP status code (400, 404, 500).

---

### Projects

Every task belongs to exactly one project. An install always has the `default`
project; the desktop may create more. The phone keeps its own chosen project
(stored locally on the device) and scopes its task list and new tasks to it.

#### `GET /api/projects`

List active (non-archived) projects in sidebar order.

**Response:** `200 OK`

```json
[
  {
    "id": "default",
    "name": "Default",
    "brief": "",
    "is_default": true,
    "current": false,
    "task_count": 12,
    "open_task_count": 4,
    "sort_order": 0
  },
  {
    "id": "clproj456",
    "name": "Website relaunch",
    "brief": "Marketing site rebuild. Repos: acme/web.",
    "is_default": false,
    "current": true,
    "task_count": 3,
    "open_task_count": 3,
    "sort_order": 1
  }
]
```

| Field             | Type      | Description |
|-------------------|-----------|-------------|
| `brief`           | `string`  | The project's description (the brief its Captain reads) |
| `is_default`      | `boolean` | The built-in `default` project |
| `current`         | `boolean` | The desktop's current project (setting `current_project_id`, else `default`): where a task created without `project_id` lands. Exactly one project is `current`. |
| `task_count`      | `number`  | User tasks in the project (coordinator rows excluded) |
| `open_task_count` | `number`  | Of those, tasks not `completed` |

#### `GET /api/projects/status`

The all-projects overview (#63): every active project's status at a glance,
the same rows the desktop's Projects view shows. Read-only; the phone refetches
it on `task:*` and `agent:status` events (debounced) and every 15 s while visible.

**Response:** `200 OK`

```json
[
  {
    "project_id": "clproj456",
    "name": "Website relaunch",
    "brief": "Marketing site rebuild. Repos: acme/web.",
    "is_default": false,
    "sort_order": 1,
    "status": {
      "project_id": "clproj456",
      "counts": { "running": 2, "queued": 1, "awaiting_review": 1, "awaiting_approval": 1, "blocked": 0 },
      "summary": "Two features in flight; the checkout PR waits for review.",
      "top_blockers": ["Stripe sandbox keys missing"],
      "updated_at": "2026-09-18T10:12:00.000Z",
      "limits": { "projectId": "clproj456", "paused": false, "allProjectsPaused": false, "runningAgents": 2, "queued": [], "blockedBy": null, "...": "see ProjectLimitState" }
    },
    "pending_approvals": 1,
    "running_agents": 2,
    "paused": false,
    "all_projects_paused": false,
    "blocked_by": null,
    "last_activity_at": "2026-09-18T10:40:21.000Z",
    "needs_attention": true
  }
]
```

| Field                 | Type             | Description |
|-----------------------|------------------|-------------|
| `status`              | `ProjectStatus`  | Counts from the task rows and live sessions, plus the Captain's narrative (`summary`, `top_blockers`, `updated_at`). `limits` is present when the agent manager is running. |
| `pending_approvals`   | `number`         | Live sessions waiting for the user to approve a step (`status.counts.awaiting_approval`) |
| `running_agents`      | `number`         | Working sessions of the project's tasks right now |
| `paused`              | `boolean`        | The project's own pause |
| `all_projects_paused` | `boolean`        | The global pause: nothing starts anywhere while true |
| `blocked_by`          | `string \| null` | Why the next start would wait: `project_limit`, `project_daily_cap`, `project_paused`, `global_pause`, or `null` |
| `last_activity_at`    | `string \| null` | ISO time of the newest task change or status write; `null` for an untouched project |
| `needs_attention`     | `boolean`        | `pending_approvals > 0` or `awaiting_review > 0`: the project waits on the user |

Archived projects are not listed. Every number is counted (task rows, live
sessions); only `status.summary` and `status.top_blockers` come from
the Captain.

---

### Tasks

#### `GET /api/tasks`

List tasks with optional filters. Without `project_id` every project's tasks are returned.

**Query Parameters:**

| Param      | Type     | Default | Description |
|------------|----------|---------|-------------|
| `project_id` | `string` | —     | Only this project's tasks. `404 { "error": "Project not found" }` for an unknown id. |
| `status`   | `string` | —       | Filter by TaskStatus value (e.g., `not_started`, `agent_working`) |
| `priority` | `string` | —       | Filter by priority (`critical`, `high`, `medium`, `low`) |
| `source`   | `string` | —       | Filter by source name (e.g., `local`, `linear`) |
| `search`   | `string` | —       | Search title and description (case-insensitive LIKE) |
| `sort`     | `string` | `created_at` | Sort field: `created_at`, `updated_at`, `priority`, `status`, `due_date`, `title` |
| `order`    | `string` | `desc`  | Sort direction: `asc` or `desc` |

**Response:** `200 OK`

```json
[
  {
    "id": "clxyz123abc",
    "title": "Implement login page",
    "description": "Build the login page with OAuth support",
    "type": "coding",
    "priority": "high",
    "status": "agent_working",
    "assignee": "",
    "due_date": "2026-03-15T00:00:00.000Z",
    "labels": ["frontend", "auth"],
    "attachments": [],
    "repos": ["acme/web"],
    "output_fields": [],
    "agent_id": "agent_abc123",
    "session_id": "session_xyz789",
    "external_id": null,
    "source_id": null,
    "source": "local",
    "skill_ids": ["skill_1"],
    "snoozed_until": null,
    "resolution": null,
    "feedback_rating": null,
    "feedback_comment": null,
    "is_recurring": false,
    "recurrence_pattern": null,
    "recurrence_parent_id": null,
    "last_occurrence_at": null,
    "next_occurrence_at": null,
    "project_id": "default",
    "created_at": "2026-02-28T10:00:00.000Z",
    "updated_at": "2026-03-01T08:30:00.000Z"
  }
]
```

---

#### `GET /api/tasks/:id`

Get a single task by ID.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Task ID     |

**Response:** `200 OK` — Single `Task` object (same shape as list item above)

**Error:** `404` — `{ "error": "Task not found" }`

---

#### `POST /api/tasks`

Create a local task. Accepted fields: `title` (required), `description`, `type`, `priority`, `status`,
`assignee`, `due_date`, `labels`, `attachments`, `repos`, `output_fields`, `is_recurring`,
`recurrence_pattern`, `cron`, `auto_start_agent`, `auto_complete_without_review`, `parent_task_id`,
`project_id`. Any other field is ignored; in particular a phone cannot link a task to a source
(`source_id`, `external_id`, `source`).

Project assignment:

- A subtask (`parent_task_id` set) always joins its parent's project; `project_id` is ignored for it.
- Otherwise `project_id`, when given, must name an active project.
- Without `project_id` the task lands in the desktop's current project (the one `GET /api/projects`
  marks `current`), else `default`. The mobile app always sends its chosen project.

**Response:** `200 OK` — the created `Task`.

**Errors:**
- `400` — `{ "error": "title is required" }`
- `400` — `{ "error": "project_id must name an active project" }` (unknown or archived)

---

#### `POST /api/tasks/:id`

Update a task. Only provided fields are updated.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Task ID     |

**Request Body:** `UpdateTaskDTO`

```json
{
  "title": "Updated title",
  "description": "New description",
  "type": "coding",
  "priority": "critical",
  "status": "not_started",
  "assignee": "dmitry",
  "due_date": "2026-03-20T00:00:00.000Z",
  "labels": ["urgent", "backend"],
  "repos": ["acme/web"],
  "output_fields": [
    {
      "id": "field_1",
      "name": "PR URL",
      "type": "url",
      "required": true,
      "value": null
    }
  ],
  "resolution": "Completed via PR #42",
  "agent_id": "agent_abc123",
  "skill_ids": ["skill_1", "skill_2"],
  "snoozed_until": "2026-03-05T09:00:00.000Z",
  "feedback_rating": 5,
  "feedback_comment": "Great work"
}
```

**All fields are optional.** Only include what you want to change.

| Field               | Type                          | Description |
|---------------------|-------------------------------|-------------|
| `title`             | `string`                      | Task title |
| `description`       | `string`                      | Markdown description |
| `type`              | `TaskType`                    | `coding`, `manual`, `review`, `approval`, `general` |
| `priority`          | `TaskPriority`                | `critical`, `high`, `medium`, `low` |
| `status`            | `TaskStatus`                  | See [TaskStatus enum](#taskstatus) |
| `assignee`          | `string`                      | Assignee display name |
| `due_date`          | `string \| null`              | ISO 8601 date or null to clear |
| `labels`            | `string[]`                    | Full replacement of labels array |
| `attachments`       | `FileAttachment[]`            | Full replacement of attachments array |
| `repos`             | `string[]`                    | GitHub repo full names (`owner/repo`) |
| `output_fields`     | `OutputField[]`               | Full replacement of output fields |
| `resolution`        | `string \| null`              | Completion notes |
| `agent_id`          | `string \| null`              | Assign/unassign agent |
| `skill_ids`         | `string[] \| null`            | Override skills (null = agent defaults) |
| `snoozed_until`     | `string \| null`              | ISO 8601 snooze end; `"9999-12-31T00:00:00.000Z"` = "Someday" |
| `feedback_rating`   | `number \| null`              | 1–5 star rating |
| `feedback_comment`  | `string \| null`              | Feedback text |
| `is_recurring`      | `boolean`                     | Toggle recurring |
| `recurrence_pattern`| `RecurrencePattern \| null`   | Cron string or pattern object |

**Response:** `200 OK` — Updated `Task` object

**Error:** `404` — `{ "error": "Task not found" }`

---

### Agents

#### `GET /api/agents`

List all configured agents.

**Response:** `200 OK`

```json
[
  {
    "id": "agent_abc123",
    "name": "Claude Coder",
    "server_url": "http://localhost:4096",
    "config": {
      "coding_agent": "claude-code",
      "model": "claude-opus-4-6",
      "system_prompt": "",
      "mcp_servers": ["mcp_server_1", { "serverId": "mcp_server_2", "enabledTools": ["tool_a"] }],
      "skill_ids": ["skill_1"],
      "secret_ids": ["secret_1"],
      "api_keys": {
        "anthropic": "sk-..."
      }
    },
    "is_default": true,
    "created_at": "2026-01-15T10:00:00.000Z",
    "updated_at": "2026-02-28T14:00:00.000Z"
  }
]
```

---

#### `GET /api/agents/:id`

Get a single agent by ID.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Agent ID    |

**Response:** `200 OK` — Single `Agent` object

**Error:** `404` — `{ "error": "Agent not found" }`

---

### Skills

#### `GET /api/skills`

List all configured skills (available to agents).

**Response:** `200 OK`

```json
[
  {
    "id": "skill_abc123",
    "name": "Code Review",
    "description": "Reviews pull requests",
    "agent_id": "agent_abc123"
  }
]
```

| Field       | Type            | Description |
|-------------|-----------------|-------------|
| `id`        | `string`        | Skill ID |
| `name`      | `string`        | Display name |
| `description`| `string`       | What the skill does |
| `agent_id`  | `string \| null`| Agent this skill belongs to (null = available to all) |

---

### GitHub

#### `GET /api/github/org`

Get the configured GitHub organization name.

**Response:** `200 OK`

```json
{
  "org": "acme"
}
```

| Field | Type     | Description |
|-------|----------|-------------|
| `org` | `string` | GitHub org name (empty string if not configured) |

---

#### `POST /api/github/repos`

Fetch repositories for a GitHub organization.

**Request Body:**

```json
{
  "org": "acme"
}
```

| Field | Type     | Required | Description |
|-------|----------|----------|-------------|
| `org` | `string` | Yes      | GitHub organization name |

**Response:** `200 OK`

```json
[
  {
    "name": "web",
    "fullName": "acme/web",
    "defaultBranch": "main",
    "cloneUrl": "https://github.com/acme/web.git",
    "description": "Marketing site",
    "isPrivate": true
  }
]
```

**Error:** `400` — `org` is required. `500` — GitHub not configured.

---

### Agent Sessions

#### `GET /api/sessions`

List all active agent sessions.

**Response:** `200 OK`

```json
[
  {
    "sessionId": "sess_abc123",
    "agentId": "agent_abc123",
    "taskId": "clxyz123abc",
    "status": "working"
  }
]
```

| Field       | Type             | Description |
|-------------|------------------|-------------|
| `sessionId` | `string`         | Internal session ID |
| `agentId`   | `string`         | Agent that owns this session |
| `taskId`    | `string`         | Task this session is working on |
| `status`    | `SessionStatus`  | `idle`, `working`, `error`, `waiting_approval` |

---

#### `POST /api/sessions/start`

Start an agent session for a task. Starts go through the same main-process admission control as
the desktop: over the per-agent or global concurrency limit the start is **queued** instead of
refused, and the desktop starts it on its own when a slot frees (the task then moves to
`agent_working`, which arrives as `task:updated`).

**Request Body:**

```json
{
  "agentId": "agent_abc123",
  "taskId": "clxyz123abc"
}
```

| Field              | Type      | Required | Description |
|--------------------|-----------|----------|-------------|
| `agentId`          | `string`  | No       | Agent to use. Given: the desktop's `agent:start` path (`requestSession`). Omitted: the desktop's Start-task routing (`startTask`: next subtask with an agent, else the task's own agent, else triage with the default agent). |
| `taskId`           | `string`  | Yes      | Task to work on |
| `skipInitialPrompt`| `boolean` | No       | If true, starts session without sending task prompt (only with `agentId`) |

**Response:** `200 OK`

Started:

```json
{
  "sessionId": "sess_abc123"
}
```

Queued behind a concurrency limit:

```json
{
  "sessionId": "",
  "queued": true,
  "queuePosition": 2,
  "queueReason": "global_limit"
}
```

| Field           | Type      | Description |
|-----------------|-----------|-------------|
| `queued`        | `boolean` | Present and `true` when the start waits in the queue |
| `queuePosition` | `number`  | 1-based place in the start queue |
| `queueReason`   | `string`  | `agent_limit` (this agent's limit) or `global_limit` |
| `action`        | `string`  | Only without `agentId`: `task_started`, `subtask_started`, `triage_started`, `already_running`, `queued` or `no_action` |
| `startedTaskId` | `string`  | Only without `agentId`: the task actually started (a subtask when routed to one) |
| `agentId`       | `string`  | Only without `agentId`: the agent that runs it |

**Errors:**
- `400` — `{ "error": "taskId is required" }`
- `404` — task not found (without `agentId`)
- `500` — agent not found or the session failed to start

---

#### `POST /api/sessions/:sessionId/resume`

Resume an existing agent session (reconnect to a previously started session).

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | The persisted session ID (stored in `task.session_id`) |

**Request Body:**

```json
{
  "agentId": "agent_abc123",
  "taskId": "clxyz123abc"
}
```

| Field     | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `agentId` | `string` | Yes      | Agent that owns the session |
| `taskId`  | `string` | Yes      | Task associated with the session |

**Response:** `200 OK`

```json
{
  "sessionId": "sess_abc123"
}
```

The resumed session replays its full message history via WebSocket `agent:output` events.

**Error:** `404` — Session not found or expired.

---

#### `POST /api/sessions/:sessionId/send`

Send a new user message to the agent (a new instruction or follow-up).

> **Important:** Do NOT use this endpoint to answer agent questions. Use `/approve` for that. See [Interaction Routing](#interaction-routing) below.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Request Body:**

```json
{
  "message": "Please also add unit tests for the login component",
  "taskId": "clxyz123abc",
  "agentId": "agent_abc123"
}
```

| Field     | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `message` | `string` | Yes      | User message text |
| `taskId`  | `string` | No       | Task ID (used for auto-recovery if session is destroyed) |
| `agentId` | `string` | No       | Agent ID (used for auto-recovery if session is destroyed) |

**Response:** `200 OK`

```json
{
  "success": true,
  "newSessionId": "sess_new456"
}
```

| Field          | Type     | Description |
|----------------|----------|-------------|
| `success`      | `boolean`| Always true on success |
| `newSessionId` | `string?`| Only present if session was re-keyed during auto-recovery |

The agent's response streams via WebSocket `agent:output` events.

---

#### `POST /api/sessions/:sessionId/approve`

Respond to an agent's permission request OR answer an agent's question.

This single endpoint handles **two distinct interaction types**. Set `responseType` for a question so an adapter that supports both interactions uses its question endpoint:

1. **Permission requests** (ACP/Codex adapters) — agent needs approval for a risky action (e.g., running a bash command). These arrive via `agent:status` with `status: "waiting_approval"` and may include a `pendingApproval` object.
2. **Questions** (Claude Code / all adapters) — agent asks the user a structured question with options. These arrive as `agent:output` events with `partType: "question"` and `data.tool.questions` array rendered inline in the transcript.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Request Body:**

```json
{
  "approved": true,
  "message": "JWT",
  "responseType": "question"
}
```

| Field          | Type                         | Required | Description |
|----------------|------------------------------|----------|-------------|
| `approved`     | `boolean`                    | Yes      | `true` to approve/answer, `false` to reject |
| `message`      | `string`                     | No       | The answer text (for questions) or optional context (for permissions) |
| `responseType` | `"permission" \| "question"` | No       | Use `"question"` when the user answers a structured question |

**For single-question answers**, pass the selected option label directly:

```json
{ "approved": true, "message": "JWT", "responseType": "question" }
```

**For multi-question answers**, format as `"Header: Answer"` pairs separated by newlines:

```json
{ "approved": true, "message": "Auth Method: JWT\nToken Storage: HttpOnly Cookie", "responseType": "question" }
```

**For permission rejections:**

```json
{ "approved": false }
```

**Response:** `200 OK`

```json
{ "success": true }
```

---

#### Interaction Routing

The mobile client must implement the same smart routing as the desktop UI. When the user submits text from the chat input:

```
1. Look at the LAST message in the transcript
2. IF lastMessage.partType === "question" AND lastMessage.tool?.questions exists:
     → Call POST /api/sessions/:id/approve  { approved: true, message: answerText }
3. ELSE:
     → Call POST /api/sessions/:id/send     { message: text }
```

This is how the three user interactions map to API calls:

| User Action | Trigger | API Endpoint |
|-------------|---------|--------------|
| Type a new message in chat | Text input, no pending question | `POST /send` |
| Select an answer to agent question | Question options in transcript | `POST /approve` with `approved: true` |
| Approve a risky action | Permission banner | `POST /approve` with `approved: true` |
| Reject a risky action | Permission banner | `POST /approve` with `approved: false` |

---

#### `POST /api/sessions/:sessionId/sync`

Replay messages from a running session. Used to re-sync the client transcript after a reconnect.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{
  "success": true,
  "status": "working"
}
```

| Field     | Type            | Description |
|-----------|-----------------|-------------|
| `success` | `boolean`       | Always true on success |
| `status`  | `SessionStatus` | Current session status |

The server replays the full message history via WebSocket `agent:output` events.

**Error:** `404` — Session not found or not running.

---

#### `POST /api/sessions/:sessionId/abort`

Interrupt the current generation. Stops polling, preserves transcript. The session stays alive and can receive new messages.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{ "success": true }
```

---

#### `POST /api/sessions/:sessionId/stop`

Fully destroy a session. Removes from memory, resets task status to `not_started` (unless task is already `completed`).

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{ "success": true }
```

---

## WebSocket API

### Connection

```
ws://<host>:20620/ws?token=<session_token>
```

The upgrade is refused with `401` when the token is unknown, revoked or
expired.

After connection, the server streams all real-time events as JSON messages. The client does not send messages over WebSocket (all actions go through REST API).

Each WebSocket message is a JSON object with a `type` field indicating the event type:

```json
{
  "type": "agent:output",
  "payload": { ... }
}
```

---

### Events: Server → Client

#### `agent:output`

An agent transcript message or streaming update.

```json
{
  "type": "agent:output",
  "payload": {
    "sessionId": "sess_abc123",
    "taskId": "clxyz123abc",
    "type": "message",
    "data": {
      "id": "msg_unique_id",
      "role": "assistant",
      "content": "I'll start by creating the login component...",
      "partType": "text",
      "update": false,
      "tool": null
    }
  }
}
```

**`payload` fields:**

| Field       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Session that produced this message |
| `taskId`    | `string` | Associated task |
| `type`      | `string` | Always `"message"` |
| `data`      | `object` | Message content (see below) |

**`data` fields:**

| Field      | Type      | Description |
|------------|-----------|-------------|
| `id`       | `string`  | Unique message/part ID (for deduplication) |
| `role`     | `string`  | `user`, `assistant`, or `system` |
| `content`  | `string`  | Text content (may be markdown) |
| `partType` | `string?` | Message category (see [PartType enum](#parttype)) |
| `update`   | `boolean?`| If `true`, this replaces an existing message with the same `id` (streaming) |
| `tool`     | `object?` | Tool call data (see [ToolData](#tooldata)) |
| `stepTokens`| `object?`| Token usage for `step-finish` events: `{ input, output, cache }` |

---

#### `agent:status`

Agent session status changed.

```json
{
  "type": "agent:status",
  "payload": {
    "sessionId": "sess_abc123",
    "agentId": "agent_abc123",
    "taskId": "clxyz123abc",
    "status": "working"
  }
}
```

**`payload` fields:**

| Field       | Type            | Description |
|-------------|-----------------|-------------|
| `sessionId` | `string`        | Session ID |
| `agentId`   | `string`        | Agent ID |
| `taskId`    | `string`        | Task ID |
| `status`    | `SessionStatus` | `idle`, `working`, `error`, `waiting_approval` |

---

#### `task:updated`

A task's fields were updated (by agent workflow, external sync, or MCP tool).

```json
{
  "type": "task:updated",
  "payload": {
    "taskId": "clxyz123abc",
    "updates": {
      "status": "ready_for_review",
      "output_fields": [...]
    }
  }
}
```

**`payload` fields:**

| Field     | Type                   | Description |
|-----------|------------------------|-------------|
| `taskId`  | `string`               | Updated task ID |
| `updates` | `Partial<Task>`        | Changed fields (may be full task object or partial) |

---

#### `task:created`

A new task was created (by agent via MCP tool, or by external sync).

```json
{
  "type": "task:created",
  "payload": {
    "task": { ... }
  }
}
```

**`payload` fields:**

| Field  | Type   | Description |
|--------|--------|-------------|
| `task` | `Task` | Full task object |

---

#### `agent:incompatible-session`

A session was found to be expired or incompatible on the server side.

```json
{
  "type": "agent:incompatible-session",
  "payload": {
    "taskId": "clxyz123abc",
    "agentId": "agent_abc123",
    "error": "This session no longer exists on the server."
  }
}
```

**`payload` fields:**

| Field     | Type     | Description |
|-----------|----------|-------------|
| `taskId`  | `string` | Affected task |
| `agentId` | `string` | Affected agent |
| `error`   | `string` | Human-readable error message |

---

## Type Definitions

### TaskStatus

```
not_started       — Task created, no agent assigned or not yet started
triaging          — Triage agent is evaluating the task
agent_working     — Agent is actively executing
ready_for_review  — Agent finished, awaiting human review
agent_learning    — Agent is learning from feedback
completed         — Task is done
```

### TaskType

```
coding     — Code writing/modification task
manual     — Human-only task
review     — Code review task
approval   — Approval gate task
general    — General task (default)
```

### TaskPriority

```
critical   — Highest priority
high       — High priority
medium     — Normal priority (default)
low        — Low priority
```

### SessionStatus

```
idle              — Session exists but not actively generating
working           — Agent is generating a response
error             — Session encountered an error (can retry with send)
waiting_approval  — Agent is waiting for user approval/answer
```

### PartType

Message `partType` field values:

```
text          — Plain text / markdown content
tool          — Tool invocation (file edit, bash, etc.)
question      — Agent asking user a question (interactive)
todowrite     — Agent managing its internal task list
step-start    — Beginning of a processing step (absorbed by client for timing)
step-finish   — End of a processing step (carries token usage)
error         — Error message
```

### ToolData

When `partType` is `"tool"`, the `tool` object contains:

```json
{
  "name": "Edit",
  "status": "succeeded",
  "title": "Edit src/components/Login.tsx",
  "input": "{ \"file\": \"src/components/Login.tsx\", ... }",
  "output": "File edited successfully",
  "error": null,
  "questions": null,
  "todos": null
}
```

| Field       | Type      | Description |
|-------------|-----------|-------------|
| `name`      | `string`  | Tool name (e.g., `Edit`, `Bash`, `Read`, `Grep`) |
| `status`    | `string`  | `pending`, `running`, `succeeded`, `failed` |
| `title`     | `string?` | Human-readable summary of the tool call |
| `input`     | `string?` | Tool input (usually JSON string) |
| `output`    | `string?` | Tool output text |
| `error`     | `string?` | Error message if tool failed |
| `questions` | `array?`  | Interactive questions (see below) |
| `todos`     | `array?`  | Todo list items (see below) |

**Question format** (when `partType` is `"question"`):

```json
{
  "questions": [
    {
      "header": "Authentication Method",
      "question": "Which authentication method should we use?",
      "options": [
        { "label": "JWT", "description": "JSON Web Tokens" },
        { "label": "OAuth", "description": "OAuth 2.0 flow" }
      ]
    }
  ]
}
```

**Todo format** (when `partType` is `"todowrite"`):

```json
{
  "todos": [
    { "id": "todo_1", "content": "Create login form", "status": "completed" },
    { "id": "todo_2", "content": "Add validation", "status": "in_progress" },
    { "id": "todo_3", "content": "Write tests", "status": "pending" }
  ]
}
```

### Task (Full Object)

```typescript
interface Task {
  id: string
  title: string
  description: string                              // Markdown
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  assignee: string
  due_date: string | null                          // ISO 8601
  labels: string[]
  attachments: FileAttachment[]
  repos: string[]                                  // "owner/repo" format
  output_fields: OutputField[]
  agent_id: string | null
  session_id: string | null                        // Persisted session ID for resume
  external_id: string | null                       // External integration ID
  source_id: string | null                         // Task source ID
  source: string                                   // "local", "linear", "hubspot", etc.
  skill_ids: string[] | null                       // null = use agent defaults
  snoozed_until: string | null                     // ISO 8601; "9999-12-31..." = Someday
  resolution: string | null
  feedback_rating: number | null                   // 1-5
  feedback_comment: string | null
  is_recurring: boolean
  recurrence_pattern: RecurrencePattern | null      // Cron string or object
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  project_id: string                               // Owning project; see GET /api/projects
  created_at: string                               // ISO 8601
  updated_at: string                               // ISO 8601
}
```

### FileAttachment

```typescript
interface FileAttachment {
  id: string
  filename: string
  size: number                                     // Bytes
  mime_type: string
  added_at: string                                 // ISO 8601
}
```

### OutputField

```typescript
interface OutputField {
  id: string
  name: string
  type: OutputFieldType                            // text, number, email, textarea, list, date, file, boolean, country, currency, url
  multiple?: boolean
  options?: string[]
  required?: boolean
  value?: unknown
}
```

### Agent

```typescript
interface Agent {
  id: string
  name: string
  server_url: string                               // Default: "http://localhost:4096"
  config: AgentConfig
  is_default: boolean
  created_at: string
  updated_at: string
}

interface AgentConfig {
  coding_agent?: "opencode" | "claude-code" | "codex" | "cursor" | "pi"
  model?: string
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  secret_ids?: string[]
  max_parallel_sessions?: number                   // 1-10, default 1
  api_keys?: {
    openai?: string
    anthropic?: string
  }
}

interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}
```

### RecurrencePattern

Either a cron expression string or a structured object:

```typescript
type RecurrencePattern = string | RecurrencePatternObject

interface RecurrencePatternObject {
  type: "daily" | "weekly" | "monthly" | "custom"
  interval: number
  time: string                                     // "HH:MM"
  weekdays?: number[]                              // 0=Sun, 6=Sat
  monthDay?: number                                // 1-31
  endDate?: string                                 // ISO 8601
  maxOccurrences?: number
}
```

---

## Message Deduplication Protocol

Clients MUST implement message deduplication using the `data.id` field:

1. Track seen message IDs per task session.
2. If `data.update === true` and `id` is already seen → **replace** the existing message content.
3. If `data.update === false` (or absent) and `id` is already seen → **ignore** (duplicate).
4. `step-start` events: Record timestamp, do not render as a message.
5. `step-finish` events: Compute duration from last `step-start`, annotate last assistant message with `{ durationMs, tokens }`.
6. When a session is resumed, the server replays the full message history. The client should clear its dedup set and message array before processing replayed messages.

---

## Error Handling

| HTTP Status | Meaning |
|-------------|---------|
| `200`       | Success |
| `400`       | Bad request (missing required fields, invalid params, a body that is not a JSON object) |
| `401`       | Unauthorized (missing or invalid auth token) |
| `404`       | Resource not found (task, agent, session) |
| `409`       | The task source could not complete the task |
| `413`       | Request body larger than 1 MB |
| `500`       | Internal server error |

All error responses include:
```json
{ "error": "Descriptive error message" }
```
