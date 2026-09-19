# AGENTS.md — Multi-Agent Architecture (Implemented)

This document describes the production multi-agent system powering 20x. The architecture spans five agent backends, a centralized polling coordinator, admission control, project-scoped work (projects, per-project Captain, per-project skills), auto-triage, agent handoff on credit exhaustion, secret management, and heartbeat monitoring. Orchestration and storage run in the Electron main process on your machine; the agents call whichever model APIs they are configured to use.

## Overview

20x supports running multiple AI coding agents in parallel, each working on assigned tasks within specific codebases. Agents are managed through adapter interfaces and interact with users via streaming transcripts with human-in-the-loop (HITL) approval flows. Five backends are supported (`CodingAgentType` in `src/main/agent-manager/adapter-factory.ts`): **OpenCode**, **Claude Code**, **Codex**, **Cursor**, and **Pi**.

## Agent Model

Each agent is a persistent configuration stored in SQLite:

```typescript
interface AgentRecord {
  id: string                    // cuid2
  name: string                  // e.g. "Backend Agent", "Frontend Agent"
  server_url: string            // Default: 'http://localhost:4096'
  config: AgentConfigRecord     // stored as JSON
  is_default: boolean           // one agent is pre-seeded on first launch
  created_at: string
  updated_at: string
}

interface AgentConfigRecord {
  coding_agent?: 'opencode' | 'claude-code' | 'codex' | 'cursor' | 'pi'
  model?: string
  reasoning_effort?: ReasoningEffort
  auth_method?: 'subscription' | 'api_key'
  permission_mode?: 'ask' | 'allow'
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  secret_ids?: string[]
  api_keys?: {
    openai?: string
    anthropic?: string
    cursor?: string
  }
  fallback_agent_ids?: string[]  // tried in order on credit exhaustion (agent handoff)
  max_parallel_sessions?: number // admission control; default 1
}

interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}
```

A default agent is seeded on first launch with sensible defaults. These types live in `src/main/database/types.ts`.

## Database Schema

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
  config TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tasks table has agent_id for assignment:
ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;

-- Skills table stores reusable instructions:
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  preferred_model TEXT,                      -- optional: pin a model for this skill
  project_id TEXT REFERENCES projects(id),   -- null = global skill
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Secrets table for encrypted env vars:
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  env_var_name TEXT NOT NULL UNIQUE,
  value BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MCP servers table:
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'local',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  environment TEXT NOT NULL DEFAULT '{}',
  tools TEXT NOT NULL DEFAULT '[]',
  oauth_metadata TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Projects: tasks belong to a project; per-project repos and resources:
