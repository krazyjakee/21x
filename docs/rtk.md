# RTK output compression

21x can install and configure [RTK](https://github.com/rtk-ai/rtk), a CLI proxy
that filters noisy shell-command output before it enters an agent's context.

Open **Settings → General → Agent & Tool Setup** and use the **RTK output
compression** row. 21x installs the platform-specific RTK release, then runs
RTK's native global setup for every installed coding-agent backend:

- Claude Code: `PreToolUse` hook
- OpenCode: `tool.execute.before` plugin
- Codex: `PreToolUse` hook
- Cursor: `preToolUse` hook
- Pi: `tool_call` extension

Setup is idempotent and uses RTK's own configuration writers, which preserve
unrelated hooks and settings. Existing agent sessions must be restarted after
setup. When 21x runs setup non-interactively it disables RTK telemetry; users
can make their own telemetry choice later with the RTK CLI.

The setup row reports **Configured** only when every coding-agent backend
currently installed on the machine has its RTK integration. If another backend
is installed later, reopen the setup wizard and choose **Configure** again.
