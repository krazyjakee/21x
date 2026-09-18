import { guardedIpcSend } from './guarded-ipc-send'
import { execFileSync, execSync } from 'child_process'
import { readdirSync } from 'fs'
import { app, BrowserWindow, dialog, net, protocol, session, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { DatabaseManager } from './database'
import { AgentManager } from './agent-manager'
import { GitHubManager } from './github-manager'
import { GitLabManager } from './gitlab-manager'
import { ForgejoManager } from './forgejo-manager'
import { WorktreeManager } from './worktree-manager'
import { SyncManager } from './sync-manager'
import { OAuthManager } from './oauth/oauth-manager'
import { PluginRegistry } from './plugins/registry'
import { LinearPlugin } from './plugins/linear-plugin'
import { HubSpotPlugin } from './plugins/hubspot-plugin'
import { GitHubIssuesPlugin } from './plugins/github-issues-plugin'
import { ForgejoIssuesPlugin } from './plugins/forgejo-issues-plugin'
import { NotionPlugin } from './plugins/notion-plugin'
import { YouTrackPlugin } from './plugins/youtrack-plugin'
import { registerIpcHandlers } from './ipc-handlers'
import { panelBrowserBroker } from './panel-browser-broker'
import { hardenWebviewPreferences } from './webview-hardening'
import { VoiceSessionManager } from './voice/voice-session-manager'
import { voiceEventSenders, watchAgentAnswersForSpeech } from './voice/voice-bridge'
import { loadPlatformShellEnv } from './shell-env'
import { RecurrenceScheduler } from './recurrence-scheduler'
import { HeartbeatScheduler } from './heartbeat-scheduler'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import { ClaudePluginManager } from './claude-plugin-manager'
import { parseProcessTable, selectKillableMcpPids, WINDOWS_PROCESS_TABLE_SCRIPT } from './mcp-process-cleanup'
import { buildWorkspaceStates, sweepLeakedWorkspaceProcesses, readDiskSpace, workspacePressureWarning, SHUTDOWN_GRACE_MS } from './workspace-process-cleanup'
import { WORKSPACES_DIR, listWorkspaceDirs, taskAttachmentsDir } from './workspace-paths'
import { setTaskApiAgentController, setTaskApiNotifier, setTaskApiUiState, setTranscriptProvider, startTaskApiServer, stopTaskApiServer } from './task-api-server'
import { setTaskAutomationTrigger, setTaskSchedulers } from './task-updates'
import { startSecretBroker, stopSecretBroker, writeSecretShellWrapper } from './secret-broker'
import { isMainWindowUrl } from './main-window-url'
import { applyMobileAccessSettings, setMobileApiDeps, stopMobileApiServer, broadcastToMobileClients, setMobileApiNotifier } from './mobile-api-server'
import { registerUpdaterIpc, initAutoUpdater, isUpdateDownloaded, getPendingVersion } from './auto-updater'
import { initCrashLogger } from './crash-logger'
import { installProcessStreamErrorHandlers } from './process-stream-errors'

/**
 * Validate that a URL is safe to open via shell.openExternal.
 * Rejects about:blank, empty strings, and non-http(s)/mailto URLs
 * to avoid the macOS "no application set to open the URL" popup.
 */
function isExternalUrl(url: string): boolean {
  if (!url || url === 'about:blank' || url === 'about:srcdoc') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let db: DatabaseManager | null = null
let agentManager: AgentManager | null = null
let githubManager: GitHubManager | null = null
let gitlabManager: GitLabManager | null = null
let forgejoManager: ForgejoManager | null = null
let worktreeManager: WorktreeManager | null = null
let syncManager: SyncManager | null = null
let pluginRegistry: PluginRegistry | null = null
let oauthManager: OAuthManager | null = null
let recurrenceScheduler: RecurrenceScheduler | null = null
let heartbeatScheduler: HeartbeatScheduler | null = null
let taskAutomationScheduler: TaskAutomationScheduler | null = null
let workspaceCleanupScheduler: WorkspaceCleanupScheduler | null = null
let claudePluginManager: ClaudePluginManager | null = null
let voiceSessionManager: VoiceSessionManager | null = null
let isShuttingDown = false

/**
 * Kills stdio MCP server processes that this instance leaked.
 *
 * Scoped to our own descendants and to processes that already lost their parent,
 * so a second 20x instance keeps the MCP children of its running agents. Called
 * at shutdown, and at startup to collect what a previous crash left behind.
 */
function sweepLeakedMcpProcesses(): void {
  try {
    const psOutput =
      process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT], {
            encoding: 'utf-8',
            maxBuffer: 8 * 1024 * 1024,
            timeout: 15_000,
            windowsHide: true
          })
        : execSync('ps -eo pid=,ppid=,command=', { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const pids = selectKillableMcpPids(parseProcessTable(psOutput), process.pid)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone between the listing and the signal.
      }
    }
    if (pids.length > 0) {
      console.log(`[Cleanup] Terminated ${pids.length} leaked MCP server process(es): ${pids.join(', ')}`)
    }
  } catch (err) {
    console.warn('[Cleanup] Could not sweep leaked MCP server processes:', err)
  }
}

