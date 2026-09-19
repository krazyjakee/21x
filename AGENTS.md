# AGENTS.md — Multi-Agent Architecture (Implemented)

This document describes the production multi-agent system powering 20x. The architecture spans five agent backends, a centralized polling coordinator, skill management, auto-triage, secret management, and heartbeat monitoring. Orchestration and storage run in the Electron main process on your machine; the agents call whichever model APIs they are configured to use.

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
}

interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}
```

A default agent is seeded on first launch with sensible defaults.

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
```

Database schema migrations are run automatically with version tracking (`SCHEMA_VERSION = 10` in `src/main/database/schema.ts`; see `docs/database-migrations.md`). Migration history includes column additions for attachments, repos, output fields, agent_id, session_id, snoozed_until, recurring tasks, heartbeat, subtasks, and more.

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
  // Optional: getProviders, getAllMessages, getRunningTools, respondToQuestion, notifyConfigChanged
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

### Agent Sessions

| Channel | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `agentSession:start` | renderer -> main | `agentId, taskId, workspaceDir?, skipInitialPrompt?` | `{ sessionId }` |
| `agentSession:resume` | renderer -> main | `agentId, taskId, ocSessionId` | `{ sessionId, ended? }` |
| `agentSession:abort` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stop` | renderer -> main | `sessionId` | `{ success }` |
| `agentSession:stopByTaskId` | renderer -> main | `taskId` | `{ success, sessionId }` |
| `agentSession:send` | renderer -> main | `sessionId, message, taskId?, agentId?, attachments?` | `{ success, ... }` |
| `agentSession:sendByTaskId` | renderer -> main | `taskId, message, attachments?` | `{ success, ... }` |
| `agentSession:approve` | renderer -> main | `sessionId, approved, message?` | `{ success }` |
| `agentSession:getRawTranscript` | renderer -> main | `taskId` | transcript data |

### Agent Events (main -> renderer via `webContents.send`)

| Channel | Payload |
|---------|---------|
| `agent:output` | `{ sessionId, data }` — streaming transcript parts |
| `agent:status` | `{ agentId, status }` — status transitions |

### Agent Config

| Channel | Direction | Description |
|---------|-----------|-------------|
| `agentConfig:getProviders` | renderer -> main | List available models from backend |

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

### Voice Events (main -> renderer and mobile)

| Channel | Payload |
|---------|---------|
| `voice:state` | `{ state, turnId?, detail? }` — state machine transitions |
| `voice:partial` | `{ turnId, text }` — live transcript |
| `voice:final` | `{ turnId, text }` — final transcript |
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

`src/main/agent-manager.ts` — the core orchestration layer. Helpers live in `src/main/agent-manager/` (adapter factory, session config, workspace docs and skill files, attachments, skill sync, MCP server test, prompts, transcript events, watchdogs, output dedup, worktree setup).

```typescript
class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession>
  private pollingEntries: Map<string, PollingEntry>
  private adapters: Map<string, CodingAgentAdapter>

  // Session lifecycle
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string>
  async resumeSession(agentId: string, taskId: string, ocSessionId: string): Promise<string | null>
  async stopSession(sessionId: string): Promise<void>
  async abortSession(sessionId: string): Promise<void>
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | undefined }>
  stopAllSessions(): void
  async stopServer(): Promise<void>

  // Communication
  async sendMessage(sessionId: string, message: string, taskId?: string, agentId?: string, attachments?): Promise<{ role }>
  async sendByTaskId(taskId: string, message: string, attachments?): Promise<{ role }>
  async respondToPermission(sessionId: string, approved: boolean, message?: string): Promise<void>

  // Skills
  syncSkillsFromWorkspace(sessionId: string): SkillSyncResult

  // Diagnostics
  async getRawTranscriptForDebug(taskId: string): Promise<any>

  // Providers
  async getProviders(serverUrl?, directory?, backendType?): Promise<...>
}
```

### Session Lifecycle

Each session wraps a coding agent adapter instance and streams events to the renderer via IPC.

1. **Start** — Agent assigned, worktree setup, skill files written to workspace, MCP servers configured, session created
2. **Streaming** — Centralized polling coordinator polls every 2s; adapter nudges on new data (50ms debounce)
3. **Approval** — Agent pauses for human decisions; response sent back via `agentSession:approve`
4. **Completion** — Idle detection transitions to `ready_for_review`, task updated
5. **Learning** — Optional feedback loop: the feedback prompt is sent to the session; when it goes idle, skills are synced back to DB and the task is completed

### Worktree Management

Before starting an agent session, the AgentManager optionally sets up git worktrees for the task's repositories:
- Fetches repo metadata from GitHub or GitLab
- Creates isolated worktrees per branch per task
- Supports multiple repos across different orgs
- Falls back gracefully if worktree setup fails

### Secret Broker

Secrets (encrypted API keys, database URLs, etc.) are injected into agent sessions:
- **Encryption**: Values encrypted with Electron `safeStorage` at rest
- **Secret Broker**: An HTTP server on `localhost` that serves secrets to the agent's shell process
- **Wrapper script**: `secret-shell.sh` intercepts bash commands to inject env vars
- **Claude Code path**: `SHELL` points at the wrapper, and `PreToolUse` hooks inject secrets (`buildSecretHooks` in `claude-code-options.ts`)
- **System prompt awareness**: Agents are told which secrets are available (name/description only — never the value)

### Task API Server

`src/main/task-api-server.ts` (routes in `src/main/task-api/*-routes.ts`) serves the task-management HTTP API on `127.0.0.1` (random port). Every request must present a per-launch random token (`getTaskApiToken()`), either as `Authorization: Bearer <token>` or as a `?token=` query parameter:
- HTTP MCP sessions get the token in the MCP URL (`?token=`), built in `src/main/agent-manager/session-config.ts`
- The stdio `task-management-mcp.js` server reads `TASK_API_URL` and `TASK_API_TOKEN` from its environment (`getTaskApiEnv()`) and sends the token as a bearer header

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

## Auto-Triage System

When auto-run is enabled and a new task has no `agent_id`, the system automatically triages it using the default agent (see `docs/task-lifecycle.md`):

```
New task (no agent_id, status=not_started)
  → selectTriageCandidates() detects it
  → startTriage() → status='triaging' → start default agent
  → Agent runs MCP tools:
    find_similar_tasks, list_agents, list_skills, list_repos
    update_task(agent_id, skill_ids, labels, priority, repos)
  → Agent goes idle → status back to 'not_started'
  → Auto-run picks up assigned task → starts real agent
```

- **Retry limit**: Max 2 triage attempts per task
- **Status guard**: API skips status changes during triage
- **Session cleanup**: Triage session removed from store post-completion

## Skills System

Skills are reusable `SKILL.md` instructions that agents discover and load on-demand during sessions.

### Data Model

- **Task-level**: `task.skill_ids`
- **Agent-level**: `agent.config.skill_ids`
- Both selections are merged; when neither is set, no skill files are written

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