--   projects, project_repos, project_resources (+ captain_agent_id, settings)
```

Database schema migrations are run automatically with version tracking (`SCHEMA_VERSION = 17` in `src/main/database/schema.ts`; see `docs/database-migrations.md`). Migration history includes column additions for attachments, repos, output fields, agent_id, session_id, snoozed_until, recurring tasks, heartbeat, subtasks, and more; later versions added `tasks.complete_at_source`, `tasks.next_subtask_ids`, `tasks.role` (coordinator rows such as the Captain), `skills.preferred_model`, the `projects` / `project_repos` / `project_resources` tables with project IDs on tasks and sources (existing tasks migrated into the Default project), `skills.project_id` for global-vs-project skill scoping, and version 17 renames the coordinator from Mastermind to Captain (`tasks.role = 'captain'`, `projects.captain_agent_id`, the `captain_prewarm` setting, and `captain_wakeups` in project settings; `src/main/database/captain-migration.ts`).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Renderer Process                       │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Agent Panel  │  │ Task Detail  │  │ Agent Settings │  │
│  │ (streaming   │  │ (assign      │  │ (CRUD agents,  │  │
│  │  transcript) │  │  agent)      │  │  MCP config)   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         └────────┬────────┴───────────────────┘           │
│                  │ IPC                                     │
├──────────────────┼────────────────────────────────────────┤
│                  │       Main Process                      │
│                  ▼                                         │
│  ┌──────────────────────────────────────────────────┐     │
│  │              Agent Manager                        │     │
│  │                                                   │     │
│  │  ┌─────────────┐  ┌──────────────┐               │     │
│  │  │  Polling    │  │  Adapter     │               │     │
│  │  │  Coordinator│  │  Registry    │               │     │
│  │  │  (2s tick)  │  │              │               │     │
│  │  └─────────────┘  └──────┬───────┘               │     │
│  │                          │                        │     │
│  │     ┌─────────┬──────────┼────────┬─────────┐    │     │
│  │     ▼         ▼          ▼        ▼         ▼    │     │
│  │ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐│     │
│  │ │  Open │ │ Claude│ │ Codex │ │  ACP  │ │   Pi  ││     │
│  │ │  Code │ │  Code │ │ AppSrv│ │ Cursor│ │       ││     │
│  │ │       │ │       │ │       │ │ +Codex│ │       ││     │
│  │ └───────┘ └───────┘ └───────┘ └───────┘ └───────┘│     │
│  │                                                   │     │
│  │  ┌──────────────┐                                │     │
│  │  │Secret Broker  │                                │     │
│  │  │(env injection)│                                │     │
│  │  └──────────────┘                                │     │
│  └──────────────────────────────────────────────────┘     │
│                                                           │
│  ┌───────────────────────┐  ┌──────────────────────────┐  │
│  │   Worktree Manager    │  │   Database Manager       │  │
│  │                       │  │                           │  │
│  │ - Git worktree setup  │  │ - All table CRUD         │  │
│  │ - Per-task workspace  │  │ - Schema migrations      │  │
│  │ - Multi-repo support  │  │                           │  │
│  └───────────────────────┘  └──────────────────────────┘  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Task Source  │  │ Heartbeat    │  │ Task API       │  │
│  │ Sync Manager │  │ Scheduler    │  │ Server (MCP)   │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│                                                           │
└───────────────────────────────────────────────────────────┘
               │
               ▼
  ┌──────────────────────────────┐
  │  Agent Backend Servers       │
  │                              │
  │  - OpenCode (localhost:4096) │
  │  - Claude Code (agent SDK)   │
  │  - codex app-server (stdio)  │
  │  - cursor-agent (ACP, stdio) │
  │  - Pi (JSONL RPC, stdio)     │
  │  - MCP servers (stdio/http)  │
  └──────────────────────────────┘
```

## Adapter Architecture

Each coding agent backend is wrapped in a standard `CodingAgentAdapter` interface (`src/main/adapters/coding-agent-adapter.ts`):

```typescript
interface CodingAgentAdapter {
  initialize(): Promise<void>
  createSession(config: SessionConfig): Promise<string>
  resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>
  sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void>
  getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus>
  pollMessages(sessionId: string, seenMessageIds, seenPartIds, partContentLengths, config): Promise<MessagePart[]>
  abortPrompt(sessionId: string, config: SessionConfig): Promise<void>
  destroySession(sessionId: string, config: SessionConfig): Promise<void>
  checkHealth(): Promise<{ available: boolean; reason?: string }>
  // Optional: getProviders, getAllMessages, getPersistedMessages, getRunningTools, respondToQuestion, notifyConfigChanged
}
```

### OpenCode Adapter (`src/main/adapters/opencode-adapter.ts`)

Uses `@opencode-ai/sdk` to communicate with the OpenCode server (typically running on `localhost:4096`). This is the default backend. Supports MCP server registration, streaming, and HITL approval via the SDK's native event model.

### Claude Code Adapter (`src/main/adapters/claude-code-adapter.ts`)

Uses `@anthropic-ai/claude-agent-sdk` (`query()`), passing MCP servers through the SDK's `mcpServers` option and secrets through a `SHELL` wrapper plus `PreToolUse` hooks. Supports `subscription` (OAuth/Pro/Max) and `api_key` (pay-per-use) auth methods. Permission mode can be `ask` (HITL approval) or `allow` (automatic).

### Codex Adapter (`src/main/adapters/codex-app-server-adapter.ts`)

Spawns `codex app-server` and speaks its JSON-RPC protocol over stdio, mapping app-server threads/turns/items onto the adapter contract. This is the only Codex backend; every backend is created by `createAdapter` in `src/main/agent-manager/adapter-factory.ts`.

### ACP Adapter (`src/main/adapters/acp-adapter.ts`)

