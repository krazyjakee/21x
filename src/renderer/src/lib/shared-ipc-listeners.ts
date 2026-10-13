/**
 * Shared IPC Listener Bus
 *
 * Solves the MaxListenersExceededWarning that occurs when many canvas panels
 * are open — each panel's component tree (TaskWorkspace, WorktreeProgressOverlay,
 * GhCliSetupDialog, HeartbeatSection, etc.) independently registers IPC listeners
 * on the same channels. With 11+ panels, individual channels exceed Node's
 * default limit of 10 listeners.
 *
 * This module registers a SINGLE ipcRenderer.on() listener per channel and
 * fans out events to multiple subscribers via a lightweight pub/sub pattern.
 * Components call subscribe() which returns an unsubscribe function — the
 * same API as the existing on*() helpers in ipc-client.ts.
 */

type Callback<T = unknown> = (data: T) => void

// Per-channel subscriber sets and IPC unsubscribe functions
const subscribers = new Map<string, Set<Callback>>()
const ipcCleanups = new Map<string, () => void>()

/**
 * Ensure a single IPC listener exists for the given channel.
 * The first subscriber triggers registration; removal of the last
 * subscriber tears it down (though in practice channels stay active
 * for the app lifetime).
 */
function ensureListener(
  channel: string,
  registrar: (cb: Callback) => (() => void) | undefined
): void {
  if (ipcCleanups.has(channel)) return

  const handler: Callback = (data) => {
    const subs = subscribers.get(channel)
    if (subs) {
      for (const cb of subs) {
        try {
          cb(data)
        } catch (err) {
          console.error(`[shared-ipc] Error in ${channel} subscriber:`, err)
        }
      }
    }
  }

  const cleanup = registrar(handler)
  if (cleanup) ipcCleanups.set(channel, cleanup)
}

/**
 * Subscribe to a shared IPC channel. Returns an unsubscribe function.
 *
 * @param channel  Unique key for this event type (used for dedup)
 * @param registrar  Function that registers the IPC listener (called once per channel)
 * @param callback  Per-component callback
 */
export function subscribe<T>(
  channel: string,
  registrar: (cb: Callback<T>) => (() => void) | undefined,
  callback: Callback<T>
): () => void {
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set())
  }

  const subs = subscribers.get(channel)!
  // Identical callbacks retained by two views still own separate leases.
  const registered: Callback = data => callback(data as T)
  subs.add(registered)

  // Register the single IPC listener on first subscriber
  try { ensureListener(channel, registrar as (cb: Callback) => (() => void) | undefined) }
  catch (error) { subs.delete(registered); if (!subs.size) subscribers.delete(channel); throw error }

  // Return unsubscribe
  let released = false
  return () => {
    if (released) return
    released = true
    subs.delete(registered)
    if (!subs.size && subscribers.get(channel) === subs) {
      subscribers.delete(channel)
      const cleanup = ipcCleanups.get(channel)
      ipcCleanups.delete(channel)
      cleanup?.()
    }
  }
}
