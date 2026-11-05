# RTK output compression

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that filters noisy
shell-command output before it enters an agent's context.

RTK is on by default. The control is in **Settings → General → Agent & Tool
Setup → RTK output compression**, which shows the state in effect:

- **On**: RTK is installed and sessions without secrets use it.
- **Not installed**: the preference is on, but commands run unchanged. The row
  offers to install RTK. 21x never installs it without being asked.
- **Unsupported version**: the `rtk` found is older than 0.23.0, the first
  release with `rtk rewrite`, or is a different program. Commands run unchanged.
- **Off**: the user opted out. This is stored as `rtk_enabled = false`. An unset
  value means on, so there is no migration, and installing RTK later turns it
  on for everyone who has not opted out.

A change applies to new sessions.

## What happens in a session

`assembleSessionConfig` reads the preference and looks for RTK, so Captain,
task, triage, heartbeat and review sessions all follow the same rules, on both
the Electron and Tauri hosts.

Commander does not go through `assembleSessionConfig`, so RTK rewriting and the
preference do not reach it. Its Claude transport has no tools. Its Codex
transport runs a separate read-only `codex exec`, whose commands 21x does not
rewrite, and a global `AGENTS.md` instruction can still reach that process.

| Backend | Mechanism | Enforced? |
| --- | --- | --- |
| Claude Code | `canUseTool`, after the CLI's permission check | Yes, for commands that reach it |
| OpenCode | Generated plugin, `tool.execute.before` | Yes, unless any deny rule exists |
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

21x also leaves alone any command that assigns `PATH`, because the bare `rtk`
that `rtk rewrite` emits might not resolve under that PATH, and any output from
`rtk rewrite` that does not run `rtk`, which means a different program has the
same name.

If RTK cannot be run, or `rtk rewrite` fails or takes over 2 seconds, the original
command runs. The rewritten output is not always byte-identical to the original,
which is why the session prompt tells agents about `rtk proxy <command>`.

`rtk rewrite` emits a bare `rtk`, so its directory has to be on PATH. On Claude
Code and Pi, 21x adds it to the end of the session's PATH when it is missing. The
OpenCode server is shared, so its plugin checks the server's PATH and does not
rewrite if `rtk` would not resolve.

## Deny rules

A rewritten command must never get past a deny rule, and a missed saving is
acceptable. Permission rules match the start of a command, so `rtk git push` no
longer matches `Bash(git push:*)`. RTK cannot be relied on to prevent that: it
honours project and user rules for the plain form, but it rewrites `FOO=1 git
push` and `timeout 5 git push`, and it does not read managed settings.

- **Claude Code**: the rewrite happens in `canUseTool`, which the CLI calls after
  its permission check. A denied command never gets there, whichever settings
  file holds the rule and however the command is wrapped, including managed
  settings and a nested `.claude`. The cost is that commands the CLI approves by
  itself, such as `git status`, `git log`, `git diff`, `ls`, `cat` and `grep`, stay
  uncompressed. Test, build and commit commands are compressed.
- **OpenCode**: there is no hook after its permission check. The plugin reads the
  merged config before each command, and does not rewrite if it contains any deny
  rule, or if the config cannot be read within 2 seconds.
- **Pi**: has no deny rules of its own.
- **Codex and Cursor**: 21x does not rewrite. The prompt limits RTK to commands
  that read state or run tests and builds, and tells the agent not to use it to
  get around a denied command. That is a request and cannot be enforced.

`ask` rules stop matching a rewritten command on OpenCode. This does not change
the outcome: sessions run in `allow` mode, where a request is approved anyway
unless it is dangerous. On Claude Code they are checked before the rewrite.

**A user's global hook is outside this.** `rtk hook claude` rewrites in
`PreToolUse`, before the CLI's permission check, so with it installed `timeout 5
git push` runs past a rule on `git push`, in 21x sessions as anywhere else. This
is RTK's behaviour and predates 21x's default. Settings warns when a global hook
is present. The fix is `rtk init -g --uninstall`, which also removes it outside
21x.

## Sessions with secrets

A session whose agent has secrets or its own API keys never uses RTK, whatever
the preference says. The shell expands `$TOKEN` before `rtk` starts, so RTK sees
the value and stores it, where any later session could read it. Checking the
command text cannot rule that out: `eval`, `${!name}` and a pasted value all
get past it.

So for these sessions:

- 21x does not rewrite commands, and tells the agent not to use RTK.
- Every process in the session gets these variables, so that a global hook, or an
  `rtk` the agent types anyway, stores nothing:

| Variable | Stops |
| --- | --- |
| `RTK_DB_PATH=/dev/null/21x-rtk.db` | Command text in `history.db` |
| `RTK_RECALL=0` | Raw output in `recall.db` |
| `RTK_TEE=0` | Raw output in tee logs |
| `RTK_HOOK_AUDIT=0` | Command text in `hook-audit.log`, if the user turned that log on |

With RTK 0.49.0 these left no files at all, with default settings and with tee
mode forced, and a control without them stored the value in plain text.
`RTK_DB_PATH` alone is not enough, because raw output still goes to `recall.db` or
tee logs. Pointing it at a different file only moves the data. It sits under the null device because RTK
would otherwise chmod its parent directory, which as root means `/dev`. Windows
has not been tested.

On Claude Code, Pi, Codex and Cursor these are set in the environment of the CLI,
which its hooks and shells inherit. On OpenCode they travel with the secrets as
`export` lines, because the server is shared.

This covers secrets configured in 21x. Variables that the app inherits from the
user's own environment are not known to be secret, so a session without 21x
secrets can still pass them to RTK, as any use of RTK would.

## How Claude Code receives secrets

`CLAUDE_ENV_FILE` names a script the CLI sources before each Bash command. It
fetches the session's secrets from the secret broker with `curl`. The file holds a
session token and never a secret value, so a crash leaves nothing usable: the
token dies with the session and with the app.

This needs Claude Code 2.0.60 or newer: older versions ignore the file, so a
session with secrets refuses to start rather than run with empty variables. If
the version cannot be read, it starts and logs a warning. Without a running broker
secrets are not injected, which is also logged.

Secrets used to be added to each command by a `PreToolUse` hook. When a global RTK
hook also returned a command, the CLI used the global one and the secrets were
lost, on every call tested with Claude Code 2.1.317. They are not passed in the
CLI's environment because a secret named `ANTHROPIC_API_KEY` would change how it
authenticates.

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
`settingSources` unset, which means all sources. The global hook can return
`permissionDecision: "allow"`, which skips 21x's dangerous-command check. That
comes from RTK's hook and only applies to users who installed it. Codex reads
`AGENTS.md` only with a subscription login: API-key sessions use a temporary
`CODEX_HOME`, so the session prompt is what reaches them.

## Limits of the opt-out

The opt-out stops everything 21x adds, and tells agents not to use RTK. It cannot
remove the user's global setup:

- **Claude Code, OpenCode, Cursor**: a global hook keeps rewriting commands.
  `RTK_DISABLED=1` in the environment does not stop `rtk hook claude` or
  `rtk rewrite`. See [Deny rules](#deny-rules) for what that hook can do.
- **Pi**: RTK's global extension honours `RTK_DISABLED`, which 21x sets.
- **Codex**: the session prompt asks the agent to ignore the global instruction.
