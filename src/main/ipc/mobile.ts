import { ipcMain } from 'electron'
import { networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelActive } from '../tunnel-manager'
import { getPendingPin } from '../mobile-api-server'
import type { IpcDeps } from './deps'

const MOBILE_PORT = 20620
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
    const lanIp = firstLanIPv4()
    const remoteMode: 'quick' | 'custom' = db.getSetting('mobile_remote_mode') === 'custom' ? 'custom' : 'quick'
    const customUrl = db.getSetting('mobile_custom_url') || null
    const remoteBaseUrl = remoteMode === 'custom' ? customUrl : getTunnelUrl()
    const baseUrl = remoteBaseUrl ?? `http://${lanIp}:${MOBILE_PORT}`

    return {
      url: `${baseUrl}/pair?code=${initCode}`,
      port: MOBILE_PORT,
      lanUrl: `http://${lanIp}:${MOBILE_PORT}/pair?code=${initCode}`,
      tunnelUrl: remoteBaseUrl ? `${remoteBaseUrl}/pair?code=${initCode}` : null,
      tunnelActive: remoteMode === 'custom' ? Boolean(customUrl) : isTunnelActive(),
      remoteMode,
      customUrl
    }
  })

  ipcMain.handle('mobile:startTunnel', async () => {
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
