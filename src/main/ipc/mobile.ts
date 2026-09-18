import { ipcMain } from 'electron'
import { networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelActive } from '../tunnel-manager'
import {
  applyMobileAccessSettings,
  getMobileSessionIdleDays,
  getPendingPin,
  isMobileAccessEnabled,
  isMobileLanAccessEnabled,
  MOBILE_ACCESS_ENABLED_SETTING,
  MOBILE_API_PORT,
  MOBILE_LAN_ACCESS_SETTING,
  MOBILE_SESSION_IDLE_DAYS_SETTING
} from '../mobile-api-server'
import type { IpcDeps } from './deps'

const MOBILE_PORT = MOBILE_API_PORT
const INIT_CODE_TTL_SECONDS = 300
const INVALID_URL_MESSAGE = 'Enter a valid URL starting with http:// or https://'

function firstLanIPv4(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return 'localhost'
}

/** Mobile web UI pairing, remote access (quick tunnel or custom URL) and paired sessions. */
export function registerMobileHandlers({ db }: IpcDeps): void {
  // The QR code carries a one-time init code, never the session token.
  const generateInitCode = (): string => {
    const initCode = randomUUID()
    const expiresAt = Math.floor(Date.now() / 1000) + INIT_CODE_TTL_SECONDS
    db.setSetting(`mobile_init_code_${initCode}`, '1')
    db.setSetting(`mobile_init_code_${initCode}_exp`, String(expiresAt))
    return initCode
  }

  ipcMain.handle('mobile:getInfo', () => {
    const initCode = generateInitCode()
    const enabled = isMobileAccessEnabled(db)
    const lanAccess = isMobileLanAccessEnabled(db)
    const lanIp = firstLanIPv4()
    const remoteMode: 'quick' | 'custom' = db.getSetting('mobile_remote_mode') === 'custom' ? 'custom' : 'quick'
    const customUrl = db.getSetting('mobile_custom_url') || null
    const remoteBaseUrl = remoteMode === 'custom' ? customUrl : getTunnelUrl()
    // Without LAN access the server listens on 127.0.0.1 only, so a LAN URL
    // would not work from a phone.
    const lanUrl = enabled && lanAccess ? `http://${lanIp}:${MOBILE_PORT}/pair?code=${initCode}` : null
    const baseUrl = remoteBaseUrl ?? `http://${lanAccess ? lanIp : '127.0.0.1'}:${MOBILE_PORT}`

    return {
      enabled,
      lanAccess,
      sessionIdleDays: getMobileSessionIdleDays(db),
      url: `${baseUrl}/pair?code=${initCode}`,
      port: MOBILE_PORT,
      lanUrl,
      tunnelUrl: enabled && remoteBaseUrl ? `${remoteBaseUrl}/pair?code=${initCode}` : null,
      tunnelActive: remoteMode === 'custom' ? Boolean(customUrl) : isTunnelActive(),
      remoteMode,
      customUrl
    }
  })

  // Mobile access and LAN exposure are opt-in; changing either starts, stops
  // or rebinds the mobile API server immediately.
  ipcMain.handle('mobile:setAccess', async (_, options: { enabled?: boolean; lanAccess?: boolean; sessionIdleDays?: number }) => {
    if (typeof options.enabled === 'boolean') db.setSetting(MOBILE_ACCESS_ENABLED_SETTING, options.enabled ? 'true' : 'false')
    if (typeof options.lanAccess === 'boolean') db.setSetting(MOBILE_LAN_ACCESS_SETTING, options.lanAccess ? 'true' : 'false')
    if (typeof options.sessionIdleDays === 'number' && Number.isFinite(options.sessionIdleDays) && options.sessionIdleDays > 0) {
      db.setSetting(MOBILE_SESSION_IDLE_DAYS_SETTING, String(options.sessionIdleDays))
    }
    if (options.enabled === false) stopTunnel()
    const port = await applyMobileAccessSettings()
    return {
      enabled: isMobileAccessEnabled(db),
      lanAccess: isMobileLanAccessEnabled(db),
      sessionIdleDays: getMobileSessionIdleDays(db),
      listening: port != null
    }
  })

  ipcMain.handle('mobile:startTunnel', async () => {
    if (!isMobileAccessEnabled(db)) throw new Error('Turn on mobile access first.')
    const url = await startTunnel(MOBILE_PORT)
    // Only persist 'quick' mode once the tunnel actually connects — if
    // startTunnel() throws, the mode setting must stay whatever it was before
    // (e.g. a still-valid 'custom' mode/URL shouldn't be clobbered by a
    // failed quick-tunnel attempt).
    db.setSetting('mobile_remote_mode', 'quick')
    return { tunnelUrl: `${url}/pair?code=${generateInitCode()}` }
  })

  ipcMain.handle('mobile:stopTunnel', () => {
    stopTunnel()
    return { success: true }
  })

  ipcMain.handle('mobile:setCustomUrl', (_, rawUrl: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl.trim())
    } catch {
      throw new Error(INVALID_URL_MESSAGE)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(INVALID_URL_MESSAGE)
    const url = parsed.href.replace(/\/+$/, '')
    stopTunnel()
    db.setSetting('mobile_remote_mode', 'custom')
    db.setSetting('mobile_custom_url', url)
    return { url: `${url}/pair?code=${generateInitCode()}` }
  })

  ipcMain.handle('mobile:clearCustomUrl', () => {
    db.setSetting('mobile_remote_mode', 'quick')
    db.deleteSetting('mobile_custom_url')
    return { success: true }
  })

  ipcMain.handle('mobile:getPendingPin', () => getPendingPin())

  ipcMain.handle('mobile:getSessions', () => db.getMobileSessions())

  ipcMain.handle('mobile:revokeSession', (_, sessionId: string) => ({ success: db.revokeMobileSession(sessionId) }))

  ipcMain.handle('mobile:revokeAllSessions', () => {
    db.revokeAllMobileSessions()
    return { success: true }
  })
}