Implements the Agent Client Protocol (ACP): JSON-RPC 2.0 over stdio, newline-delimited. Used for Cursor (`cursor-agent`).

### Pi Adapter (`src/main/adapters/pi-adapter.ts`)

Keeps one Pi process per live session and talks to it over Pi's JSONL RPC protocol on stdin/stdout.

## Polling Coordinator

Instead of independent timers per session (which would cause event-loop starvation under load), a single centralized timer polls all active sessions sequentially every 2 seconds:

```typescript
// src/main/agent-manager.ts — PollingEntry tracking
interface PollingEntry {
  sessionId: string
  adapter: CodingAgentAdapter
  seenMessageIds: Set<string>        // Dedup
  seenPartIds: Set<string>           // Dedup
  partContentLengths: Map<string, string>  // Content-level dedup
  initialPromptSent?: boolean
  createdAt: number
  hasSeenWork?: boolean
  // ...
}
```

Features:
- **Dedup by ID and content length** — avoids re-processing the same messages
- **Idle-to-completion transition** — after a grace period with no activity, transitions from `agent_working` → `ready_for_review`
- **Stuck session watchdog** — aborts after 5 minutes with no new data
- **Stuck tool detector** — aborts individual tools after 90 seconds (e.g., cross-workspace file reads)
- **Garbled output detection** — aborts when model hallucinates tool-call markup
- **Event-driven nudge** — adapters call `onDataAvailable()` to trigger an immediate poll (50ms debounce) instead of waiting for the 2s tick
- **Memory safety** — capped dedup structures (5K entries), 10MB per-session value limit, 200 session redirects
- **tillDone nudge** — capped at 5 nudges per session

## IPC Channels

### Agent CRUD

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agent:getAll` | renderer -> main | — | `Agent[]` |
| `agent:create` | renderer -> main | `CreateAgentData` | `Agent` |
| `agent:update` | renderer -> main | `id, UpdateAgentData` | `Agent` |
| `agent:delete` | renderer -> main | `id` | `boolean` |
| `agent:getStartQueue` | renderer -> main | — | queued start requests with positions and reasons |

### Agent Sessions

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agentSession:start` | renderer -> main | `agentId, taskId, workspaceDir?, skipInitialPrompt?` | `{ sessionId }` — or `{ sessionId: '', queued: true, queuePosition, queueReason }` when over a concurrency limit |
| `agentSession:resume` | renderer -> main | `agentId, taskId, ocSessionId` | `{ sessionId, ended? }` |
| `agentSession:abort` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stop` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stopByTaskId` | renderer -> main | `taskId` | `{ success, sessionId }` |
| `agentSession:send` | renderer -> main | `sessionId, message, taskId?, agentId?, attachments?` | `{ success, ... }` |
| `agentSession:sendByTaskId` | renderer -> main | `taskId, message, attachments?` | `{ success, ... }` |
| `agentSession:approve` | renderer -> main | `sessionId, approved, message?, responseType?, requestId?` | `{ success }` |
| `agentSession:getRawTranscript` | renderer -> main | `taskId` | transcript data |
| `agentSession:switchAgent` | renderer -> main | `taskId, newAgentId` | `{ sessionId }` — stops the current agent and continues on the new one with a handoff recap |
| `agentSession:getTranscriptSnapshot` | renderer -> main | `taskId, sinceSeq?` | durable transcript parts (projection snapshot) |
| `agentSession:getTranscriptDelta` | renderer -> main | `taskId, sinceRev` | `{ parts, maxRev }` — parts changed since the rev cursor |

The transcript is an event-sourced projection owned by the main process (`transcript_parts`): the renderer hydrates once with `agentSession:getTranscriptSnapshot` and then applies idempotent `transcript:changed` deltas — see `docs/transcript-event-sourcing-rewrite.md`.

### Agent Events (main -> renderer via `webContents.send`)

| Channel | Payload |
|---------|---------|
| `agent:output` | `{ sessionId, taskId, type, data }` — streaming transcript part |
| `agent:output-batch` | `{ sessionId, taskId, messages }` — the same parts coalesced per tick (one IPC call) |
| `agent:status` | `{ sessionId, agentId, taskId, status }` — status transitions |
| `agent:startQueueChanged` | `{ queue }` — admission start queue updated |
| `agent:incompatible-session` | `{ taskId, agentId, error }` — a resume failed; the renderer asks whether to start fresh |
| `transcript:changed` | `{ taskId, parts, maxRev }` — projection delta (`{ parts: [], maxRev: 0, reloadRequired: true }` when a record is too large to serialize) |

