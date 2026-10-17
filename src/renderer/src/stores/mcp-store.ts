import { create } from 'zustand'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'
import type { McpServer, CreateMcpServerDTO, UpdateMcpServerDTO } from '@/types'
import type { McpTestResult } from '@/types/electron'
import { mcpServerApi } from '@/lib/ipc-client'

interface OAuthStatus {
  connected: boolean
  expiresAt?: string
}

interface McpState {
  servers: McpServer[]
  isLoading: boolean
  error: string | null
  oauthStatuses: Record<string, OAuthStatus>
  authRequired: Record<string, boolean>

  fetchServers: () => Promise<void>
  createServer: (data: CreateMcpServerDTO) => Promise<McpServer | null>
  updateServer: (id: string, data: UpdateMcpServerDTO) => Promise<McpServer | null>
  deleteServer: (id: string) => Promise<boolean>
  testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }) => Promise<McpTestResult>
  startOAuthFlow: (mcpServerId: string) => Promise<{ needsManualClientId?: boolean }>
  submitManualClientId: (mcpServerId: string, clientId: string) => Promise<{ needsManualClientId?: boolean }>
  revokeOAuthToken: (mcpServerId: string) => Promise<void>
  fetchAllOAuthStatuses: () => Promise<void>
  probeForAuth: (serverId: string, serverUrl: string) => Promise<boolean>
  probeAllForAuth: () => Promise<void>
}

