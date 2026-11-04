# RTK output compression

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that filters noisy
shell-command output before it enters an agent's context.

RTK is on by default. The control is in **Settings → General → Agent & Tool
Setup → RTK output compression**, which shows the state in effect:

- **On**: RTK is installed and sessions use it.
- **Not installed**: the preference is on, but commands run unchanged. The row
  offers to install RTK. 21x never installs it without being asked.
- **Off**: the user opted out. This is stored as `rtk_enabled = false`. An unset
  value means on, so there is no migration, and installing RTK later turns it
  on for everyone who has not opted out.

A change applies to new sessions.

## What happens in a session

`assembleSessionConfig` reads the preference and looks for RTK, so Captain,
task, triage, heartbeat and review sessions all follow the same rules. Commander
has no shell tools, so RTK does not apply to it.

| Backend | Mechanism | Enforced? |
| --- | --- | --- |
| Claude Code | SDK `PreToolUse` hook | Yes |
| OpenCode | Generated plugin, `tool.execute.before` | Yes |
| Pi | Generated extension, `tool_call` | Yes |
| Codex | Added to the session's system prompt | No, instructions only |
| Cursor | Added to the session's system prompt | No, instructions only |

Codex and Cursor expose no way for 21x to change a command before it runs, so
those agents are asked to use RTK and may not. Settings says so.

The rewriting backends call `rtk rewrite`, the same command RTK's own hooks use,
and it decides what can be filtered. It leaves these alone:

- commands with no filter, which run exactly as written
- commands that are already wrapped, so nothing is wrapped twice
- shapes that need raw output, such as `git log | wc -l` or `ls > out.txt`

Any failure runs the original command: RTK missing, an old RTK without
`rewrite`, a non-zero exit or a 2 second timeout. RTK can never stop a command.

On Claude Code and OpenCode, RTK sees the command before secret `export` lines
are added, so secret values do not reach its command line. On Claude Code both
steps share one hook, because parallel hooks would overwrite each other.

## Global setup

Setup is separate from the preference, and sessions do not need it. **Install**
in Settings, and **Install** or **Add global hooks** in the setup dialog, run
RTK's global setup for each installed backend:

| Backend | What RTK writes |
| --- | --- |
| Claude Code | `PreToolUse` hook, plus `RTK.md` included from `CLAUDE.md` |
| OpenCode | `tool.execute.before` plugin |
| Pi | `tool_call` extension |
| Codex | `RTK.md` included from `AGENTS.md`, which is an instruction, not a hook |
| Cursor | `preToolUse` hook |

These files belong to the user and also apply in a terminal. When 21x runs setup
it disables RTK telemetry; users can make their own telemetry choice later with
the RTK CLI.

Claude Code sessions load these files because 21x leaves the SDK's
`settingSources` unset, which means all sources. A global hook and the 21x hook
produce the same rewrite. Codex reads `AGENTS.md` only with a subscription login:
API-key sessions use a temporary `CODEX_HOME`, so the session prompt is what
reaches them.

## Limits of the opt-out

The opt-out stops everything 21x adds, and tells agents not to use RTK. It cannot
remove the user's global setup:

- **Claude Code, OpenCode, Cursor**: a global hook keeps rewriting commands.
  `RTK_DISABLED=1` in the environment does not stop `rtk hook claude` or
  `rtk rewrite`. Settings names the affected backends and the fix,
  `rtk init -g --uninstall`, which also removes the hook outside 21x.
- **Pi**: RTK's global extension honours `RTK_DISABLED`, which 21x sets.
- **Codex**: the session prompt overrides the global instruction.
