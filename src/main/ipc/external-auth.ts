import { ipcMain, app, session } from 'electron'
import { spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import WebSocket from 'ws'
import { findExecutable } from '../find-executable'

// Some sites refuse to log in inside an embedded browser. This flow launches
// the user's system Chrome with a temporary debugging port, waits for the user
// to log in (the URL leaves the login page), captures every cookie via CDP,
// injects them into the Electron session, and returns the final URL so the
// webview can reload already signed in.

const EXT_CDP_PORT = 19333
const CDP_BASE = `http://127.0.0.1:${EXT_CDP_PORT}`
const LOGIN_TIMEOUT_MS = 300_000
const LOGIN_POLL_MS = 1500

interface CapturedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  expirationDate?: number
}

const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Arc.app/Contents/MacOS/Arc',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
]

const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'brave-browser', 'chromium-browser', 'chromium', 'microsoft-edge']

/** Path of an installed Chromium-based browser (Chrome, Brave, Arc, Edge, Chromium), or null. */
async function findChromiumBrowser(): Promise<string | null> {
  if (process.platform === 'darwin') return MAC_BROWSERS.find((p) => existsSync(p)) ?? null
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].find((p) => existsSync(p)) ?? null
  }
  for (const name of LINUX_BROWSERS) {
    const found = await findExecutable(name)
    if (found) return found
  }
  return null
}

async function waitForCdp(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${CDP_BASE}/json/version`)).ok) return
    } catch { /* not ready yet */ }
    await sleep(500)
  }
  throw new Error('Chrome CDP did not start in time')
}

async function listCdpTargets(): Promise<Array<{ url: string; type: string; webSocketDebuggerUrl?: string }>> {
  return (await (await fetch(`${CDP_BASE}/json/list`)).json()) as Array<{ url: string; type: string; webSocketDebuggerUrl?: string }>
}

/**
 * Polls until the page leaves the login domain (returns its URL), or the user
 * closes Chrome / the timeout passes (returns the login URL).
 */
async function waitForLogin(loginUrl: string, isClosed: () => boolean): Promise<string> {
  const loginDomain = new URL(loginUrl).hostname
  const startTime = Date.now()
  while (!isClosed() && Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    await sleep(LOGIN_POLL_MS)
    if (isClosed()) break
    try {
      const page = (await listCdpTargets()).find((t) => t.type === 'page')
      if (
        page &&
        new URL(page.url).hostname !== loginDomain &&
        !page.url.includes('/login') &&
        !page.url.includes('/identity')
      ) {
        return page.url
      }
    } catch {
      // Chrome may be closing; the loop condition decides.
    }
  }
  return loginUrl
}

/** Every cookie in the Chrome profile, via CDP `Network.getAllCookies`. */
async function captureCookies(): Promise<CapturedCookie[]> {
  const page = (await listCdpTargets()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) return []
  const wsUrl = page.webSocketDebuggerUrl

  return new Promise<CapturedCookie[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const msgId = 1
    ws.on('open', () => ws.send(JSON.stringify({ id: msgId, method: 'Network.getAllCookies' })))
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id !== msgId || !msg.result?.cookies) return
        ws.close()
        resolve(msg.result.cookies.map((c: Record<string, unknown>) => ({
          name: c.name as string,
          value: c.value as string,
          domain: c.domain as string,
          path: (c.path as string) || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite as string | undefined,
          expirationDate: c.expires as number | undefined,
        })))
      } catch { /* not the reply we are waiting for */ }
    })
    ws.on('error', reject)
    setTimeout(() => { ws.close(); reject(new Error('CDP cookie fetch timeout')) }, 10_000)
  })
}

function toElectronSameSite(sameSite: string | undefined): 'no_restriction' | 'lax' | 'strict' {
  if (sameSite === 'None') return 'no_restriction'
  if (sameSite === 'Strict') return 'strict'
  return 'lax'
}

async function injectCookies(cookies: CapturedCookie[]): Promise<void> {
  const ses = session.defaultSession
  let injected = 0
  for (const cookie of cookies) {
    try {
      await ses.cookies.set({
        url: `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: toElectronSameSite(cookie.sameSite),
        expirationDate: cookie.expirationDate && cookie.expirationDate > 0 ? cookie.expirationDate : undefined,
      })
      injected++
    } catch {
      // Some cookies are rejected (e.g. __Host- prefixed cookies with a domain set).
    }
  }
  console.log(`[BrowserAuth] Injected ${injected}/${cookies.length} cookies into Electron session`)
}

export function registerExternalAuthHandlers(): void {
  ipcMain.handle('browser:openExternalAuth', async (_event, loginUrl: string) => {
    const chromePath = await findChromiumBrowser()
    if (!chromePath) {
      throw new Error('Could not find a Chromium-based browser (Chrome, Brave, Arc, Edge). Please install one and try again.')
    }

    const tmpProfile = join(app.getPath('temp'), '20x-chrome-auth-' + Date.now())
    const chromeProc = spawn(chromePath, [
      `--remote-debugging-port=${EXT_CDP_PORT}`,
      `--user-data-dir=${tmpProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1024,768',
      loginUrl,
    ], { detached: false, stdio: 'ignore' })

    try {
      await waitForCdp()

      let chromeExited = false
      chromeProc.on('exit', () => { chromeExited = true })
      const finalUrl = await waitForLogin(loginUrl, () => chromeExited)

      let cookies: CapturedCookie[] = []
      if (!chromeExited) {
        try {
          cookies = await captureCookies()
        } catch (err) {
          console.warn('[BrowserAuth] Failed to capture cookies from Chrome:', err)
        }
        try { chromeProc.kill() } catch { /* already exited */ }
      }

      if (cookies.length > 0) await injectCookies(cookies)

      // Chrome may still hold the profile open for a moment after being killed.
      setTimeout(() => {
        try { rmSync(tmpProfile, { recursive: true, force: true }) } catch { /* best effort */ }
      }, 5000)

      return { success: cookies.length > 0, finalUrl, cookieCount: cookies.length }
    } catch (err) {
      try { chromeProc.kill() } catch { /* already exited */ }
      throw err
    }
  })
}
