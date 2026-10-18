import { captureDesktopRead, getDesktopHost, desktopApi } from '@/lib/desktop-api'
import { useState, useEffect, useRef } from 'react'
import { Plus, Loader2, RefreshCw, Edit3, Trash2, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { TaskSourceFormDialog } from '../forms/TaskSourceFormDialog'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { getCurrentProjectId, isInProject, useProjectStore } from '@/stores/project-store'
import { useProjectTaskSources, useCurrentProject } from '@/hooks/use-project-tasks'
import { pluginApi } from '@/lib/ipc-client'
import type { CreateTaskSourceDTO, PluginMeta, TaskSource } from '@/types'

export function IntegrationsSettings() {
  const nativeDesktop = getDesktopHost().kind === 'tauri'
  const { error, syncingIds, createSource, updateSource, deleteSource, syncSource, fetchSources } = useTaskSourceStore()
  // Sources belong to a project: this tab shows and creates the current project's.
  const sources = useProjectTaskSources()
  const currentProject = useCurrentProject()
  const projectLabel = currentProject?.name ?? 'this project'
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [tsDialog, setTsDialog] = useState<{ open: boolean; intent: number; projectId: string; source?: TaskSource }>({ open: false, intent: 0, projectId: getCurrentProjectId() })
  const [oauthStatus, setOauthStatus] = useState<Map<string, boolean>>(new Map())

  const alive = useRef(true)
  const dialogIntent = useRef(0)
  const openDialog = (source?: TaskSource) => setTsDialog({ open: true, source, intent: ++dialogIntent.current, projectId: getCurrentProjectId() })
  const closeDialog = (intent: number) => {
    if (dialogIntent.current !== intent) return
    setTsDialog({ open: false, intent: ++dialogIntent.current, projectId: getCurrentProjectId() })
  }
  useEffect(() => {
    alive.current = true
    const projectOff = useProjectStore.subscribe((state, previous) => {
      if (state.currentProjectId !== previous.currentProjectId) closeDialog(dialogIntent.current)
    })
    const retire = () => { alive.current = false; ++dialogIntent.current; projectOff(); window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])

  const canAddSource = plugins.length > 0

  useEffect(() => {
    void fetchSources()
  }, [fetchSources])

  useEffect(() => {
    const host = getDesktopHost()
    let disposed = false, revision = 0, loadedGeneration = -1
    const load = async () => {
      const scope = captureDesktopRead(), generation = host.connectionGeneration ?? 0
      if (!scope.isCurrent() || generation === loadedGeneration) return
      loadedGeneration = generation
      const request = ++revision
      try {
        const plugins = await pluginApi.list()
        if (!disposed && alive.current && request === revision && scope.isCurrent()) setPlugins(plugins)
      } catch {
        if (!disposed && alive.current && request === revision && scope.isCurrent()) setPlugins([])
      }
    }
    void load()
    const off = host.kind === 'tauri' ? host.subscribeConnection(() => { if (host.connection.status === 'ready') void load() }) : undefined
    const retire = () => { disposed = true; ++revision; off?.(); window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [])

  useEffect(() => {
    if (nativeDesktop) return
    const scope = captureDesktopRead()
    let disposed = false
    void (async () => {
      const statuses = new Map<string, boolean>()
      for (const source of sources) {
        if (disposed || !alive.current || !scope.isCurrent()) return
        const plugin = plugins.find(p => p.id === source.plugin_id)
        if (plugin?.id === 'linear' || plugin?.id === 'hubspot' && source.config.auth_type === 'oauth') {
          try { statuses.set(source.id, !!await desktopApi.oauth.getValidToken(source.id)) }
          catch { /* Failed status is unknown. */ }
        }
      }
      if (!disposed && alive.current && scope.isCurrent()) setOauthStatus(statuses)
    })()
    return () => { disposed = true }
  }, [sources, plugins, nativeDesktop])

  const captureDialog = () => {
    const scope = captureDesktopRead(), intent = tsDialog.intent, projectId = tsDialog.projectId
    return () => alive.current && dialogIntent.current === intent && getCurrentProjectId() === projectId && scope.isCurrent()
  }
  const handleCreateSource = async (data: CreateTaskSourceDTO) => {
    const current = captureDialog()
    if (!current()) return false
    const saved = await createSource({ ...data, project_id: tsDialog.projectId })
    return !!saved && current()
  }

  const handleUpdateSource = async (data: CreateTaskSourceDTO) => {
    const current = captureDialog(), source = tsDialog.source
    if (!source || !isInProject(source, tsDialog.projectId) || !current()) return false
    const saved = await updateSource(source.id, { name: data.name, plugin_id: data.plugin_id, config: data.config })
    return !!saved && current()
  }

  const handleDeleteSource = async (id: string) => {
    if (confirm('Delete this task source? Imported tasks will remain but lose their source link.')) {
      await deleteSource(id)
    }
  }

  const handleSyncSource = async (sourceId: string) => {
    // The store owns the exact sync receipt and canonical readback.
    await syncSource(sourceId)
  }

  return (
    <>
      <SettingsSection
        title="Task Sources"
        description={`Connect external task management systems to import and sync tasks into ${projectLabel}. Synced tasks land in the project their source belongs to.`}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {sources.length} source{sources.length !== 1 ? 's' : ''} in {projectLabel}
          </p>
          {canAddSource && (
            <Button size="sm" onClick={() => openDialog()}>
              <Plus className="h-3.5 w-3.5" />
              Add Source
            </Button>
          )}
        </div>

        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <p className="text-sm text-muted-foreground mb-3">
              {!canAddSource
                ? 'No plugins available. This is unusual - please restart the app.'
                : `No task sources in ${projectLabel} yet`}
            </p>
            {canAddSource && (
              <Button size="sm" onClick={() => openDialog()}>
                <Plus className="h-3.5 w-3.5" />
                Add Your First Source
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const plugin = plugins.find((p) => p.id === source.plugin_id)
              const requiresOAuth = plugin?.id === 'linear' || (plugin?.id === 'hubspot' && source.config.auth_type === 'oauth')
              const oauthConnected = requiresOAuth ? (nativeDesktop ? undefined : oauthStatus.get(source.id)) : true
              const isConnected = source.enabled && (!requiresOAuth || oauthConnected)

              return (
                <div key={source.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      isConnected ? 'bg-primary' : 'bg-muted/50'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{source.name}</span>
                        <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                          {plugin?.displayName ?? source.plugin_id}
                        </span>
                        {requiresOAuth && (
                          <span className="flex items-center gap-1 text-[10px]">
                            {nativeDesktop ? <span className="text-muted-foreground">OAuth sign-in unavailable</span> : oauthConnected === undefined ? <span className="text-muted-foreground">OAuth status unknown</span> : oauthConnected ? (
                              <>
                                <CheckCircle className="h-3 w-3 text-primary" />
                                <span className="text-primary">OAuth Connected</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="h-3 w-3 text-destructive" />
                                <span className="text-destructive">OAuth Required</span>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {source.last_synced_at && (
                          <span className="text-foreground/60">
                            Synced {new Date(source.last_synced_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleSyncSource(source.id)}
                        disabled={syncingIds.has(source.id)}
                        title="Sync now"
                      >
                        {syncingIds.has(source.id) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openDialog(source)}
                        title="Edit"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteSource(source.id)}
                        className="text-destructive hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {error && <p role="alert" className="text-xs text-destructive">Source operation could not be confirmed. Review the current source before retrying.</p>}
      <TaskSourceFormDialog
        key={tsDialog.intent}
        source={tsDialog.source}
        plugins={plugins}
        open={tsDialog.open}
        onClose={() => closeDialog(tsDialog.intent)}
        onSubmit={tsDialog.source ? handleUpdateSource : handleCreateSource}
      />
    </>
  )
}
