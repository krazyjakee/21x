import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { OpencodeAdapter } from '../main/adapters/opencode-adapter'
import { ClaudeCodeAdapter } from '../main/adapters/claude-code-adapter'
import { CodexAppServerAdapter } from '../main/adapters/codex-app-server-adapter'
import { AcpAdapter } from '../main/adapters/acp-adapter'
import { PiAdapter } from '../main/adapters/pi-adapter'
import { proveAgentBackend } from './agent-backend-proof'

export async function runLiveBackendProof(backend: string, model: string, root: string) {
  if (process.env.TWENTYX_LIVE_BACKEND_PROOF !== 'explicit-live' || process.versions.electron) throw new Error('LIVE_PROOF_NOT_AUTHORIZED')
  const factories = { opencode: () => new OpencodeAdapter(), 'claude-code': () => new ClaudeCodeAdapter(),
    codex: () => new CodexAppServerAdapter(), cursor: () => new AcpAdapter('cursor'), pi: () => new PiAdapter() }
  if (!Object.hasOwn(factories, backend)) throw new Error('LIVE_PROOF_UNKNOWN_BACKEND')
  const adapter = factories[backend as keyof typeof factories]()
  const cancellation = new AbortController()
  const stop = () => cancellation.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  // No provider logs, prompts, session IDs, account names or stderr in evidence.
  const methods = ['log', 'info', 'debug', 'warn', 'error'] as const
  const original = methods.map(method => console[method])
  for (const method of methods) console[method] = () => {}
  const workspaceDir = join(root, 'workspace'); mkdirSync(workspaceDir, { recursive: true })
  let serverUrl: string | undefined
  try {
    if (backend === 'opencode') {
      const listener = createServer()
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('LIVE_PROOF_PORT_UNAVAILABLE')
      serverUrl = `http://127.0.0.1:${address.port}`
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    }
    return await proveAgentBackend(adapter, { agentId: 'synthetic-live-proof-agent', taskId: 'synthetic-live-proof-task', workspaceDir,
      model, serverUrl, authMethod: 'subscription', permissionMode: 'ask', sandboxMode: 'read-only', mcpServers: {} }, cancellation.signal)
  } finally {
    try { if (adapter instanceof OpencodeAdapter) await adapter.stopServer() }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); methods.forEach((method, index) => { console[method] = original[index] }) }
  }
}