### Agent Config

| Channel | Direction | Description |
|---------|-----------|-------------|
| `agentConfig:getProviders` | renderer -> main | List available models from backend |

### Agent Installer

| Channel | Direction | Description |
|---------|-----------|-------------|
| `agent-installer:detect` | renderer -> main | Detect installed backend CLIs (Claude Code, OpenCode, Codex, Cursor, Pi) with versions and support status |
| `agent-installer:install` | renderer -> main | Install a backend CLI (`src/main/agent-installer/`); progress streams via `agent-installer:progress` |

### Voice control

Speech to text runs on the user's computer. The local speech runtime is an
**optional** install offered in the setup dialog and in Voice settings; until it
is present, every voice control is hidden. See `docs/voice.md` for the design,
the safety rules, and the release gates that are still open.

Spoken answers are the other half. They need neither the microphone nor that
runtime, because the system voice needs nothing: `voice:tts:*` handlers and the
`voice:speech:*` events are described in `docs/voice-tts.md`. Speech audio is
sent to the desktop window only, never to a mobile client.

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `voice:getSnapshot` | renderer -> main | — | `VoiceSnapshot` |
| `voice:setEnabled` | renderer -> main | `{ enabled }` | `VoiceSnapshot` |
| `voice:getPermission` | renderer -> main | — | `{ status }` |
| `voice:requestPermission` | renderer -> main | — | `{ status }` |
| `voice:startTurn` | renderer -> main | `{ mode, context }` | `{ turnId }` or `{ error }` |
| `voice:pushAudio` | renderer -> main | `{ turnId, chunk }` — 16 kHz mono PCM | — |
| `voice:endTurn` | renderer -> main | `{ turnId }` | — |
| `voice:cancelTurn` | renderer -> main | `{ turnId? }` | — |
| `voice:confirm` | renderer -> main | `{ turnId, choice? }` | `{ success }` |
| `voice:dismiss` | renderer -> main | `{ turnId }` | — |
| `voice:getRuntime` | renderer -> main | — | `VoiceRuntimeStatus` |
| `voice:installRuntime` | renderer -> main | — | `VoiceRuntimeStatus` |
| `voice:removeRuntime` | renderer -> main | — | `VoiceRuntimeStatus` |
| `voice:installModel` | renderer -> main | `{ id }` | `VoiceModelState` |
| `voice:removeModel` | renderer -> main | `{ id }` | `{ success }` |
| `voice:removeAllModels` | renderer -> main | — | `{ success }` |
| `voice:setCustomModelDir` | renderer -> main | `{ dir }` | `VoiceSnapshot` |
| `voice:pickModelDir` | renderer -> main | — | `{ dir }` |
| `voice:setShortcut` | renderer -> main | `{ accelerator }` | `VoiceSnapshot` |
| `voice:selectModel` | renderer -> main | `{ id }` — pick the active recognition model for a turn | `{ success }` |
| `voice:setEndpointSilence` | renderer -> main | `{ ms }` — endpointing sensitivity | `VoiceSnapshot` |
| `voice:expectAnswer` | renderer -> main | — | expect a spoken answer (keeps the turn listening) |
| `voice:answerNotExpected` | renderer -> main | — | clear the answer expectation |

### Voice Events (main -> renderer and mobile)

| Channel | Payload |
|---------|---------|
| `voice:state` | `{ state, turnId?, detail? }` — state machine transitions |
| `voice:partial` | `{ turnId, text }` — live transcript |
| `voice:final` | `{ turnId, text }` — final transcript |
| `voice:segment` | `{ turnId, text, index }` — completed sentence for progressive display |
| `voice:outcome` | `VoiceActionOutcome` — confirm, executed, rejected, cancelled |
| `voice:status` | engine and model status |
| `voice:error` | `{ message, code? }` |
| `voice:navigate` | `{ destination, taskId }` — validated navigation request |
| `voice:dictate` | `{ turnId, text }` — words for the focused text control |
| `voice:hotkey` | `{ action }` — the global shortcut fired |
| `voice:runtimeProgress` | `{ stage, output, percent }` — optional runtime install |

