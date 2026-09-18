<p align="center">
  <img src="resources/icon.png" alt="20x Logo" width="120" />
</p>

# 20x

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/krazyjakee/21x)](./package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](.)

**One app. All your tasks. Powered by AI agents.**

20x is a desktop app that turns your task list into an AI-powered workforce. Connect your tools — Linear, HubSpot, YouTrack, GitHub Issues, GitLab, Notion — assign tasks to AI agents, and watch them work in real time.

This repository (krazyjakee/21x) is a personal fork of [peakflo/20x](https://github.com/peakflo/20x) with the Peakflo enterprise/Workflo features removed. The app is still called 20x.

Tasks, transcripts and settings live in a local SQLite database, and there is no 20x account or server. The agents themselves call whichever cloud model APIs you configure, and the integrations talk to the SaaS products they connect to.

<p align="center">
  <img src="resources/product-demo.gif" alt="20x product demo" />
</p>

## Why 20x?

Most AI tools make you copy-paste context between tabs. 20x flips it: **your tasks come to the agents, not the other way around.**

- Pull a task from Linear → AI agent picks it up, reads the context, writes the code, opens a PR
- Got a backlog of tickets? → Queue them up, agents work through them while you review
- Need human approval? → Agents pause and ask before doing anything risky

## How It Works

<p align="center">
  <img src="resources/process.png" alt="20x process: Hubspot, YouTrack, Linear, Github issues → triage agent → Agent (Claude Code, Opencode, OpenAI Codex, Cursor, Pi) → HITL review → Feedback" />
</p>

1. **Tasks flow in** — from Linear, YouTrack, HubSpot, GitHub Issues, Notion, or created manually
2. **Triage agent** — Assigns priority, coding agent (Claude Code, OpenCode, Codex, Cursor, or Pi), relevant skills, and git repos
3. **Agent works the task** — reads skills, git worktrees, and MCP servers; streams output in real time
4. **HITL review** — Agents pause for human approval before risky actions
5. **Feedback loop** — Skills and confidence levels are automatically updated after completion

## Features

<p align="center">
  <img src="resources/integrations.png" alt="20x integrations: Hubspot, YouTrack, Linear, Github issues → 20x ↔ GitLab, Github, MCP → Claude Code, Opencode, OpenAI Codex, Cursor, Pi; Skills automatically improved" />
</p>

### Dashboard Workspace
- **Command center** — Ask Mastermind or create a task from one input, with quick-start chips
- **Kanban task board** — Tasks grouped by status with drag-and-drop support

### Multi-Agent Support
- **Claude Code** — runs through Anthropic's `@anthropic-ai/claude-agent-sdk`
- **OpenCode** — open-source coding agent, driven through `@opencode-ai/sdk`
- **Codex** — OpenAI's Codex CLI, driven over `codex app-server` (set `CODEX_APP_SERVER=0` to use the ACP adapter instead)
- **Cursor** — the `cursor-agent` CLI via the Agent Client Protocol (JSON-RPC over stdio)
- **Pi** — open-source coding agent over its JSONL RPC protocol, using your own model providers
- **Live transcripts** — Watch agents think and work in real time with message counts
- **Human-in-the-loop** — Approve risky actions before execution
- **Task progress tracking** — Real-time progress events during agent execution

### Smart Integrations
- **Linear** — Pull issues, update status, post comments
- **HubSpot** — Sync tickets and workflows
- **YouTrack** — Connect JetBrains YouTrack projects and tasks
- **GitLab** — Full GitLab integration for task sourcing and repositories
- **Notion** — Sync Notion databases with full property and attachment support
- **GitHub Issues** — Pull issues directly from GitHub repositories
- **OAuth built-in** — Secure authentication flows

### Skills System
- **Reusable instructions** — Create skill templates for common patterns
- **Auto-learning** — Agents update skills based on feedback
- **Confidence tracking** — Skills improve over time
- **Searchable skills** — Quickly find skills with built-in search

### Developer-First
- **Git worktree management** — Isolated branches per task
- **Repository context** — Agents know which repos to work on (GitHub & GitLab)
- **MCP servers** — Connect Model Context Protocol tools with auto-registration
- **Browser MCP tools** — Expose console logs and network activity from browser panels to agents
- **Idle workspace cleanup** — Prunes `node_modules` in workspaces idle for 7+ days to reclaim disk
- **Local storage** — tasks, transcripts and settings in a local SQLite database

### Task Management
- **Subtasks** — Break tasks into subtasks with ordering and drag-and-drop reordering
- **Recurring tasks** — Daily, weekly, monthly schedules
- **Task snoozing** — Snooze tasks and have them resurface at the right time
- **Rich metadata** — Types, priorities, due dates, labels
- **File attachments** — Add context files to tasks
- **Output fields** — Structured task results
- **Smart search** — Find anything fast

### Voice (desktop, optional)
- **Local speech to text** — Runs on your machine; no audio is stored or sent anywhere
- **Talk to Mastermind** — Microphone in the top bar, or `Cmd/Ctrl+Shift+Space`, from any view
- **Dictate anywhere** — A microphone in every agent message box and the dashboard command box
- **Keep talking** — Each pause sends a sentence and the microphone stays open
- **Spoken answers** — 20x reads an agent answer aloud, and stops the moment you speak. It uses the voice your system already has, so it needs no download; a more natural downloaded voice is one click away
- Off by default: install the runtime and a model in **Settings → Voice**. See [docs/voice.md](docs/voice.md) and [docs/voice-tts.md](docs/voice-tts.md)

### Heartbeat Monitoring
- **Task heartbeat** — For tasks with heartbeat enabled, a scheduler periodically runs a lightweight agent session against the task's `heartbeat.md` checklist (PR comments, CI status, issue updates) and logs results to `heartbeat_logs`
- **Cheap preflight** — `gh api` checks run first, and the agent is skipped when nothing has changed
- **Stops on completion** — Heartbeats stop when the task, or a subtask's parent, is completed

## Getting Started

### Supported Platforms

Release builds (see `build` in `package.json`):

- **macOS** — `.dmg` and `.zip`
- **Windows** — NSIS installer, x64 only
- **Linux** — AppImage

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Git** (for worktree features)
- **GitHub CLI** (optional, for GitHub repo features) — 20x uses your existing `gh` session and never asks for or stores a GitHub token. Sign in once with `gh auth login` in your terminal; `gh auth status` shows the current state.
- **GitLab CLI** (optional, for GitLab repo features)

### Installation

```bash
# Clone the repository
git clone https://github.com/krazyjakee/21x.git
cd 21x

# Install dependencies
pnpm install
```

### macOS: Signed & Notarized Releases

Release artifacts are signed with an Apple Developer ID certificate and notarized to avoid Gatekeeper install/open warnings.

For maintainers, setup details are in [docs/macos-signing-notarization.md](./docs/macos-signing-notarization.md).

### Configuration

**API Keys:**
Anthropic, OpenAI and Google API keys can be set in **Settings → Advanced**. Each agent CLI can also use its own login.

**Database:**
- `pf-desktop.db` in the Electron `userData` directory: `~/Library/Application Support/20x/` (macOS), `%APPDATA%\20x\` (Windows), `~/.config/20x/` (Linux)
- Schema migrations run automatically on startup (see [docs/database-migrations.md](./docs/database-migrations.md))

**Integrations:**
1. Get OAuth credentials from Linear/HubSpot (Linear setup: [docs/LINEAR_OAUTH_SETUP.md](./docs/LINEAR_OAUTH_SETUP.md))
2. Add them under **Settings → Task sources**
3. Complete OAuth flow in-app

### Development

```bash
# Start dev server
pnpm run dev

# Run tests
pnpm test

# Build for distribution
pnpm run build:mac    # macOS
pnpm run build:win    # Windows
pnpm run build:linux  # Linux
```

## Architecture

### Data Flow

```
React UI → Zustand Store → IPC Client → Preload Bridge → Main Process → SQLite
```

- **Renderer** — React 19 + Tailwind CSS 4 + Zustand 5
- **Main Process** — Electron 44 + SQLite + Agent orchestration
- **Security** — Full context isolation, no Node.js in renderer

### Agent Architecture

**Session Lifecycle:**
1. **Start** — Agent assigned, skills applied, session created
2. **Streaming** — Real-time output sent to UI
3. **Approval** — Agent pauses for human decisions
4. **Completion** — Results saved, task updated

See [AGENTS.md](./AGENTS.md) for detailed architecture.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 44 |
| Build | electron-vite |
| Frontend | React 19 + Tailwind CSS 4 + Zustand 5 |
| UI Components | Radix UI primitives |
| Styling | cva + Tailwind CSS tokens |
| Icons | Lucide React |
| Font | Geist |
| Database | SQLite (better-sqlite3, WAL mode) |
| Agent SDKs / protocols | @anthropic-ai/claude-agent-sdk, @opencode-ai/sdk, `codex app-server`, Agent Client Protocol (Cursor, Codex fallback via @agentclientprotocol/codex-acp), Pi JSONL RPC |
| Testing | Vitest + happy-dom |

## Contributing

We welcome contributions! Here's how:

1. **Fork** the repo
2. **Create a branch**: `git checkout -b feature/my-feature`
3. **Write code**: TypeScript strict mode; run `pnpm lint` and `pnpm typecheck`; format per `.prettierrc`
4. **Add tests**: Vitest tests for new features
5. **Commit**: Use conventional commits (`feat:`, `fix:`, etc.)
6. **Push**: `git push origin feature/my-feature`
7. **Open PR**: Describe changes, ensure CI passes

### Code Style
- TypeScript strict mode
- Minimal Tailwind classes (prefer CSS variables)
- Use `pnpm` (not npm)

## Community

- **Issues**: [GitHub Issues](https://github.com/krazyjakee/21x/issues)

## Security

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

### Local Data
- All app data is stored locally in SQLite; the database file itself is not encrypted

### OAuth & API Keys
- Secrets (**Settings → Secrets**) and OAuth tokens are encrypted with Electron `safeStorage` when the OS provides it, and secret values are not sent to the renderer
- API keys entered in **Settings → Advanced** or in an agent's config are stored as plain text in SQLite and are readable by the renderer
- SQL values are passed as bound parameters

### Electron Security
- `contextIsolation: true`
- `nodeIntegration: false`
- External links open in system browser

## Known Limitations

- **Mobile API is plain HTTP on your LAN.** `src/main/mobile-api-server.ts` starts at launch and listens on `0.0.0.0:20620`. API routes need a session token from PIN pairing, but traffic on the local network is unencrypted and the mobile web app itself is served without auth. Remote access goes through a Cloudflare quick tunnel (`cloudflared`), not a 20x server.
- **Windows secret injection is untested.** Secrets reach agent shells through a PowerShell wrapper on Windows (`src/main/secret-broker.ts`); the wrapper tests are skipped on Windows.
- **Windows process cleanup is coarse.** On quit, leaked task-management MCP processes are killed with `taskkill` by image name and window title rather than by process ancestry as on macOS/Linux.
- **Starting OpenCode kills stray OpenCode servers.** Before starting its server the OpenCode adapter kills whatever listens on port 4096 (macOS/Linux) or every `opencode.exe` (Windows).
- **Windows installer asks for admin.** The NSIS build sets `requestedExecutionLevel: requireAdministrator`.

## License

[MIT](./LICENSE) © 2026 Peakflo

---

Built with [Electron](https://electronjs.org), [React](https://react.dev), and [Anthropic Claude](https://anthropic.com).
