import { useEffect, useState, type FormEvent } from 'react'
import { Server, Globe } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import { KeyValueEditor } from '../KeyValueEditor'
import { shellQuoteArg, parseShellArgs } from '../utils'
import {
  CLI_CAPABILITIES,
  CLI_IDS,
  CLI_LABELS,
  type CliId,
  type CliMcpUpsertRequest,
  type GlobalMcpServer,
  type McpServerDefinition
} from '@shared/cli-mcp-config'

interface GlobalMcpServerFormDialogProps {
  open: boolean
  /** When editing: the entry being edited (its CLI is the only target). */
  server?: GlobalMcpServer
  /** CLIs whose config could be read; the others cannot be targeted. */
  availableClis: CliId[]
  onClose: () => void
  onSubmit: (request: Omit<CliMcpUpsertRequest, 'expectedFingerprints'>) => Promise<void> | void
}

/**
 * Add or edit a global MCP server in one or more CLIs. Masked secret values
 * come in as the placeholder and go back unchanged, which tells the main
 * process to keep what is on disk.
 */
export function GlobalMcpServerFormDialog({ open, server, availableClis, onClose, onSubmit }: GlobalMcpServerFormDialogProps) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState<Record<string, string>>({})
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [targets, setTargets] = useState<CliId[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    const def = server?.definition
    setName(server?.name ?? '')
    setTransport(def?.transport === 'stdio' || !def ? 'stdio' : 'http')
    setCommand(def?.command ?? '')
    setArgs((def?.args ?? []).map(shellQuoteArg).join(' '))
    setEnv(def?.env ?? {})
    setUrl(def?.url ?? '')
    setHeaders(def?.headers ?? {})
    setTargets(server ? [server.cli] : availableClis.length === 1 ? [...availableClis] : [])
    setSubmitting(false)
  }, [open, server, availableClis])

  const toggleTarget = (cli: CliId, checked: boolean): void => {
    setTargets((prev) => (checked ? [...new Set([...prev, cli])] : prev.filter((entry) => entry !== cli)))
  }

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (targets.length === 0 || submitting) return
    const definition: McpServerDefinition = transport === 'stdio'
      ? { transport: 'stdio', command: command.trim(), args: parseShellArgs(args), env: stripEmptyKeys(env) }
      : { transport: server?.definition.transport === 'sse' ? 'sse' : 'http', url: url.trim(), headers: stripEmptyKeys(headers) }
    setSubmitting(true)
    try {
      await onSubmit({
        targets,
        name: name.trim(),
        previousName: server && server.name !== name.trim() ? server.name : undefined,
        definition
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${CLI_LABELS[server.cli]} MCP Server` : 'New Global MCP Server'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cli-mcp-name">Name</Label>
              <Input
                id="cli-mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex gap-1">
                <Button type="button" size="sm" variant={transport === 'stdio' ? 'default' : 'outline'} onClick={() => setTransport('stdio')} className="flex-1">
                  <Server className="h-3.5 w-3.5 mr-1.5" /> Local (stdio)
                </Button>
                <Button type="button" size="sm" variant={transport === 'http' ? 'default' : 'outline'} onClick={() => setTransport('http')} className="flex-1">
                  <Globe className="h-3.5 w-3.5 mr-1.5" /> Remote (HTTP)
                </Button>
              </div>
            </div>

            {transport === 'stdio' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="cli-mcp-command">Command</Label>
                  <Input id="cli-mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cli-mcp-args">Arguments</Label>
                  <Input id="cli-mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
                </div>
                <KeyValueEditor label="Environment Variables" value={env} onChange={setEnv} keyPlaceholder="VAR_NAME" valuePlaceholder="value or ${VAR}" />
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="cli-mcp-url">URL</Label>
                  <Input id="cli-mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" required />
                </div>
                <KeyValueEditor label="Headers" value={headers} onChange={setHeaders} keyPlaceholder="Header-Name" valuePlaceholder="value or Bearer ${VAR}" />
              </>
            )}

            <p className="text-[11px] text-muted-foreground">
              Values that look like secrets are never written as plaintext: 20x stores a reference to an environment
              variable instead and tells you which one to export. Masked values are kept as they are on disk.
            </p>

            {!server && (
              <div className="space-y-1.5">
                <Label>Write to</Label>
                <div className="flex flex-wrap gap-3">
                  {CLI_IDS.map((cli) => {
                    const available = availableClis.includes(cli)
                    return (
                      <label key={cli} className={`flex items-center gap-2 text-sm ${available ? '' : 'opacity-50'}`} title={available ? CLI_CAPABILITIES[cli].envReferenceSyntax : 'Config could not be read'}>
                        <Checkbox
                          checked={targets.includes(cli)}
                          disabled={!available}
                          onCheckedChange={(checked) => toggleTarget(cli, checked === true)}
                        />
                        {CLI_LABELS[cli]}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm" disabled={targets.length === 0 || submitting}>
                {server ? 'Save' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function stripEmptyKeys(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key.trim()) out[key.trim()] = value
  }
  return out
}
