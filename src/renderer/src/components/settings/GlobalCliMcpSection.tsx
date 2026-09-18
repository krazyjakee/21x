import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Loader2, RefreshCw, Edit3, Trash2, AlertTriangle, ChevronDown, ChevronRight, Wifi, WifiOff, FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { SettingsSection } from './SettingsSection'
import { GlobalMcpServerFormDialog } from './forms/GlobalMcpServerFormDialog'
import { cliMcpApi } from '@/lib/ipc-client'
import {
  CLI_LABELS,
  type CliId,
  type CliMcpConflict,
  type CliMcpMutationResult,
  type CliMcpSnapshot,
  type CliMcpUpsertRequest,
  type GlobalMcpServer
} from '@shared/cli-mcp-config'

const CLI_BADGE: Record<CliId, BadgeVariant> = { 'claude-code': 'orange', opencode: 'teal', codex: 'green' }

interface DialogState {
  open: boolean
  server?: GlobalMcpServer
}

/**
 * The MCP servers each installed CLI has in its own global config, in one
 * list. Every row is owned by exactly one CLI; the same server name in two
 * CLIs is two rows. Writes carry the fingerprint of the config as it was when
 * the snapshot loaded, so an edit made outside 20x in the meantime is shown
 * as a conflict instead of being overwritten.
 */