A voice task action calls the same services as the user interface, so it emits
the normal `task:created` and `task:updated` events. There is no second state
writer for voice.

## Agent Manager

`src/main/agent-manager.ts` — the core orchestration layer. Helpers live in `src/main/agent-manager/` (adapter factory, session config, workspace docs and skill files, attachments, skill sync, MCP server test, prompts, transcript events, watchdogs, output dedup, worktree setup, admission control, credit-exhaustion detection, Captain context, project repos, skill model resolution).

```typescript
class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession>
  private pollingEntries: Map<string, PollingEntry>
  private adapters: Map<string, CodingAgentAdapter>

  // Session lifecycle (every start goes through admission control)
  async requestSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<SessionStartOutcome>
  async startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<{ action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'queued' | 'no_action', ... }>
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string>
  async switchAgent(taskId: string, newAgentId: string): Promise<string>
  async resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string>
  async stopSession(sessionId: string, resetTaskStatus?: boolean): Promise<void>
  async abortSession(sessionId: string): Promise<void>
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | null }>
  async stopAllSessions(): Promise<void>
  async stopServer(): Promise<void>

  // Communication
  async sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string, attachments?): Promise<{ role }>
  async sendByTaskId(taskId: string, message: string, attachments?): Promise<{ role }>
  async respondToPermission(sessionId: string, approved: boolean, message?: string): Promise<void>

  // Skills
  syncSkillsFromWorkspace(sessionId: string): SkillSyncResult

  // Transcript projection (event-sourced; docs/transcript-event-sourcing-rewrite.md)
  async getTranscriptSnapshot(taskId: string, sinceSeq?: number): Promise<TranscriptPart[]>
  async getTranscriptDelta(taskId: string, sinceRev: number): Promise<{ parts: TranscriptPart[]; maxRev: number }>

  // Diagnostics
  async getRawTranscriptForDebug(taskId: string): Promise<any>

  // Providers
  async getProviders(serverUrl?, directory?, backendType?): Promise<...>
}
```

### Session Lifecycle

Each session wraps a coding agent adapter instance and streams events to the renderer via IPC.

1. **Start** — Admission control admits the start or queues it; then worktree setup, skill files written to workspace, MCP servers configured, session created
2. **Streaming** — Centralized polling coordinator polls every 2s; adapter nudges on new data (50ms debounce)
3. **Approval** — Agent pauses for human decisions; response sent back via `agentSession:approve`
4. **Completion** — Idle detection transitions to `ready_for_review`, task updated
5. **Learning** — Optional feedback loop: the feedback prompt is sent to the session; when it goes idle, skills are synced back to DB and the task is completed

### Admission Control and Start Queue

Every session start in the main process — UI, auto-run, MCP `start_task`, mobile API, voice, schedulers — goes through `AgentManager.requestSession`, which asks `checkAdmission` (`src/main/agent-manager/admission.ts`) whether the start fits under the limits. If not, the start waits in a FIFO `StartQueue` in the main process and runs on its own when a counted session goes idle or stops; the window does not have to be open.

- **Counted**: only real-task sessions that are working (`working` or `waiting_approval`); idle sessions hold no slot. Coordinator (Captain), heartbeat, and triage sessions are exempt — they neither count nor queue.
- **Limits**: per-agent `agent.config.max_parallel_sessions` (default 1); the global `max_concurrent_agent_sessions` setting (0/empty = unlimited); per-project `projects.settings.limits` (`max_concurrent_agents`, `daily_session_cap`, `paused`) plus the `all_projects_paused` setting (`src/main/project-limits.ts`).
- **Surface**: `agent:getStartQueue`, the `agent:startQueueChanged` event, and the queued `agentSession:start` reply.

### Agent Handoff (Credit Exhaustion)

When the backend reports exhausted credits or quota, `src/main/agent-manager/credit-exhaustion.ts` detects it from output, errors, and status. The session is then stopped and, if `agent.config.fallback_agent_ids` is set, the task continues on the first configured fallback agent. `src/main/agent-handoff.ts` builds a handoff recap from the transcript (capped at 800k chars); the new agent starts with the recap plus a continuation prompt. The manual "Switch agent" action uses the same path via `agentSession:switchAgent`.

