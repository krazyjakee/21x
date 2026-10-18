import { useState, useEffect, useRef } from 'react'
import { captureDesktopRead, getDesktopHost } from '@/lib/desktop-api'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { getPluginForm } from '@/components/plugins'
import { PluginSetupDocumentation } from '@/components/plugins/PluginSetupDocumentation'
import { pluginApi } from '@/lib/ipc-client'
import type { TaskSource, CreateTaskSourceDTO, PluginMeta } from '@/types'

interface TaskSourceFormDialogProps {
  source?: TaskSource
  plugins: PluginMeta[]
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateTaskSourceDTO) => Promise<boolean>
}

export function TaskSourceFormDialog({
  source,
  plugins,
  open,
  onClose,
  onSubmit
}: TaskSourceFormDialogProps) {
  const [name, setName] = useState(source?.name ?? '')
  const [pluginId, setPluginId] = useState(source?.plugin_id ?? (plugins[0]?.id ?? ''))
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>(source?.config ?? {})
  const [documentation, setDocumentation] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const busy = useRef(false)
  const active = useRef(false)
  const lifetime = useRef(0)

  useEffect(() => {
    ++lifetime.current
    active.current = open
    const retire = () => { active.current = false; ++lifetime.current }
    window.addEventListener('pagehide', retire, { once: true })
    if (open) {
      busy.current = false
      setSaving(false)
      setReviewRequired(false)
      setName(source?.name ?? '')
      setPluginId(source?.plugin_id ?? (plugins[0]?.id ?? ''))
      setPluginConfig(source?.config ?? {})
    }
    return () => { retire(); window.removeEventListener('pagehide', retire) }
  }, [open, source?.id])

  // Read documentation for the exact displayed plugin and connection only.
  useEffect(() => {
    const host = getDesktopHost(), generation = lifetime.current
    let disposed = false, request = 0, loadedGeneration = -1
    const load = async () => {
      const scope = captureDesktopRead(), connection = host.connectionGeneration ?? 0
      if (!pluginId || !open || !active.current || !scope.isCurrent() || connection === loadedGeneration) return
      loadedGeneration = connection
      const revision = ++request
      const valid = () => !disposed && active.current && generation === lifetime.current && revision === request && scope.isCurrent()
      setDocumentation(null)
      try {
        const value = await pluginApi.getDocumentation(pluginId)
        if (valid()) setDocumentation(value)
      } catch { if (valid()) setDocumentation(null) }
    }
    void load()
    const off = host.kind === 'tauri' ? host.subscribeConnection(() => { if (host.connection.status === 'ready') void load() }) : undefined
    const retire = () => { disposed = true; ++request; off?.(); window.removeEventListener('pagehide', retire) }
    window.addEventListener('pagehide', retire, { once: true })
    return retire
  }, [pluginId, open, source?.id])

  const selectedPlugin = plugins.find((p) => p.id === pluginId)
  const isValid = name.trim() && pluginId

  const buildData = (): CreateTaskSourceDTO => ({
    mcp_server_id: null,
    name: name.trim(),
    plugin_id: pluginId,
    config: pluginConfig
  })

  const save = async (): Promise<boolean> => {
    if (!isValid || busy.current || reviewRequired || !active.current) return false
    const generation = lifetime.current, scope = captureDesktopRead()
    if (!scope.isCurrent()) return false
    const viewCurrent = () => active.current && generation === lifetime.current
    busy.current = true
    setSaving(true)
    try {
      const accepted = await onSubmit(buildData())
      if (accepted && viewCurrent() && scope.isCurrent()) { onClose(); return true }
    } catch { /* An absent receipt does not establish whether Source wrote. */ }
    finally {
      if (viewCurrent()) { busy.current = false; setSaving(false) }
    }
    if (viewCurrent()) setReviewRequired(true)
    return false
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void save()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{source ? 'Edit Task Source' : 'New Task Source'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            {/* Left Column - Form */}
            <div className="p-6 border-r border-border">
              <form onSubmit={handleSubmit} className="space-y-3">
                <fieldset disabled={saving || reviewRequired} className="space-y-3 border-0 p-0 m-0 min-w-0">
                <div className="space-y-1.5">
                  <Label htmlFor="ts-plugin">Plugin</Label>
                  <select
                    id="ts-plugin"
                    value={pluginId}
                    onChange={(e) => {
                      setPluginId(e.target.value)
                      setPluginConfig({})
                    }}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                  >
                    {plugins.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                  {selectedPlugin?.description && (
                    <p className="text-xs text-muted-foreground">{selectedPlugin.description}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ts-name">Name</Label>
                  <Input
                    id="ts-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={selectedPlugin?.displayName ?? 'My Source'}
                    required
                  />
                </div>

                {selectedPlugin && (() => {
                  const PluginForm = getPluginForm(selectedPlugin.id)
                  if (!PluginForm) {
                    return (
                      <div className="text-sm text-muted-foreground py-4">
                        No configuration form available for this plugin.
                      </div>
                    )
                  }

                  return (
                    <PluginForm
                      value={pluginConfig}
                      onChange={setPluginConfig}
                      sourceId={source?.id}
                      onRequestSave={() => {
                        // Auto-save source before OAuth when creating new source
                        if (!source && isValid && !busy.current && !reviewRequired && active.current) {
                          void save()
                          return true
                        }
                        return false
                      }}
                    />
                  )
                })()}

                </fieldset>
                {reviewRequired && <p role="alert" className="text-xs text-destructive">Save could not be confirmed. Close this draft and review the source list before saving again.</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="outline" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!isValid || saving || reviewRequired}>
                    {saving ? 'Saving...' : source ? 'Save' : 'Add'}
                  </Button>
                </div>
              </form>
            </div>

            {/* Right Column - Documentation */}
            <div className="p-6 bg-muted/30 overflow-y-auto max-h-[70vh]">
              {documentation ? (
                <PluginSetupDocumentation markdown={documentation} />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  No documentation available for this plugin.
                </div>
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
