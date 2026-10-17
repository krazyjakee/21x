/** Synthetic provider only: real host loop/Node IPC, never a pinned provider API proof. */
import { startPieceHost } from '../../src/main/connectors/piece-host/host-runtime'
import type { HostInboundMessage } from '../../src/main/connectors/piece-host/protocol'

if (!process.send || !process.connected) process.exit(1)
process.on('SIGTERM', () => { /* Exercise the transport's forced retirement. */ })
process.once('disconnect', () => process.exit(0))

type Context = {
  propsValue: { mode?: string; cursor?: number; items?: boolean }
  auth?: { secret_text?: string }
  store: { get(key: string, scope?: string): Promise<unknown>; put(key: string, value: unknown, scope?: string): Promise<void>; delete(key: string, scope?: string): Promise<void> }
}

const hook = async (raw: unknown): Promise<unknown> => {
  const { store, propsValue, auth } = raw as Context
  const before = await store.get('cursor')
  await store.put('cursor', propsValue.cursor ?? 1)
  await store.put('project-marker', 'call-owned', 'PROJECT')
  await store.delete('deleted')
  const staged = await store.get('cursor')
  if (propsValue.mode === 'error') throw new Error('Synthetic failure ' + (auth?.secret_text ?? ''))
  if (propsValue.mode === 'crash') process.exit(71)
  if (propsValue.mode === 'hang') {
    process.send!({ fixtureCheckpoint: true })
    return new Promise(() => undefined)
  }
  if (propsValue.items) return { cards: [{ id: 'synthetic-item', name: 'Recovered item', closed: false }] }
  return { before, staged, hadCredential: typeof auth?.secret_text === 'string' }
}

startPieceHost({ postMessage: message => { if (process.connected) process.send!(message) },
  onMessage: handler => { process.on('message', message => handler(message as HostInboundMessage)) } },
  name => name === '@activepieces/piece-trello' ? { version: '0.6.0', module: {
    trello: { getAction: () => ({ run: hook }), getTrigger: () => ({ type: 'POLLING',
      onEnable: async (raw: unknown) => { await (raw as Context).store.put('cursor', 1); return null },
      onDisable: async () => null, run: hook }) }
  } } : undefined)
