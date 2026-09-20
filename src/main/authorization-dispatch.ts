import type Database from 'better-sqlite3'
import { setTimeout as sleep } from 'timers/promises'
import { activateAuthorizationDispatch } from './authorization'

const pendingSends = new WeakMap<Database.Database, Map<string, Promise<void>>>()

/** A task-scoped MCP URL cannot distinguish two overlapping backend turns.
 * Keep the binding empty until the backend confirms the old turn is idle.
 * Call sendPrompt synchronously in the idle continuation so another awaiting
 * sender cannot enter between activation and adapter acceptance.
 */
export async function sendWithAuthorization(
  source: { db: Database.Database },
  seq: number,
  status: () => Promise<{ type: string }>,
  send: () => Promise<void>,
  wait: () => Promise<unknown> = () => sleep(100),
  timeoutMs = 60_000
): Promise<void> {
  const row = source.db.prepare('SELECT task_id, node_id FROM authorization_dispatches WHERE seq = ?').get(seq) as { task_id: string; node_id: string | null } | undefined
  if (!row) throw new Error('Unknown authorization dispatch')
  let queue = pendingSends.get(source.db)
  if (!queue) { queue = new Map(); pendingSends.set(source.db, queue) }
  const prior = queue.get(row.task_id)
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  queue.set(row.task_id, settled)
  try {
    if (prior) await prior
    if (!row.node_id) {
      activateAuthorizationDispatch(source, seq)
      await send()
      return
    }
    await waitAndSend()
  } finally {
    release()
    if (queue.get(row.task_id) === settled) queue.delete(row.task_id)
  }

  async function waitAndSend(): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const current = await status()
      if (current.type === 'idle') {
        // Rechecks generation, expiry and revocation AFTER every await.
        activateAuthorizationDispatch(source, seq)
        return send()
      }
      if (current.type !== 'busy' && current.type !== 'retry') throw new Error(`Cannot authorize a turn while the backend is ${current.type}`)
      if (Date.now() >= deadline) throw new Error('The previous turn did not become idle; authorization remains inactive. Retry delivery when idle.')
      await wait()
    }
  }
}
