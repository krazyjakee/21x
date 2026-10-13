const pendingSends = new WeakMap<object, Map<string, Promise<void>>>()

/** All adapter sends to one task, including startup and worker nudges, share this lock. */
export async function serializeTaskSend<T>(owner: object, taskId: string, send: () => Promise<T>): Promise<T> {
  let queue = pendingSends.get(owner)
  if (!queue) { queue = new Map(); pendingSends.set(owner, queue) }
  const prior = queue.get(taskId)
  let release!: () => void
  const settled = new Promise<void>(resolve => { release = resolve })
  queue.set(taskId, settled)
  try {
    if (prior) await prior
    return await send()
  } finally {
    release()
    if (queue.get(taskId) === settled) queue.delete(taskId)
  }
}