/**
 * Kills processes still running inside a task workspace that nobody is driving.
 *
 * The same defect as the MCP sweep above, one level out: a watcher started by
 * `pnpm dev` inside a workspace survives its parents, is reparented to launchd,
 * and goes on watching several thousand files for days. Two such processes were
 * measured holding 43% of every open file descriptor on the owner's machine.
 *
 * Selection is by CWD AND TASK STATE, never by process name — `node`, `tsx` and
 * `next` are also how the user runs their own work, and a name match would kill
 * a dev server running in their own checkout.
 *
 * The boot call is the one that matters. These orphans reparent to launchd, so
 * a shutdown hook alone never sees a machine that was force-quit or rebooted.
 */
async function sweepLeakedWorkspaces(graceMs?: number, orphansIgnoreTaskState = false): Promise<void> {
  try {
    // A workspace with no task row is as leaked as a finished one, so the two
    // sources are paired rather than either alone. BOTH must be trustworthy: a
    // failed read of either one would classify healthy workspaces as leaked, so
    // each is checked and the sweep declines rather than guesses.
    const dirs = listWorkspaceDirs()
    if (dirs === null) {
      console.warn('[Cleanup] Skipping the workspace sweep: the workspaces directory could not be read.')
      return
    }
    const tasks = db ? db.getTasks().map((task) => ({ id: task.id, status: String(task.status) })) : []
    if (tasks.length === 0 && dirs.length > 0) {
      // Not credible: workspaces exist but the task table is empty. Far more
      // likely a closed or damaged database than a genuinely empty one — and
      // believing it would mark every workspace "no task for this workspace"
      // and kill everything in all of them.
      console.warn(`[Cleanup] Skipping the workspace sweep: ${dirs.length} workspaces on disk but no tasks in the database.`)
      return
    }
    const states = buildWorkspaceStates(tasks, dirs)
    await sweepLeakedWorkspaceProcesses({
      workspacesRoot: WORKSPACES_DIR,
      workspaceState: (workspaceId) => states.get(workspaceId) ?? { exists: false },
      graceMs,
      orphansIgnoreTaskState
    })

    // Nothing bounds the workspace count today. Report it with the free space
    // beside it, so the disk cost of one clone per agent run is visible before
    // it bites — the count alone does not say whether the next run will fit.
    const pressure = workspacePressureWarning({ count: dirs.length, disk: readDiskSpace(WORKSPACES_DIR) })
    if (pressure) console.warn(`[Cleanup] ${pressure}`)
  } catch (err) {
    console.warn('[Cleanup] Could not sweep leaked workspace processes:', err)
  }
}

