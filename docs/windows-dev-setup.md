# Windows Development Setup

This guide covers building and running 20x from source on Windows. It complements the general instructions in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | >= 22 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 9 | Required — the version is pinned by `packageManager` in `package.json` |
| **Git** | Latest | Required for worktree features |
| **Visual Studio 2022 Build Tools** | Latest | Required to compile native modules (`better-sqlite3`, `node-pty`) for Electron |

Optional:

- **GitHub CLI** (`gh`) — for GitHub repo features; sign in once with `gh auth login`
- **GitLab CLI** — for GitLab repo features

## 1. Install pnpm

If pnpm is not on your PATH, enable it through Corepack (bundled with Node.js), which picks up the version pinned in `package.json`:

```powershell
corepack enable
pnpm --version
```

Alternatively: `npm install -g pnpm@9`.

## 2. Install Visual Studio Build Tools (before `pnpm install`)

Native addons must be compiled against Electron's Node.js runtime, not your system Node.js. This requires MSVC build tools. **Install this before running `pnpm install`** to avoid a failed postinstall step.

1. Download [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. In the installer, select **Desktop development with C++**
3. Ensure these are included:
   - **MSVC v143** (or latest) C++ x64/x86 build tools
   - **Windows SDK**

### Optional: embedded terminal support (`node-pty`)

If `node-pty` fails to rebuild with **MSB8040: Spectre-mitigated libraries are required**, the rest of the app still runs — only canvas terminal panels are affected.

To fix it, open **Visual Studio Installer → Modify → Individual components** and add:

- **MSVC Spectre-mitigated libs (x64/x86)**

Then rerun the rebuild command from step 3.

## 3. Clone and install dependencies

```powershell
git clone https://github.com/krazyjakee/21x.git
cd 21x
pnpm install
```

`pnpm install` runs a postinstall script (`scripts/rebuild-native.mjs`) that rebuilds native modules for Electron. If the postinstall step fails, dependencies are still installed — complete step 2 and rerun:

```powershell
node scripts/rebuild-native.mjs
```

### What gets rebuilt

| Module | Required? | Purpose |
|--------|-----------|---------|
| `better-sqlite3` | **Yes** | Local SQLite database — app will not start without this |
| `node-pty` | No | Embedded terminals in the canvas workspace |

The rebuild script continues if `node-pty` fails and logs a warning.

## 4. Run the app

```powershell
pnpm dev
```

This starts `electron-vite dev`, builds main/preload/renderer, and opens the 20x window.

On first launch you may see:

- An **onboarding wizard** (agent setup, optional CLI tool detection/install, templates)
- An **Electron Security Warning** about Content-Security-Policy — expected in dev; it does not appear in packaged builds
- **Database migrations** in the terminal — normal on first run or after pulling schema changes

### Verify startup

Successful startup logs include lines like:

```
[TaskApiServer] Started on port ...
[SecretBroker] Started on port ...
[MobileAPI] Started on port ...
```

## 5. Run tests

The test scripts set `ELECTRON_RUN_AS_NODE` through `cross-env`, so they work as-is in PowerShell, cmd and Git Bash:

```powershell
pnpm test:run
pnpm test:main
pnpm test:renderer
```

Before opening a PR, run the CI-equivalent checks:

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test:run
```

## 6. Build the Windows installer

```powershell
pnpm build:win
```

Output: `dist/20x Setup {version}.exe` (x64 only; electron-builder's default NSIS name, since `win` sets no `artifactName`).

The NSIS installer requires administrator elevation (`requestedExecutionLevel: requireAdministrator` in `package.json`) and installs Python if none is found.

## Local data paths

| Data | Path |
|------|------|
| SQLite database | `%APPDATA%\20x\pf-desktop.db` |
| Crash logs | `%APPDATA%\20x\logs\crash.log` |
| Secret shell wrapper | `%APPDATA%\20x\secret-shell.ps1` |
| Task workspaces | `%APPDATA%\20x\workspaces\{taskId}\` |
| Task attachments | `%APPDATA%\20x\attachments\{taskId}\` |

The database file is named `pf-desktop.db` (legacy name) inside the `20x` app data folder.

On uninstall, the NSIS installer **asks** whether to remove app data. Choosing **No** keeps your database and settings. App upgrades preserve data automatically.

## Troubleshooting

### `pnpm` is not recognized

Install globally with `npm install -g pnpm@9`, then reopen your terminal.

### `node-gyp` / Visual Studio not found

Install **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload, then run:

```powershell
node scripts/rebuild-native.mjs
```

### App crashes on startup with a `better-sqlite3` error

The native module was built for system Node.js instead of Electron. Rerun `node scripts/rebuild-native.mjs`.

### `pnpm dev` builds but the window closes immediately

Check `%APPDATA%\20x\logs\crash.log` for the stack trace. Common causes: missing native rebuild or a stale database from an older install — try renaming `%APPDATA%\20x` temporarily to start fresh.

### Agent CLI tools not found

Use **Settings → General → Agent & Tool Setup → Open Setup Wizard** to detect and install Git, OpenCode, Claude Code, or Codex. On Windows, npm-based tools install as `.cmd` wrappers — the app handles this automatically.