### Task Automation (main process)

`src/main/task-automation-scheduler.ts` runs a 60-second reconciliation loop in the main process so `auto_start_agent` (start `not_started` tasks) and `auto_complete_without_review` (complete `ready_for_review` tasks) keep working with no window open. It is the backstop for the renderer's sidebar auto-run hook (`use-agent-auto-start.ts`), which decides *what* to start (triage, next subtask, eligible tasks by priority); *whether* it may run now is always the main process's call (admission control).

### Worktree Management

Before starting an agent session, the AgentManager optionally sets up git worktrees for the task's repositories:
- Fetches repo metadata from GitHub, GitLab, or Forgejo (per-repo provider mapping in `src/main/repo-providers.ts`)
- Creates isolated worktrees per branch per task
- Supports multiple repos across different orgs
- Falls back gracefully if worktree setup fails

### Secret Broker

Secrets (encrypted API keys, database URLs, etc.) are injected into agent sessions:
- **Encryption**: Values encrypted with Electron `safeStorage` at rest
- **Secret Broker**: An HTTP server on `localhost` that serves secrets to the agent's shell process
- **Wrapper script**: `secret-shell.sh` intercepts bash commands to inject env vars
- **Claude Code path**: `SHELL` points at the wrapper, and `PreToolUse` hooks inject secrets (`buildSecretHooks` in `claude-code-adapter.ts`)
- **System prompt awareness**: Agents are told which secrets are available (name/description only — never the value)

### Task API Server

`src/main/task-api-server.ts` (routes in `src/main/task-api/*-routes.ts`) serves the task-management HTTP API on `127.0.0.1` (random port). Every request must present a per-launch random token (`getTaskApiToken()`), either as `Authorization: Bearer <token>` or as a `?token=` query parameter:
- HTTP MCP sessions get the token in the MCP URL (`?token=`), built in `src/main/agent-manager/session-config.ts`
- The stdio task-management MCP server (source `src/main/mcp-servers/task-management-mcp.ts`, compiled to `out/main/mcp-servers/task-management-mcp.js`) reads `TASK_API_URL` and `TASK_API_TOKEN` from its environment (`getTaskApiEnv()`) and sends the token as a bearer header

### Memory Management

- `MAX_DEDUP_ENTRIES = 5_000` per session — prevents OOM from unbounded sets
- `MAX_VALUE_CHARS_PER_SESSION = 10_000_000` — prevents OOM from large part content
- `MAX_SESSION_REDIRECTS = 200` — prevents unbounded redirect map growth
- `MAX_TILLDONE_NUDGES = 5` — prevents infinite nudge loops
- `STUCK_SESSION_TIMEOUT_MS = 300_000` (5 min) — aborts hung sessions
- `STUCK_TOOL_TIMEOUT_MS = 90_000` (90 sec) — aborts hung tools

## UI Components

### Agent Settings Page

- List of configured agents with name, coding agent type, model
- Create/edit/delete agents
- Per-agent MCP server configuration (add/remove servers, set commands and environment, enable/disable tools)
- Coding agent selection (OpenCode / Claude Code / Codex / Cursor / Pi)
- Auth method (subscription vs API key) and permission mode (ask vs allow)
- Skill assignment picker
- Secret assignment picker
- Concurrency cap (`max_parallel_sessions`) and fallback-agent picker (handoff on credit exhaustion)
- Model selection dropdown (fetched from backend)
- Test connection button

### Agent Assignment

- Task detail view has an "Assign Agent" dropdown
- Shows available agents with their current status (idle, working, error)
- Assigning starts a session automatically
- **Auto-Triage**: When auto-run is enabled and a task has no agent assigned, the default agent automatically triages the task
- A manual "Triage" button is available on tasks with no agent assigned

### Agent Transcript Panel

- Split view: task detail on left, agent transcript on right
- Streaming terminal output with message part rendering (text, reasoning, tool calls, progress events)
- HITL permission requests and agent questions appear in the transcript; the user's reply is sent via `agentSession:approve`
- Todo list tracking from agent output
- Session status indicator (idle, working, error, waiting_approval)

### Dashboard Workspace