export function GlobalCliMcpSection() {
  const [snapshot, setSnapshot] = useState<CliMcpSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [probing, setProbing] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [conflict, setConflict] = useState<CliMcpConflict | null>(null)
  const [messages, setMessages] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] })
  const [dialog, setDialog] = useState<DialogState>({ open: false })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await cliMcpApi.snapshot())
      setConflict(null)
    } catch (err) {
      setMessages({ errors: [err instanceof Error ? err.message : 'Failed to read CLI config'], warnings: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const fingerprintFor = (cli: CliId): string | undefined => snapshot?.clis.find((entry) => entry.cli === cli)?.fingerprint

  /** Applies a mutation result: keeps the fresh snapshot, surfaces conflicts, errors and warnings. */
  const absorb = (result: CliMcpMutationResult): boolean => {
    setSnapshot(result.snapshot)
    const conflicted = result.results.find((entry) => entry.conflict)
    setConflict(conflicted?.conflict ?? null)
    setMessages({
      errors: result.results.filter((entry) => !entry.ok && !entry.conflict).map((entry) => `${CLI_LABELS[entry.cli]}: ${entry.error ?? 'failed'}`),
      warnings: result.results.flatMap((entry) => entry.warnings.map((warning) => `${CLI_LABELS[entry.cli]}: ${warning}`))
    })
    return result.results.every((entry) => entry.ok)
  }

  const run = async (key: string, action: () => Promise<CliMcpMutationResult>): Promise<boolean> => {
    setBusyKey(key)
    try {
      return absorb(await action())
    } catch (err) {
      setMessages({ errors: [err instanceof Error ? err.message : 'Operation failed'], warnings: [] })
      return false
    } finally {
      setBusyKey(null)
    }
  }

  const handleUpsert = async (request: Omit<CliMcpUpsertRequest, 'expectedFingerprints'>): Promise<void> => {
    const expectedFingerprints: Partial<Record<CliId, string>> = {}
    for (const cli of request.targets) {
      const fp = fingerprintFor(cli)
      if (fp) expectedFingerprints[cli] = fp
    }
    const ok = await run('upsert', () => cliMcpApi.upsert({ ...request, expectedFingerprints }))
    if (ok) setDialog({ open: false })
  }

  const handleRemove = async (server: GlobalMcpServer): Promise<void> => {
    if (!confirm(`Remove "${server.name}" from ${CLI_LABELS[server.cli]}'s global config?`)) return
    await run(rowKey(server), () => cliMcpApi.remove({ cli: server.cli, name: server.name, expectedFingerprint: fingerprintFor(server.cli) }))
  }

  const handleSetEnabled = async (server: GlobalMcpServer, enabled: boolean): Promise<void> => {
    await run(rowKey(server), () => cliMcpApi.setEnabled({ cli: server.cli, name: server.name, enabled, expectedFingerprint: fingerprintFor(server.cli) }))
  }

  const handleSetToolEnabled = async (server: GlobalMcpServer, tool: string, enabled: boolean): Promise<void> => {
    await run(`${rowKey(server)}:${tool}`, () => cliMcpApi.setToolEnabled({ cli: server.cli, name: server.name, tool, enabled, expectedFingerprint: fingerprintFor(server.cli) }))
  }

  const handleProbe = async (server: GlobalMcpServer): Promise<void> => {
    const key = rowKey(server)
    setProbing((prev) => new Set(prev).add(key))
    try {
      await cliMcpApi.probe({ cli: server.cli, name: server.name })
      setSnapshot(await cliMcpApi.snapshot())
      setExpanded((prev) => new Set(prev).add(key))
    } catch (err) {
      setMessages({ errors: [err instanceof Error ? err.message : 'Probe failed'], warnings: [] })
    } finally {
      setProbing((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const availableClis = useMemo<CliId[]>(
    () => (snapshot?.clis ?? []).filter((entry) => !entry.error).map((entry) => entry.cli),
    [snapshot]
  )
  const servers = snapshot?.servers ?? []

  return (
    <>
      <SettingsSection
        title="Global MCP (CLIs)"
        description="MCP servers configured globally for Claude Code, OpenCode and Codex. Each row belongs to one CLI; disabling here changes that CLI's own config file."
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {servers.length} entr{servers.length !== 1 ? 'ies' : 'y'} across {availableClis.length} CLI{availableClis.length !== 1 ? 's' : ''}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={refresh} disabled={loading} title="Reload from disk">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
            <Button size="sm" onClick={() => setDialog({ open: true })} disabled={availableClis.length === 0}>
              <Plus className="h-3.5 w-3.5" />
              Add Server
            </Button>
          </div>
        </div>

        {/* Per-CLI file status */}
        {snapshot && (
          <div className="flex flex-wrap gap-2">
            {snapshot.clis.map((entry) => (
              <div key={entry.cli} className={`text-[11px] px-2 py-1 rounded border ${entry.error ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/40'}`} title={entry.files.map((file) => `${file.role}: ${file.path}${file.exists ? '' : ' (missing)'}`).join('\n')}>
                <span className="font-medium">{entry.label}</span>
                <span className="text-muted-foreground"> · {entry.files.filter((file) => file.exists).length}/{entry.files.length} file{entry.files.length !== 1 ? 's' : ''}</span>
                {entry.error && <span className="text-destructive"> · {entry.error}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Conflict flow */}
        {conflict && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <FileWarning className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <p className="font-medium text-amber-300">{CLI_LABELS[conflict.cli]} config changed outside 21x</p>
              <p className="text-muted-foreground">
                Nothing was written. Reload to pick up the external change and try again.
                <span className="block truncate" title={conflict.paths.join('\n')}>{conflict.paths.join(', ')}</span>
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={refresh}>Reload</Button>
          </div>
        )}

        {messages.errors.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground space-y-0.5">
            {messages.errors.map((error, i) => <p key={i}>{error}</p>)}
          </div>
        )}
        {messages.warnings.length > 0 && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            {messages.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
          </div>
        )}

        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground">
              {loading ? 'Reading CLI config…' : 'No global MCP servers found in any CLI config'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const key = rowKey(server)
              const isBusy = busyKey === key
              const isProbing = probing.has(key)
              const isOpen = expanded.has(key)
              const knownTools = [...new Set([...(server.tools?.map((tool) => tool.name) ?? []), ...server.disabledTools])]
              const capabilities = snapshot?.clis.find((entry) => entry.cli === server.cli)?.capabilities
              const summary = server.definition.transport === 'stdio'
                ? `${server.definition.command ?? ''} ${(server.definition.args ?? []).join(' ')}`.trim()
                : server.definition.url ?? ''

              return (
                <div key={key} className={`rounded-lg border border-border bg-card overflow-hidden ${server.enabled ? '' : 'opacity-70'}`}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => toggleExpanded(key)} title={isOpen ? 'Collapse' : 'Tools and details'}>
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      server.probe?.status === 'connected' ? 'bg-primary'
                      : server.probe?.status === 'failed' ? 'bg-destructive'
                      : isProbing ? 'bg-muted animate-pulse'
                      : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{server.name}</span>
                        <Badge variant={CLI_BADGE[server.cli]}>{CLI_LABELS[server.cli]}</Badge>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{server.definition.transport}</span>
                        {!server.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">disabled</span>}
                        {server.disabledTools.length > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">{server.disabledTools.length} tool{server.disabledTools.length !== 1 ? 's' : ''} off</span>
                        )}
                        {server.issues.length > 0 && (
                          <span title={server.issues.join('\n')}><AlertTriangle className="h-3.5 w-3.5 text-amber-400" /></span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">{summary}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={server.enabled}
                        disabled={isBusy}
                        onCheckedChange={(checked) => handleSetEnabled(server, checked)}
                        title={capabilities?.serverToggle === 'deny-rule' ? 'Claude Code: denies every tool of this server via permissions.deny' : 'Enable or disable in the CLI config'}
                      />
                      <Button variant="ghost" size="icon" onClick={() => handleProbe(server)} disabled={isProbing} title="Connect and list tools">
                        {isProbing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDialog({ open: true, server })} title="Edit">
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleRemove(server)} className="text-destructive hover:text-destructive" title="Remove from this CLI" disabled={isBusy}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {server.probe && (
                    <div className={`flex items-center gap-2 px-4 py-2 text-xs border-t ${
                      server.probe.status === 'connected'
                        ? 'bg-accent/50 text-foreground border-l-2 border-primary'
                        : 'bg-destructive/10 text-destructive-foreground border-l-2 border-destructive'
                    }`}>
                      {server.probe.status === 'connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                      {server.probe.status === 'connected'
                        ? <>Connected{server.probe.toolCount != null && <span className="text-muted-foreground">· {server.probe.toolCount} tool{server.probe.toolCount !== 1 ? 's' : ''}</span>}</>
                        : <span className="truncate" title={server.probe.errorDetail || server.probe.error}>{server.probe.error || 'Connection failed'}</span>}
                    </div>
                  )}

                  {isOpen && (
                    <div className="border-t border-border px-4 py-3 space-y-3 text-xs">
                      {server.issues.length > 0 && (
                        <ul className="space-y-0.5 text-amber-400">
                          {server.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                        </ul>
                      )}
                      {(server.maskedKeys.env.length > 0 || server.maskedKeys.headers.length > 0) && (
                        <p className="text-muted-foreground">
                          Masked: {[...server.maskedKeys.env, ...server.maskedKeys.headers].join(', ')}
                        </p>
                      )}
                      {server.enabledToolsOnly && (
                        <p className="text-muted-foreground">Codex enabled_tools allowlist: {server.enabledToolsOnly.join(', ') || '(empty)'}</p>
                      )}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Tools</span>
                          <span className="text-muted-foreground">
                            {capabilities?.toolToggle === 'deny-rule' ? 'Switched through permissions.deny' : capabilities?.toolToggle === 'native' ? `Switched in ${CLI_LABELS[server.cli]} config` : 'Not switchable in this CLI'}
                          </span>
                        </div>
                        {knownTools.length === 0 ? (
                          <p className="text-muted-foreground">No tool list yet. Use the refresh button on this row to connect and discover tools.</p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                            {knownTools.map((tool) => {
                              const description = server.tools?.find((entry) => entry.name === tool)?.description
                              const disabled = server.disabledTools.includes(tool)
                              const toolBusy = busyKey === `${key}:${tool}`
                              return (
                                <label key={tool} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1" title={description}>
                                  <Switch
                                    className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
                                    checked={!disabled}
                                    disabled={toolBusy || capabilities?.toolToggle === 'none'}
                                    onCheckedChange={(checked) => handleSetToolEnabled(server, tool, checked)}
                                  />
                                  <span className={`truncate ${disabled ? 'text-muted-foreground line-through' : ''}`}>{tool}</span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <GlobalMcpServerFormDialog
        open={dialog.open}
        server={dialog.server}
        availableClis={availableClis}
        onClose={() => setDialog({ open: false })}
        onSubmit={handleUpsert}
      />
    </>
  )
}

function rowKey(server: { cli: CliId; name: string }): string {
  return `${server.cli}:${server.name}`
}