async function shutdownAppServices(): Promise<void> {
  voiceSessionManager?.shutdown()
  heartbeatScheduler?.stop()
  taskAutomationScheduler?.stop()
  workspaceCleanupScheduler?.stop()

  await agentManager?.stopAllSessions()
  await agentManager?.stopServer()

  oauthManager?.destroy()
  stopSecretBroker()
  stopMobileApiServer()
  stopTaskApiServer()

  sweepLeakedMcpProcesses()
  // A short grace here: quitting must stay quick, and anything that ignores
  // SIGTERM is collected by the boot sweep on the next start.
  await sweepLeakedWorkspaces(SHUTDOWN_GRACE_MS)

  db?.close()

  if (tray) {
    tray.destroy()
    tray = null
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1E2127',
    // Electron 44 native window-state persistence: remember position, size and
    // display mode across launches instead of always reopening at 1400x900.
    windowStatePersistence: true,
    name: 'main',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#1E2127', symbolColor: '#535D71', height: 36 },
          icon: is.dev ? join(__dirname, '../../resources/icon.ico') : join(process.resourcesPath, 'icon.ico')
        }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload bundle only imports `electron` (contextBridge, ipcRenderer,
      // webUtils — all available to sandboxed preloads) plus type-only shared
      // modules, so the renderer can run inside the OS sandbox. Anything the UI
      // needs from Node already goes through IPC. Keep it that way: adding a
      // Node `require` to the preload would fail at run time with this on.
      sandbox: true,
      webviewTag: true,
      // Keep processing agent transcript IPC/timers while the window is
      // hidden or minimized — throttling a hidden renderer stalls streamed
      // updates and safety reconciles until the window is shown again.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()

    if (!is.dev && mainWindow) {
      initAutoUpdater(mainWindow)
    }

    if (recurrenceScheduler && mainWindow) {
      recurrenceScheduler.start(mainWindow)
    }

    if (heartbeatScheduler && mainWindow) {
      heartbeatScheduler.start(mainWindow)
    }

    // Auto-start / auto-complete reconciliation is deliberately
    // window-independent: the flags must hold with no window open.
    taskAutomationScheduler?.start()

    if (workspaceCleanupScheduler && mainWindow) {
      workspaceCleanupScheduler.start(mainWindow)
    }

    // Periodic overdue check — nudges renderer every 60s
    setInterval(() => {
      guardedIpcSend(mainWindow?.webContents, 'overdue:check')
    }, 60_000)
  })

  // Force the main window to 100% zoom on first load. Chromium persists page
  // zoom per host, so an accidental Cmd+- gets remembered — and because `pnpm dev`
  // loads from `localhost`, a stray zoom level stays applied on every dev launch
  // (the app opens zoomed out/in with no obvious way back). Reset once per launch;
  // in-session Cmd+/Cmd- still works. Embedded <webview> contents have their own
  // webContents and are unaffected.
  let didResetZoom = false
  mainWindow.webContents.on('did-finish-load', () => {
    if (didResetZoom) return
    didResetZoom = true
    mainWindow?.webContents.setZoomLevel(0)
  })

  // On Windows, `titleBarStyle: 'hidden'` + `titleBarOverlay` (Window Controls
  // Overlay) removes the native frame that would normally host the menu bar's
  // accelerator table — Menu.setApplicationMenu()'s Ctrl+/Ctrl-/Ctrl+0 roles
  // don't reliably fire in that mode. Handle the zoom shortcuts directly so
  // they work regardless of the (invisible) native menu.
  if (!isMac) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.meta || input.alt || input.shift) return
      const wc = mainWindow?.webContents
      if (!wc) return
      if (input.key === '=' || input.key === '+') {
        wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 9))
      } else if (input.key === '-') {
        wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -8))
      } else if (input.key === '0') {
        wc.setZoomLevel(0)
      }
    })
  }

  // Auto-reload on renderer crash (blank screen recovery)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Main] Renderer crashed: reason=${details.reason}, exitCode=${details.exitCode}`)
    if (details.reason !== 'clean-exit') {
      console.log('[Main] Attempting to reload renderer...')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload()
        }
      }, 1000)
    }
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) { // 2 = warning, 3 = error
      console.error(`[Renderer ${level === 3 ? 'ERROR' : 'WARN'}] ${message}`)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isExternalUrl(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // SAFETY: Prevent the main window from ever navigating away from the app.
  // Defense in depth for the panel browser broker: only registered canvas
  // browser panels are addressable by agents, so this should never fire —
  // but if anything ever drives the main window off-app, block it here.
  //
  const appUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : null
  const rendererIndexPath = join(__dirname, '../renderer/index.html')
  const isAppUrl = (url: string): boolean => isMainWindowUrl(url, appUrl, rendererIndexPath)

  // Layer 1: will-navigate (catches user-initiated navigations — NOT CDP)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      console.warn(`[Main] Blocked navigation of main window to: ${url}`)
      event.preventDefault()
    }
  })

  // Layer 2: Recovery — snap the app back if the main window ever ends up on a
  // non-app URL despite the guard above. Safety net, not prevention.
  const mw = mainWindow // capture non-null reference for closure
  mw.webContents.on('did-navigate', (_event, url) => {
    if (!isAppUrl(url)) {
      console.warn(`[Main] Main window navigated to non-app URL: ${url} — recovering...`)
      if (appUrl) {
        mw.loadURL(appUrl)
      } else {
        mw.loadFile(rendererIndexPath)
      }
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', async (event) => {
    if (!isQuitting) {
      const minimizeToTray = await db?.getSetting('minimize_to_tray')
      if (minimizeToTray === 'true') {
        event.preventDefault()
        mainWindow?.hide()

        if (!tray && db) {
          createTray()
        }
        return
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // A closed window must not keep reporting the screen it last showed.
    setTaskApiUiState(null)
  })

  agentManager?.setMainWindow(mainWindow)
  worktreeManager?.setMainWindow(mainWindow)

  setTaskApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      guardedIpcSend(mainWindow.webContents, channel, data)
    }
    broadcastToMobileClients(channel, data)
  })

  // An MCP caller has no window, so the main-process loop is what honours the
  // auto-start / auto-complete flags it sets.
  setTaskAutomationTrigger(() => {
    void taskAutomationScheduler?.runNow()
  })

  // Wire up transcript provider for subtask MCP agents to access sibling transcripts
  if (agentManager) {
    setTranscriptProvider((taskId) => agentManager!.getTranscriptForTask(taskId))
    setTaskApiAgentController(agentManager)
  }

  setMobileApiNotifier((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      guardedIpcSend(mainWindow.webContents, channel, data)
    }
  })
}