- Command input for the current project's Captain (one per project, see `docs/task-lifecycle.md` → Coordinator rows) and task creation, with quick-start chips
- Kanban task board grouped by status with drag-and-drop support

## Projects and Captain

Tasks belong to a **project** (`projects` table; all existing tasks migrated into the Default project). Projects own repositories (`project_repos`) and resources (`project_resources`) that agents can reference; triage may only assign repos from the task's project, and skills are scoped per project (see Skills System).

Each project's **Captain** (renamed from "Mastermind" in schema v17; `src/main/database/captain-migration.ts` is the only file that may still spell the old name) is a durable coordinator row in `tasks` with `role = 'captain'` and the project's `project_id`. `seedCaptainTasks` gives every project one on startup (idempotent), and `createProject` creates one with the project (`ensureProjectCaptain`). It is a row so its `session_id` and transcript persist like a task's, but `isCoordinatorTask()` (`src/shared/task-roles.ts`) keeps it out of every task list — board, sidebar, mobile, MCP list tools.

- Runs in its own workspace (no worktree) on the project's `captain_agent_id` (else `default_agent_id`, else the app default agent)
- System prompt: the built-in Captain prompt (`src/main/prompts/captain.ts`) plus a project section rebuilt on every start/resume/send from the project row, its repos, and resources (`src/main/agent-manager/captain-context.ts`)
- Keeps a long-lived `MEMORY.md` in its workspace (decisions, conventions, open threads) that is injected into the prompt (capped) and shown read-only in the project editor
- Project events (`approval_pending`, `task_failed`, ...) flow through the project event bus (`src/main/project-events.ts`); `src/main/captain-waker.ts` batches them (3s debounce, hourly cap, self-caused events skipped) and wakes the project's Captain with one fenced system message, window open or not

## Auto-Triage System

When auto-run is enabled and a new task has no `agent_id`, the system automatically triages it using the default agent (see `docs/task-lifecycle.md`). The renderer's sidebar auto-run hook (`use-agent-auto-start.ts`) or the main-process `TaskAutomationScheduler` calls `AgentManager.startTask(taskId)`; for an unassigned task with triage allowed, `startTask` does the rest:

```
Task (no agent_id, status=not_started)
  → AgentManager.startTask() → status='triaging' → startSession(default agent)
  → Initial prompt = buildTriagePrompt(task, projectRepos)
  → Agent runs task-management MCP tools:
    find_similar_tasks, list_agents, list_skills, list_repos
    create_subtask (if the task clearly splits)
    update_task(agent_id, output_fields, skill_ids, labels, priority, repos
                — repos restricted to the task's project)
  → Agent goes idle → triage detected → status back to 'not_started'
  → Auto-run picks up the now-assigned task → starts the real agent
```

- **Retry limit**: `MAX_TRIAGE_ATTEMPTS = 2` in the auto-run hook
- **Status guard**: the task API skips status changes while a task is `triaging`
- **Admission-exempt**: triage sessions never queue
- **Session cleanup**: the triage session is released post-completion; the real run starts a fresh session

## Skills System

Skills are reusable `SKILL.md` instructions that agents discover and load on-demand during sessions.

### Data Model

- **Task-level**: `task.skill_ids` — global skills and the task's project's own skills
- **Agent-level**: `agent.config.skill_ids` — global skills only (an agent serves every project)
- Both selections are merged; when neither is set, no skill files are written
- **Scope**: a skill is global (`skills.project_id` null) or a project skill (`project_id` set, schema 16, `migrateSkillScope`). Project skills never shadow global ones; assigning another project's skill is rejected (`validateSkillAssignment`), and `writeSkillFiles` only writes what the task's project may see
- **Preferred model**: `skills.preferred_model` pins a model for a skill; session setup validates it against the backend's model listing (`src/main/agent-manager/skill-model.ts`) and uses it when supported

### File Layout

```
workspaces/<taskId>/
  .agents/skills/<name>/SKILL.md   (all other agents)
  .claude/skills/<name>/SKILL.md    (Claude Code)
```

### Feedback Learning Loop