let requested = false, documentGeneration = 0, metadataRevision = 0
export function retireMcpDesktopState(): void {
  requested = false; documentGeneration++; metadataRevision++; mcpSnapshot.dispose()
  window.removeEventListener('pagehide', retireMcpDesktopState)
}
function ownDocument() { window.addEventListener('pagehide', retireMcpDesktopState, { once: true }) }
function captureMcpIntent() {
  ownDocument()
  const generation = documentGeneration, scope = captureDesktopRead()
  return () => generation === documentGeneration && scope.isCurrent()
}
function invalidateMetadata() { requested = true; metadataRevision++; mcpSnapshot.invalidate() }
/** Public configuration may mask a changed credential into identical text. */
export function getMcpConfigurationRevision(): number { return metadataRevision }

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  isLoading: false,
  error: null,
  oauthStatuses: {},
  authRequired: {},

  fetchServers: async () => {
    ownDocument(); invalidateMetadata()
    await mcpSnapshot.refresh().catch(() => {})
  },

  createServer: async (data) => {
    const current = captureMcpIntent()
    try {
      const server = await mcpServerApi.create(data)
      if (current()) {
        invalidateMetadata()
        set((state) => ({ servers: [...state.servers.filter(item => item.id !== server.id), server] }))
      }
      return server
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  updateServer: async (id, data) => {
    const current = captureMcpIntent()
    try {
      const updated = await mcpServerApi.update(id, data)
      if (updated && current()) {
        invalidateMetadata()
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  deleteServer: async (id) => {
    const current = captureMcpIntent()
    try {
      const success = await mcpServerApi.delete(id)
      if (success && current()) {
        invalidateMetadata()
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      if (current()) set({ error: String(err) })
      return false
    }
  },

  testConnection: async (data) => {
    const current = captureMcpIntent()
    const revision = metadataRevision
    const result = await mcpServerApi.testConnection(data)
    if (current() && revision === metadataRevision && data.id && result.tools && result.status === 'connected') {
      requested = true; mcpSnapshot.invalidate()
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === data.id ? { ...s, tools: result.tools! } : s
        )
      }))
    }
    return result
  },

  startOAuthFlow: async (mcpServerId: string) => {
    const current = captureMcpIntent(), revision = metadataRevision
    try {
      const result = await mcpServerApi.startOAuthFlow(mcpServerId)
      if (!current() || revision !== metadataRevision) return result
      if (!result.needsManualClientId) {
        // Flow completed — refresh status
        const status = await mcpServerApi.getOAuthStatus(mcpServerId)
        if (current() && revision === metadataRevision) set((state) => ({
          oauthStatuses: { ...state.oauthStatuses, [mcpServerId]: status }
        }))
      }
      return result
    } catch (err) {
      if (current() && revision === metadataRevision) set({ error: String(err) })
      return {}
    }
  },

  submitManualClientId: async (mcpServerId: string, clientId: string) => {
    const current = captureMcpIntent(), revision = metadataRevision
    try {
      const result = await mcpServerApi.submitManualClientId(mcpServerId, clientId)
      if (!current() || revision !== metadataRevision) return result
      if (!result.needsManualClientId) {
        const status = await mcpServerApi.getOAuthStatus(mcpServerId)
        if (current() && revision === metadataRevision) set((state) => ({
          oauthStatuses: { ...state.oauthStatuses, [mcpServerId]: status }
        }))
      }
      return result
    } catch (err) {
      if (current() && revision === metadataRevision) set({ error: String(err) })
      return {}
    }
  },

  revokeOAuthToken: async (mcpServerId: string) => {
    const current = captureMcpIntent(), revision = metadataRevision
    try {
      await mcpServerApi.revokeOAuthToken(mcpServerId)
      if (!current() || revision !== metadataRevision) return
      set((state) => ({
        oauthStatuses: { ...state.oauthStatuses, [mcpServerId]: { connected: false } }
      }))
    } catch (err) {
      if (current() && revision === metadataRevision) set({ error: String(err) })
    }
  },

  fetchAllOAuthStatuses: async () => {
    const current = captureMcpIntent(), revision = metadataRevision
    const servers = get().servers.filter(server => server.type === 'remote' && server.oauth_metadata && 'resource_url' in server.oauth_metadata)
    const statuses: Record<string, OAuthStatus> = {}
    // Local credential metadata reads only; bound pending RPCs to one.
    for (const server of servers) {
      if (!current() || revision !== metadataRevision) return
      try { statuses[server.id] = await mcpServerApi.getOAuthStatus(server.id) }
      catch { /* Failed metadata is unknown, never a fabricated disconnect. */ }
    }
    if (current() && revision === metadataRevision) set({ oauthStatuses: statuses })
  },

  probeForAuth: async (serverId: string, serverUrl: string) => {
    const current = captureMcpIntent()
    try {
      const revision = metadataRevision
      const { requiresAuth } = await mcpServerApi.probeForAuth(serverUrl)
      if (!current() || revision !== metadataRevision) return false
      set((state) => ({
        authRequired: { ...state.authRequired, [serverId]: requiresAuth }
      }))
      return requiresAuth
    } catch {
      return false
    }
  },

  probeAllForAuth: async () => {
    const current = captureMcpIntent(), revision = metadataRevision
    const remoteServers = get().servers.filter(server => server.type === 'remote' && server.url)
    const results: Record<string, boolean> = {}
    for (const server of remoteServers) {
      if (!current() || revision !== metadataRevision) return
      try { results[server.id] = (await mcpServerApi.probeForAuth(server.url)).requiresAuth }
      catch { /* A failed probe cannot grant or prove authentication. */ }
    }
    if (current() && revision === metadataRevision) set({ authRequired: results })
  }
}))

const mcpSnapshot = createDesktopSnapshotReader({
  read: () => mcpServerApi.getAll(),
  start: () => useMcpStore.setState({ isLoading: true, error: null }),
  apply: servers => useMcpStore.setState({ servers, isLoading: false, error: null,
    ...(getDesktopHost().kind === 'tauri' ? { oauthStatuses: {}, authRequired: {} } : {}) }),
  fail: error => useMcpStore.setState({ isLoading: false, error: String(error) })
})
/** Configuration only: no process probe, browser sign-in or remote effect. */
export async function rehydrateMcpDesktopState(): Promise<void> {
  if (!requested) return
  ownDocument(); invalidateMetadata()
  useMcpStore.setState({ oauthStatuses: {}, authRequired: {} })
  await mcpSnapshot.refresh()
}
if (import.meta.hot) import.meta.hot.dispose(retireMcpDesktopState)
