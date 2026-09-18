# Global MCP configuration of the coding-agent CLIs

Settings → Tools & MCP → **Global MCP (CLIs)** lists the MCP servers each
installed CLI has in its *own* global config, and edits those files in place.
This is separate from 20x's own MCP server list (the section above it), which
lives in 20x's database and is attached to agents per task.

Code: `src/main/cli-mcp-config/` (one store per CLI, `index.ts` is the
manager), IPC in `src/main/ipc/cli-mcp.ts`, UI in
`src/renderer/src/components/settings/GlobalCliMcpSection.tsx`.

## Where each CLI keeps it

| CLI | Servers | Server switch | Per-tool switch | Secret references |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude.json` → `mcpServers` | `permissions.deny: ["mcp__<server>"]` in `~/.claude/settings.json` (no native flag) | `permissions.deny: ["mcp__<server>__<tool>"]` | `${VAR}` expanded by Claude Code |
| OpenCode | `$OPENCODE_CONFIG` or `~/.config/opencode/opencode.json(c)` → `mcp` | `mcp.<server>.enabled = false` | top-level `tools: { "<server>_<tool>": false }` | `{env:VAR}` (shown as `${VAR}`) |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) → `[mcp_servers.<name>]` | `enabled = false` | `disabled_tools = ["tool"]` (an existing `enabled_tools` allowlist is shown, not edited) | `env_vars`, `env_http_headers`, `bearer_token_env_var` (shown as `${VAR}`) |

Claude Code is the one CLI without a native "off" flag in user scope. A
disabled server is denied through `permissions.deny`, which removes every one
of its tools from the model, but Claude Code still launches the server
process. The UI says so on the switch.

Server and tool ids follow each CLI's own normalisation (`[^a-zA-Z0-9_-]` →
`_`), shared with the per-agent limits in `src/main/mcp-tool-limits.ts`.

## Precedence

From broadest to most specific:

1. **Global CLI config** (this page). What the CLI does when run from a
   terminal, and the baseline for 20x sessions where the CLI reads it:
   - *OpenCode*: 20x starts `opencode serve` with the user's `opencode.json`
     merged into `OPENCODE_CONFIG_CONTENT`, so a server disabled here is not
     started for 20x sessions either, and `tools` rules apply.
   - *Codex*: 20x's app-server uses the user's `CODEX_HOME`, so global
     `[mcp_servers.*]` load alongside the servers 20x passes for the agent.
     (Sessions that use an API key run in a temporary `CODEX_HOME` and see no
     global servers.)
   - *Claude Code*: 20x sessions run with `strictMcpConfig: true`, so global
     servers, deny rules and plugins from `~/.claude.json` / `settings.json`
     are **not** loaded. Only the agent's own servers apply.
2. **20x agent config** (`agent.config.mcp_servers`, `enabledTools`). Servers
   20x attaches to a session. A same-named server here replaces the global
   one for that session (OpenCode `mcp.add`, Codex `mcp_servers` override).
   Per-agent `enabledTools` limits are enforced by 20x itself
   (`disallowedTools` + a PreToolUse hook for Claude Code, a per-session tool
   map for OpenCode) and never widen a global rule.
3. **Task level**. A task's agent selection decides which agent config, and
   therefore which servers, a session gets. There is no task-level MCP
   override beyond that; task-management tools are injected by 20x.

Rule of thumb: a global "off" stays off for the CLI everywhere it reads its
config; 20x can only add its own servers on top or narrow them further.

## Reconciling external edits

Every snapshot carries a fingerprint (hash of the files) per CLI. A write
re-reads the files, and if the fingerprint no longer matches the one the UI
loaded, nothing is written and the UI shows a conflict banner with a Reload
button. Writes are minimal patches — the parsed document is mutated and
re-serialised with its original indentation, unknown keys in an entry are
kept, and for `config.toml` only the affected `[mcp_servers.*]` tables are
rewritten; every other line is carried through byte-for-byte. Known
formatting losses: comments and trailing commas in `opencode.jsonc` are
dropped (the UI warns), and a rewritten Codex table loses comments inside
that table.

## Secrets

Env and header values that look like secrets (key names such as `TOKEN`,
`API_KEY`, `Authorization`, or long opaque strings) are masked before they
leave the main process and are never logged. Sending the mask back keeps
the on-disk value. A new secret-looking value is never written as
plaintext: 20x writes a reference in the CLI's own syntax and tells you
which variable to export. Plaintext that was already in a file is left
untouched. The connection probe resolves references from 20x's environment
and reports unset variables by name.