1. User completes task → FeedbackDialog (1-5 stars + optional comment)
2. Task status is set to `agent_learning` and the feedback prompt is sent to the session (`useTaskFeedbackFlow.ts`)
3. Agent reviews session transcript, updates SKILL.md files (confidence and usage stats in frontmatter)
4. When the session goes idle, `syncSkillsFromWorkspace()` syncs changes back to SQLite
5. `finishSessionFeedback()` completes the task (and at the source, if chosen); on failure the task returns to `ready_for_review`

## HITL (Human-in-the-Loop) Flow

1. Agent encounters a potentially destructive action (file write, shell command, etc.)
2. The backend adapter emits an approval event
3. Main process forwards it to the renderer as a transcript part
4. The transcript shows the request; the user replies there
5. User decision sent back via `agentSession:approve`
6. Agent continues or aborts based on response

## Heartbeat Monitoring

`src/main/heartbeat-scheduler.ts` runs periodic checks for tasks with heartbeat enabled:

- Each task's workspace `heartbeat.md` lists what to watch (PR comments, CI status, issue updates)
- Configurable per-task interval (default: 30 minutes, `HEARTBEAT_DEFAULTS` in `src/shared/constants.ts`)
- Scheduler checks for due tasks every 60 seconds
- Cheap `gh api` preflight (`src/main/heartbeat-preflight.ts`) runs first; the agent session is skipped when nothing changed
- Status: ok, info, attention_needed, error
- Logs stored in `heartbeat_logs` table
- Disabled when the task is completed; skipped for subtasks whose parent is completed

## Key Source Files

| File | Role |
|------|------|
| `src/main/agent-manager.ts` | Core orchestration, session lifecycle, polling, skills, secrets |
| `src/main/adapters/coding-agent-adapter.ts` | Adapter interface definition |
| `src/main/adapters/opencode-adapter.ts` | OpenCode SDK integration |
| `src/main/adapters/claude-code-adapter.ts` | Claude Code via `@anthropic-ai/claude-agent-sdk` |
| `src/main/adapters/codex-app-server-adapter.ts` | Codex via `codex app-server` |
| `src/main/adapters/acp-adapter.ts` | Agent Client Protocol (Cursor) |
| `src/main/adapters/pi-adapter.ts` | Pi JSONL RPC integration |
| `src/main/agent-manager/mcp-server-test.ts` | MCP connection probe (stdio + HTTP) behind `mcp:testConnection` |
| `src/main/agent-manager/admission.ts` | Admission control + FIFO start queue |
| `src/main/agent-manager/credit-exhaustion.ts` | Credit-exhaustion detection |
| `src/main/agent-handoff.ts` | Handoff recap + fallback-agent switch |
| `src/main/task-automation-scheduler.ts` | Main-process auto start/complete reconciliation |
| `src/main/captain-waker.ts` | Batches project events and wakes the Captain |
| `src/main/prompts/captain.ts` | Built-in Captain system prompt |
| `src/main/mcp-servers/task-management-mcp.ts` | stdio task-management MCP server (compiled to `out/main/`) |
| `src/main/agent-installer/` | Backend CLI detection and installation |
| `src/main/mcp-client-messages.ts` | Hand-written MCP handshake messages shared by the probe and OAuth discovery |
| `src/main/ipc-handlers.ts` | IPC entry point; calls the `register*` functions in `src/main/ipc/*.ts` |
| `src/main/ipc/*.ts` | IPC channel handlers by area (agents, tasks, task sources, settings, ...) |
| `src/main/database.ts` | SQLite CRUD |
| `src/main/database/schema.ts` | SQLite schema, migrations, `SCHEMA_VERSION` |
| `src/main/worktree-manager.ts` | Git worktree setup |
| `src/main/secret-broker.ts` | Secret injection HTTP server |
| `src/main/task-api-server.ts` | HTTP API for task-management MCP (routes in `src/main/task-api/`) |
| `src/main/sync-manager.ts` | Task source import, export and actions |
| `src/main/heartbeat-scheduler.ts` | Task-level heartbeat scheduling |
| `src/main/recurrence-scheduler.ts` | Recurring task scheduling |
| `src/main/claude-plugin-manager.ts` | Claude Plugin marketplace |
| `docs/task-lifecycle.md` | Auto-triage and state transitions |
| `docs/skills.md` | Skills system documentation |
| `docs/transcript-event-sourcing-rewrite.md` | Transcript projection design record |
