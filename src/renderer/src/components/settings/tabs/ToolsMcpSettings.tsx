import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Loader2, Wifi, WifiOff, RefreshCw, Edit3, Trash2, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { McpServerFormDialog } from '../forms/McpServerFormDialog'
import { GlobalCliMcpSection } from '../GlobalCliMcpSection'
import { useMcpStore, getMcpConfigurationRevision } from '@/stores/mcp-store'
import type { McpServer, CreateMcpServerDTO } from '@/types'

interface McpConnectionInfo {
  status: 'idle' | 'testing' | 'connected' | 'failed'
  error?: string
  errorDetail?: string
  toolCount?: number
  version?: string
}

interface McpDialogState {
  open: boolean
  intent: number
  server?: McpServer
}

const serverVersion = (server: McpServer) => JSON.stringify([getMcpConfigurationRevision(), server.id, server.type, server.url, server.command, server.args, server.headers, server.environment, server.updated_at])
export function ToolsMcpSettings() {
  const nativeDesktop = getDesktopHost().kind === 'tauri'
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const host = getDesktopHost()
    let generation = host.connectionGeneration, off: (() => void) | undefined
    const retire = () => {
      alive.current = false
      off?.(); off = undefined
      window.removeEventListener('pagehide', retire)
    }
    if (host.kind === 'tauri') off = host.subscribeConnection(() => {
      if (!alive.current || generation === host.connectionGeneration) return
      generation = host.connectionGeneration
      setConnections(new Map())
    })
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])
  const {
    servers, error, fetchServers, createServer, updateServer, deleteServer,
    testConnection: testMcpConnection,
    oauthStatuses, startOAuthFlow, submitManualClientId, revokeOAuthToken,
    fetchAllOAuthStatuses, authRequired, probeForAuth, probeAllForAuth
  } = useMcpStore()
  const [connections, setConnections] = useState<Map<string, McpConnectionInfo>>(new Map())
  const [mcpDialog, setMcpDialog] = useState<McpDialogState>({ open: false, intent: 0 })
  const dialogIntent = useRef(0)
  const openDialog = (server?: McpServer) => setMcpDialog({ open: true, server, intent: ++dialogIntent.current })
  const closeDialog = (intent: number) => {
    if (dialogIntent.current !== intent) return
    setMcpDialog({ open: false, intent: ++dialogIntent.current })
  }
  useEffect(() => {
    setConnections(previous => {
      const next = new Map([...previous].filter(([id, value]) => servers.some(server => server.id === id && value.version === serverVersion(server))))
      return next.size === previous.size ? previous : next
    })
  }, [servers])

  useEffect(() => {
    fetchServers()
  }, [])

  useEffect(() => {
    if (nativeDesktop && servers.length > 0) void fetchAllOAuthStatuses()
  }, [nativeDesktop, servers, fetchAllOAuthStatuses])

  useEffect(() => {
    // Shipping Electron keeps its existing initial probes. Native catalog
    // mount/recovery only reads metadata; Test connection is explicit.
    if (!nativeDesktop && servers.length > 0) {
      servers.forEach((server) => { void testServerConnection(server) })
      void fetchAllOAuthStatuses()
      void probeAllForAuth()
    }
  }, [servers.length])

  const testServerConnection = async (server: McpServer) => {
    const scope = captureDesktopRead(), version = serverVersion(server)
    const current = () => alive.current && scope.isCurrent() && useMcpStore.getState().servers.some(row => row.id === server.id && serverVersion(row) === version)
    if (!current()) return
    setConnections((prev) => new Map(prev).set(server.id, { status: 'testing', version }))

    try {
      const testData = server.type === 'remote'
        ? { id: server.id, name: server.name, type: 'remote' as const, url: server.url, headers: server.headers }
        : { id: server.id, name: server.name, type: 'local' as const, command: server.command, args: server.args, environment: server.environment }

      const result = await testMcpConnection(testData)
      if (!current()) return
      setConnections((prev) => new Map(prev).set(server.id, {
        version, status: result.status,
        error: result.error,
        errorDetail: result.errorDetail,
        toolCount: result.toolCount
      }))
    } catch (err: unknown) {
      if (!current()) return
      setConnections((prev) => new Map(prev).set(server.id, {
        version, status: 'failed', error: nativeDesktop ? 'Connection test failed. Review current settings before retrying.' : err instanceof Error ? err.message : 'Test failed'
      }))
    }
  }

  const handleCreateServer = async (data: CreateMcpServerDTO) => {
    const scope = captureDesktopRead(), intent = mcpDialog.intent
    const current = () => alive.current && scope.isCurrent() && dialogIntent.current === intent
    if (!current()) return false
    const server = await createServer(data)
    if (!server || !current()) return false
    if (!nativeDesktop && data.type === 'remote' && data.url) {
      // Preserve Electron's automatic sign-in only for the originating view.
      try {
        const needed = await probeForAuth(server.id, data.url)
        if (needed && current()) await startOAuthFlow(server.id)
      } catch { /* An optional sign-in failure does not undo an accepted save. */ }
    }
    return true
  }

  const handleUpdateServer = async (data: CreateMcpServerDTO) => {
    const scope = captureDesktopRead(), intent = mcpDialog.intent, server = mcpDialog.server
    const current = () => alive.current && scope.isCurrent() && dialogIntent.current === intent
    if (!server || !current()) return false
    const saved = await updateServer(server.id, data)
    return !!saved && current()
  }

  const handleDeleteServer = async (id: string) => {
    if (confirm('Delete this MCP server? It will be removed from all agents.')) {
      await deleteServer(id)
    }
  }

  // OAuth callbacks passed to the dialog
  const handleProbeForAuth = useCallback(async (url: string): Promise<boolean> => {
    if (getDesktopHost().kind === 'tauri') return false
    try {
      const { requiresAuth } = await useMcpStore.getState().servers.length
        ? await (await import('@/lib/ipc-client')).mcpServerApi.probeForAuth(url)
        : { requiresAuth: false }
      return requiresAuth
    } catch {
      return false
    }
  }, [])

  const handleStartOAuthFlow = useCallback(async (serverId: string) => {
    return await startOAuthFlow(serverId)
  }, [startOAuthFlow])

  const handleSubmitManualClientId = useCallback(async (serverId: string, clientId: string) => {
    return await submitManualClientId(serverId, clientId)
  }, [submitManualClientId])

  const handleRevokeOAuthToken = useCallback(async (serverId: string) => {
    await revokeOAuthToken(serverId)
  }, [revokeOAuthToken])

  const oauthCallbacks = {
    probeForAuth: handleProbeForAuth,
    startOAuthFlow: handleStartOAuthFlow,
    submitManualClientId: handleSubmitManualClientId,
    revokeOAuthToken: handleRevokeOAuthToken
  }

  // Is server OAuth-related? (has registration or probe says auth required)
  const isOAuthServer = (server: McpServer): boolean => {
    if (server.type !== 'remote') return false
    const hasRegistration = server.oauth_metadata && 'resource_url' in server.oauth_metadata
    return !!(hasRegistration || authRequired[server.id])
  }

  // Should the connection error row be hidden?
  // For OAuth servers, the connection test doesn't inject the token so it always gets 401.
  // Hide the error for all OAuth servers — the OAuth status row replaces it.
  const shouldHideConnectionRow = (server: McpServer, connection: McpConnectionInfo): boolean => {
    if (connection.status !== 'failed') return false
    return isOAuthServer(server)
  }

  return (
    <>
      <SettingsSection
        title="MCP Servers"
        description="Manage Model Context Protocol servers for tools and integrations"
      >
        {error && <p role="alert" className="text-sm text-destructive">MCP settings could not be loaded or saved. Review current values before retrying.</p>}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {servers.length} server{servers.length !== 1 ? 's' : ''} configured
          </p>
          <Button size="sm" onClick={() => openDialog()}>
            <Plus className="h-3.5 w-3.5" />
            Add Server
          </Button>
        </div>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">No MCP servers configured yet</p>
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-3.5 w-3.5" />
              Add Your First Server
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const observed = connections.get(server.id)
              const connection: McpConnectionInfo = observed && observed.version === serverVersion(server) ? observed : { status: 'idle' }
              const hideConnectionRow = shouldHideConnectionRow(server, connection)
              const oauthStatus = oauthStatuses[server.id]
              const hasOAuth = isOAuthServer(server)

              return (
                <div key={server.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      connection.status === 'connected' ? 'bg-primary'
                      : connection.status === 'failed' && !hideConnectionRow ? 'bg-destructive'
                      : connection.status === 'testing' ? 'bg-muted animate-pulse'
                      : hasOAuth && oauthStatus?.connected ? 'bg-emerald-500'
                      : hasOAuth ? 'bg-amber-500'
                      : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{server.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          server.type === 'remote'
                            ? 'bg-blue-500/10 text-blue-300'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {server.type === 'remote' ? 'remote' : 'local'}
                        </span>
                        {hasOAuth && oauthStatus?.connected === false && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 flex items-center gap-1">
                            <KeyRound className="h-2.5 w-2.5" />
                            Auth needed
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {server.type === 'remote'
                          ? server.url
                          : `${server.command} ${server.args.join(' ')}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => testServerConnection(server)}
                        disabled={connection.status === 'testing'}
                        title="Test connection"
                      >
                        {connection.status === 'testing' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openDialog(server)}
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteServer(server.id)}
                        className="text-destructive hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {/* Connection status row */}
                  {connection.status !== 'idle' && !hideConnectionRow && (
                    <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t ${
                      connection.status === 'connected' ? 'bg-accent/50 text-foreground border-l-2 border-primary'
                      : connection.status === 'failed' ? 'bg-destructive/10 text-destructive-foreground border-l-2 border-destructive'
                      : 'bg-muted text-muted-foreground border-border'
                    }`}>
                      {connection.status === 'testing' ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Testing connection...
                        </>
                      ) : connection.status === 'connected' ? (
                        <>
                          <Wifi className="h-3 w-3" />
                          Connected
                          {connection.toolCount != null && (
                            <span className="text-muted-foreground">
                              · {connection.toolCount} tool{connection.toolCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </>
                      ) : connection.status === 'failed' ? (
                        <>
                          <WifiOff className="h-3 w-3" />
                          <span className="truncate" title={connection.errorDetail || connection.error}>{connection.error || 'Connection failed'}</span>
                        </>
                      ) : null}
                    </div>
                  )}
                  {/* OAuth Connected status row — shown when 401 error is hidden */}
                  {hideConnectionRow && hasOAuth && oauthStatus?.connected && (
                    <div className="flex items-center gap-2 px-4 py-2 text-xs border-t bg-accent/50 text-foreground border-l-2 border-primary">
                      <Wifi className="h-3 w-3" />
                      Connected
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <McpServerFormDialog
        key={mcpDialog.intent}
        server={mcpDialog.server}
        open={mcpDialog.open}
        onClose={() => closeDialog(mcpDialog.intent)}
        onSubmit={mcpDialog.server ? handleUpdateServer : handleCreateServer}
        oauthConnected={mcpDialog.server ? oauthStatuses[mcpDialog.server.id]?.connected : undefined}
        browserSignInAvailable={!nativeDesktop}
        oauth={oauthCallbacks}
      />

      {/* Global config of the installed CLIs; separate from 20x's own server list above. */}
      <GlobalCliMcpSection />
    </>
  )
}
