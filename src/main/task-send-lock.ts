const pendingSends = new WeakMap<object, Map<string, Promise<void>>>()

/** All adapter sends to one task, including startup and worker nudges, share this lock. */
export async function serializeTaskSend(owner: object, taskId: string, send: () => Promise<void>): Promise<void> {
  let queue = pendingSends.get(owner)
  if (!queue) { queue = new Map(); pendingSends.set(owner, queue) }
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