/**
 * Build and set the application menu.
 * Adds "Check for Updates…" under the app menu (macOS) or Help menu (Win/Linux).
 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      mainWindow?.show()
      guardedIpcSend(mainWindow?.webContents, 'menu:check-for-updates')
    }
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              checkForUpdatesItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      label: 'Help',
      submenu: [
        ...(!isMac ? [checkForUpdatesItem, { type: 'separator' as const }] : []),
        {
          label: 'View on GitHub',
          click: () => {
            shell.openExternal('https://github.com/krazyjakee/21x')
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray(): void {
  if (tray) return

  // Create a simple tray icon (16x16 transparent icon)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAESSURBVDiNrdI9S8NAGMDx/5Wk1YKDi4ODQ3FQcHMQP4CDg4uDk4ubk4iDnyAf4O/gIji4CA5FEBwcnJycHBwcXBwcXJRSq7aJ8VDSpk0VfMbj7rn/cffcI6SUOKWllNhKKeF0OhGllLBtG9M0kVLidDqoqsrl5SWxWIxoNIphGOi6Trlcplgskkql8Pl8AMD3+0ilUuF6vZZKqYLruigI+Hw+FAoF3t/fJZPJ0O/3WSwW/H6/bDQaXF9fs1gsMAwDy7Jwu91Eo1EcDgfFYpFsNovH46FarZJMJpmammJjY4N6vY6qqgSDQdrtNgC2bTMYDOh0Oui6jqIoKIqCZVmYponf72cwGGDbNgBCCIQQf9o/6Ad8dIxRqBjmAAAAAElFTkSuQmCC'
  )

  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show 20x',
      click: () => {
        mainWindow?.show()
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('20x')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    mainWindow?.show()
  })
}

// Register custom protocol for OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('nuanu', process.execPath, [
      join(process.argv[1])
    ])
  }
} else {
  app.setAsDefaultProtocolClient('nuanu')
}

// Handle OAuth callback deep links
app.on('open-url', (event, url) => {
  event.preventDefault()

  console.log('[OAuth] Received callback URL:', url)

  // Parse: nuanu://oauth/callback?code=xxx&state=yyy
  try {
    const parsedUrl = new URL(url)
    console.log('[OAuth] Parsed URL - protocol:', parsedUrl.protocol, 'hostname:', parsedUrl.hostname, 'pathname:', parsedUrl.pathname)

    if (parsedUrl.protocol === 'nuanu:' && parsedUrl.hostname === 'oauth' && parsedUrl.pathname === '/callback') {
      const code = parsedUrl.searchParams.get('code')
      const state = parsedUrl.searchParams.get('state')

      console.log('[OAuth] Extracted code:', code ? 'present' : 'missing', 'state:', state ? 'present' : 'missing')

      if (code && state) {
        // If window isn't ready, wait for it
        if (!mainWindow) {
          console.log('[OAuth] Main window not ready, waiting...')
          const checkWindow = setInterval(() => {
            if (mainWindow) {
              clearInterval(checkWindow)
              console.log('[OAuth] Sending callback to renderer')
              guardedIpcSend(mainWindow.webContents, 'oauth:callback', { code, state })
            }
          }, 100)
          setTimeout(() => clearInterval(checkWindow), 10000)
        } else {
          console.log('[OAuth] Sending callback to renderer')
          guardedIpcSend(mainWindow.webContents, 'oauth:callback', { code, state })
        }
      } else {
        console.error('[OAuth] Missing code or state in callback URL')
      }
    } else {
      console.log('[OAuth] URL does not match expected callback format')
    }
  } catch (error) {
    console.error('[OAuth] Failed to parse callback URL:', error)
  }
})

// Register app-attachment:// as a privileged scheme before app is ready.
// This allows the renderer to load local attachment images via <img src="app-attachment://...">.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-attachment',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

initCrashLogger()

// NOTE: The app intentionally does NOT expose a --remote-debugging-port.
// Canvas browser panels are driven by agents through the in-app panel browser
// broker (panel-browser-broker.ts) via browser_* MCP tools — only registered
// panels are addressable, so the main window can never be reached or
// navigated away by an agent. A global debug port would expose every target
// (main window = first page target) to any local process.

// ── Anti-bot-detection for embedded browser panels ─────────────────────────
// Some sites (Xero, banking portals) use Akamai's WAF which fingerprints
// the TLS ClientHello and HTTP/2 SETTINGS frames — baked into the compiled
// Electron binary and impossible to change at runtime.  We apply best-effort
// mitigations here; sites that still block are handled gracefully in the
// browser panel UI with an "Open in Chrome" fallback.

// 1. Replace user-agent with a real Chrome UA string.
const chromiumVersion = process.versions.chrome || '136.0.0.0'
const chromiumMajor = chromiumVersion.split('.')[0]
const cleanUA = process.platform === 'darwin'
  ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
  : process.platform === 'win32'
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
app.userAgentFallback = cleanUA

// 2. Disable AutomationControlled so navigator.webdriver = false when CDP is active.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// 3. Best-effort TLS/HTTP2 mitigations — these help with less aggressive WAFs
//    but cannot fully defeat Akamai's binary-level TLS fingerprinting.
app.commandLine.appendSwitch('enable-features', [
  'PermuteTLSExtensions',          // randomise TLS extension order
  'PostQuantumKyber',              // Chrome enables this by default
].join(','))
app.commandLine.appendSwitch('disable-features', [
  'AcceptCHFrame',                 // Electron-only ALPS extension not in Chrome
].join(','))

installProcessStreamErrorHandlers()

app.whenReady().then(async () => {
  // Collect MCP server processes that a previous crash or force-quit orphaned.
  // Safe for a second live instance: only parentless processes match here,
  // because this instance has no descendants yet.
  sweepLeakedMcpProcesses()
  // Register protocol handler: app-attachment://taskId/attachmentId
  // Serves local attachment files from the attachments directory.
  protocol.handle('app-attachment', (request) => {
    try {
      const url = new URL(request.url)
      // URL format: app-attachment://taskId/attachmentId
      const taskId = url.hostname
      const attachmentId = url.pathname.replace(/^\//, '')

      if (!taskId || !attachmentId || !db) {
        return new Response('Not found', { status: 404 })
      }

      const dir = taskAttachmentsDir(taskId)
      const files = readdirSync(dir) // throws if dir missing — caught below
      const match = files.find((f) => f.startsWith(`${attachmentId}-`))
      if (!match) {
        return new Response('Not found', { status: 404 })
      }

      return net.fetch(pathToFileURL(join(dir, match)).href)
    } catch {
      return new Response('Internal error', { status: 500 })
    }
  })

  // Start PATH fix and DB init in parallel — both are independent
  const pathFixPromise = loadPlatformShellEnv()

  db = new DatabaseManager()
  db.initialize()
  // The task-management MCP server script calls back into this HTTP API.
  startTaskApiServer(db).catch(err =>
    console.error('[Main] Failed to start task API server:', err)
  )

  // The BOOT sweep for workspace processes. It runs here rather than beside the
  // MCP sweep above because it needs the task table to tell a leaked workspace
  // from one an agent is working in. This is the call that catches a machine
  // that was force-quit or rebooted: those orphans reparent to launchd, so no
  // shutdown hook ever sees them. Awaited — on a machine that has hit EMFILE
  // the descriptors must come back before this instance opens its own.
  // `orphansIgnoreTaskState` is true HERE AND ONLY HERE. Task status is
  // deliberately preserved across a quit and nothing repairs it at startup, so
  // a force-quit task stays `agent_working` forever — and without this the
  // watcher it leaked would be vetoed by its own stale status on every boot,
  // making the reported case the one case that could never be collected.
  await sweepLeakedWorkspaces(undefined, true)

  // Ensure PATH is ready before creating managers that may spawn child processes
  await pathFixPromise

  agentManager = new AgentManager(db)
  githubManager = new GitHubManager()
  gitlabManager = new GitLabManager()
  const settingsDb = db
  forgejoManager = new ForgejoManager((key) => settingsDb.getSetting(key))
  worktreeManager = new WorktreeManager()
  worktreeManager.setForgejoManager(forgejoManager)
  agentManager.setManagers(githubManager, worktreeManager, gitlabManager ?? undefined, forgejoManager)

  oauthManager = new OAuthManager(db)
  agentManager.setOAuthManager(oauthManager)

  pluginRegistry = new PluginRegistry()
  pluginRegistry.register(new LinearPlugin())
  pluginRegistry.register(new HubSpotPlugin())
  pluginRegistry.register(new GitHubIssuesPlugin(githubManager))
  pluginRegistry.register(new ForgejoIssuesPlugin(forgejoManager))
  pluginRegistry.register(new NotionPlugin())
  pluginRegistry.register(new YouTrackPlugin())

  syncManager = new SyncManager(db, pluginRegistry, oauthManager)
  agentManager.setSyncManager(syncManager)

  recurrenceScheduler = new RecurrenceScheduler(db)
  heartbeatScheduler = new HeartbeatScheduler(db, agentManager)
  taskAutomationScheduler = new TaskAutomationScheduler(db, agentManager)
  // A brand-new recurring instance must not wait up to a minute to start.
  recurrenceScheduler.setOnInstancesCreated(() => {
    void taskAutomationScheduler?.runNow()
  })
  setTaskSchedulers({ recurrence: recurrenceScheduler, heartbeat: heartbeatScheduler })
  workspaceCleanupScheduler = new WorkspaceCleanupScheduler(db, worktreeManager)

  claudePluginManager = new ClaudePluginManager(db)

  // Voice control (design §5.1). It never blocks start-up: when the local
  // speech runtime or the model is absent, voice simply stays switched off.
  voiceSessionManager = new VoiceSessionManager({
    db,
    agents: agentManager,
    ...voiceEventSenders(() => mainWindow)
  })
  void voiceSessionManager.initialize()
  watchAgentAnswersForSpeech(agentManager, db, voiceSessionManager)

  registerIpcHandlers({
    db,
    agentManager,
    githubManager,
    worktreeManager,
    syncManager,
    pluginRegistry,
    oauthManager,
    claudePluginManager,
    heartbeatScheduler,
    gitlabManager,
    workspaceCleanupScheduler,
    voiceSessionManager,
    forgejoManager
  })

  // ── Media permission handler (design §5.9) ────────────────────────────────
  // Grant the microphone only to the 20x renderer, and only while voice is on.
  // Every other media request (camera, screen, and any embedded web content) is
  // refused. This is the single permission handler for the default session.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') {
      // Everything else keeps the behaviour this app had before the handler
      // existed, so no embedded content loses a permission it already used.
      callback(true)
      return
    }
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    if (mediaTypes.includes('video')) {
      callback(false)
      return
    }
    const isAppWindow = mainWindow != null && contents === mainWindow.webContents
    callback(isAppWindow && voiceSessionManager?.isEnabled() === true)
  })

  // Register updater IPC handlers (safe in dev mode — returns no-op results)
  registerUpdaterIpc()

  // Build the application menu (includes "Check for Updates…")
  buildAppMenu()

  // Start secret broker and write shell wrapper (awaited so broker is ready before any sessions)
  try {
    const brokerPort = await startSecretBroker(db)
    console.log(`[Main] Secret broker started on port ${brokerPort}`)
    writeSecretShellWrapper()
  } catch (err) {
    console.error('[Main] Failed to start secret broker:', err)
  }

  // Start mobile API server — only when mobile access is enabled in Settings.
  // The mobile IPC handlers re-apply the settings when they change.
  try {
    agentManager.addExternalListener(broadcastToMobileClients)
    setMobileApiDeps({ db, agentManager, githubManager: githubManager!, syncManager, pluginRegistry, gitlabManager, forgejoManager })
    const mobilePort = await applyMobileAccessSettings()
    console.log(mobilePort == null ? '[Main] Mobile access disabled; mobile API server not started' : `[Main] Mobile API server started on port ${mobilePort}`)
  } catch (err) {
    console.error('[Main] Failed to start mobile API server:', err)
  }

  // Check gh CLI status on startup (log only)
  githubManager.checkGhCli().then((status) => {
    console.log('[GitHub] CLI status:', status)
  }).catch(() => {})

  // ── Strip embedding-restriction headers ───────────────────────────────────
  // Register on session.defaultSession so it intercepts ALL HTTP responses
  // including those from iframes/subframes. Must be set before any window loads.
  const BLOCKED_HEADERS_LC = [
    'x-frame-options',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
  ]

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders }
      if (headers) {
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase()
          if (BLOCKED_HEADERS_LC.includes(lower)) {
            delete headers[key]
            continue
          }
          // Strip frame-ancestors from CSP
          if (lower === 'content-security-policy') {
            const values = headers[key]
            if (Array.isArray(values)) {
              headers[key] = values.map((v) =>
                v.replace(/frame-ancestors\s+[^;]+(;|$)/gi, '').trim()
              ).filter(Boolean)
              if (headers[key]!.length === 0) delete headers[key]
            }
          }
        }
      }
      callback({ cancel: false, responseHeaders: headers })
    }
  )

  // ── Patch Sec-CH-UA on all outgoing requests ──────────────────────────────
  // Electron's Sec-CH-UA omits the "Google Chrome" brand, which Akamai uses
  // as a signal.  We intercept via will-attach-webview to configure each
  // webview's session.
  //
  // We modify the defaultSession headers directly.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }

      // Rewrite Sec-CH-UA to include "Google Chrome" brand like real Chrome
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (lower === 'sec-ch-ua') {
          headers[key] = `"Chromium";v="${chromiumMajor}", "Google Chrome";v="${chromiumMajor}", "Not_A Brand";v="24"`
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[key] = `"Chromium";v="${chromiumVersion}", "Google Chrome";v="${chromiumVersion}", "Not_A Brand";v="24.0.0.0"`
        }
      }

      // If Sec-CH-UA wasn't present at all, add it
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'sec-ch-ua')) {
        headers['Sec-CH-UA'] = `"Chromium";v="${chromiumMajor}", "Google Chrome";v="${chromiumMajor}", "Not_A Brand";v="24"`
      }

      callback({ requestHeaders: headers })
    }
  )

  // Inject anti-bot JS patches into webview pages (handles client-side
  // fingerprinting that Akamai runs after the page loads).
  app.on('web-contents-created', (_event, contents) => {
    // Before any <webview> attaches, drop whatever preload / Node settings its
    // markup asked for. Guest pages get no bridge into this process.
    contents.on('will-attach-webview', (_e, webPreferences, params) => {
      hardenWebviewPreferences(webPreferences, params as unknown as Record<string, unknown>)
    })

    if (contents.getType() === 'webview') {
      // Intercept window.open calls from webviews — open valid URLs externally,
      // silently ignore about:blank and other invalid URLs to prevent the macOS
      // "no application set to open the URL" popup.
      contents.setWindowOpenHandler((details) => {
        if (isExternalUrl(details.url)) {
          shell.openExternal(details.url)
        }
        return { action: 'deny' }
      })

      contents.on('dom-ready', () => {
        // Each patch is best effort: a page that already locked a property
        // (non-configurable) keeps its own value, and the rest still apply.
        // Wrapped in a function so nothing leaks into (or clashes with) page globals.
        contents.executeJavaScript(`(() => {
          const patch = (apply) => { try { apply() } catch { /* locked by the page */ } };
          const define = (prop, get) => patch(() => Object.defineProperty(navigator, prop, { get, configurable: true }));
          define('webdriver', () => false);
          patch(() => {
            if (!window.chrome) { window.chrome = {}; }
            if (!window.chrome.runtime) { window.chrome.runtime = { id: undefined }; }
          });
          define('plugins', () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ]);
          define('languages', () => ['en-US', 'en']);
        })()`).catch(() => {
          // The page navigated away or was destroyed before the script ran.
        })
      })
    }
  })

  createWindow()

  // OpenCode server starts lazily on first agent session (avoids macOS permission
  // prompts for ~/Documents, ~/Downloads etc. on app launch).

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (isShuttingDown) {
    return
  }

  panelBrowserBroker.stopAll()

  event.preventDefault()

  // If a downloaded update is ready, offer to install before quitting
  if (isUpdateDownloaded()) {
    const version = getPendingVersion()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `A new version${version ? ` (v${version})` : ''} has been downloaded.`,
      detail: 'Would you like to install the update and restart, or quit without updating?',
      buttons: ['Install & Restart', 'Quit Without Updating'],
      defaultId: 0,
      cancelId: 1
    })

    if (response === 0) {
      // Install & restart — set flag first to prevent before-quit loop
      isShuttingDown = true
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.quitAndInstall()
      return
    }
  }

  isShuttingDown = true
  isQuitting = true

  void shutdownAppServices().finally(() => {
    app.exit(0)
  })
})
