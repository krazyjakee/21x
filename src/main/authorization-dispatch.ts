import type Database from 'better-sqlite3'
import { setTimeout as sleep } from 'timers/promises'
import { activateAuthorizationDispatch, failAuthorizationDispatch } from './authorization'

type Source = { db: Database.Database }
type Snapshot = { dispatch_seq: number; node_id: string | null } | null
const pendingSends = new WeakMap<Database.Database, Map<string, Promise<void>>>()

/** All adapter sends, including startup and worker nudges, share this lock. */
async function serializeTaskSend(source: Source, taskId: string, send: () => Promise<void>): Promise<void> {
  let queue = pendingSends.get(source.db)
  if (!queue) { queue = new Map(); pendingSends.set(source.db, queue) }
  const prior = queue.get(taskId)
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  queue.set(taskId, settled)
  try {
    if (prior) await prior
    await send()
  } finally {
    release()
    if (queue.get(taskId) === settled) queue.delete(taskId)
  }
}

/** Capture BEFORE async preparation, including the inactive/active state. */
export function captureAuthorizationSnapshot(source: Source, taskId: string): Snapshot {
  return source.db.prepare('SELECT dispatch_seq, node_id FROM authorization_task_bindings WHERE task_id = ?').get(taskId) as Snapshot | undefined ?? null
}

/** Continuations cannot borrow authority installed after they were prepared. */
export function sendPreservingAuthorization(source: Source, taskId: string, snapshot: Snapshot, send: () => Promise<void>): Promise<void> {
  return serializeTaskSend(source, taskId, async () => {
    const current = captureAuthorizationSnapshot(source, taskId)
    if (current?.dispatch_seq !== snapshot?.dispatch_seq || current?.node_id !== snapshot?.node_id) throw new Error('Stale authorization continuation')
    await send()
  })
}

/** A task-scoped MCP URL cannot distinguish overlapping backend turns.
 * Keep the binding empty until the backend confirms the old turn is idle.
 * The shared send lock covers idle observation through adapter acceptance.
 */
export async function sendWithAuthorization(
  source: Source,
  seq: number,
  status: () => Promise<{ type: string }>,
  send: () => Promise<void>,
  wait: () => Promise<unknown> = () => sleep(100),
  timeoutMs = 60_000
): Promise<void> {
  const row = source.db.prepare('SELECT task_id, node_id FROM authorization_dispatches WHERE seq = ?').get(seq) as { task_id: string; node_id: string | null } | undefined
  if (!row) throw new Error('Unknown authorization dispatch')
  return serializeTaskSend(source, row.task_id, async () => {
    try {
      if (!row.node_id) {
        activateAuthorizationDispatch(source, seq)
        await send()
        return
      }
      const deadline = Date.now() + timeoutMs
      while (true) {
        const current = await status()
        if (current.type === 'idle') {
          // Rechecks generation, expiry and revocation AFTER every await.
          activateAuthorizationDispatch(source, seq)
          await send()
          return
        }
        if (current.type !== 'busy' && current.type !== 'retry') throw new Error(`Cannot authorize a turn while the backend is ${current.type}`)
        if (Date.now() >= deadline) throw new Error('The previous turn did not become idle; authorization remains inactive. Retry delivery when idle.')
        await wait()
      }
    } catch (error) {
      failAuthorizationDispatch(source, seq)
      throw error
    }
  })
}
