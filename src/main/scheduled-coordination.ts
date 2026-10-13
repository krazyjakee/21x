import type { AgentManager } from './agent-manager'
import type { DatabaseManager } from './database'
import { createChatProviderFromSettings } from './chat/provider-factory'
import { getCommanderService } from './ipc/commander'
import { ScheduledCoordination as ScheduledCoordinationCore, type ScheduledCoordinationOptions, type BriefingSpeech } from './scheduled-coordination-core'
export * from './scheduled-coordination-core'

/** Desktop defaults are supplied here; the core needs no Electron host. */
export class ScheduledCoordination extends ScheduledCoordinationCore {
  constructor(options: ScheduledCoordinationOptions) {
    super({ ...options, notify: options.notify ?? defaultNotify })
  }
}

function defaultNotify(title: string, body: string): Promise<void> {
  return import('electron')
    .then(({ Notification }) => {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    })
    .catch((error) => console.error('[ScheduledCoordination] OS notification failed:', error))
}

// ── Wiring ────────────────────────────────────────────────────

export interface StartScheduledCoordinationDeps {
  db: DatabaseManager
  agents: AgentManager
  /** The voice session manager, once it exists; null when voice is unavailable. */
  getVoice?: () => { speech: BriefingSpeech } | null
  /** True when a window is open to play audio in. */
  canPlayAudio?: () => boolean
}

let running: ScheduledCoordination | null = null
let runningSource: DatabaseManager | null = null
const retired = new Set<{ source: DatabaseManager; owner: ScheduledCoordination }>()
const closedSources = new WeakSet<DatabaseManager>()

/**
 * Starts the scheduler with the app's services (src/main/index.ts). The
 * Commander service and chat provider are looked up on use: the Commander
 * handlers register after this runs.
 */
export function startScheduledCoordination(deps: StartScheduledCoordinationDeps): ScheduledCoordination {
  if (closedSources.has(deps.db)) throw new Error('SCHEDULED_COORDINATION_CLOSED')
  if (running) {
    if (runningSource !== deps.db) throw new Error('SCHEDULED_COORDINATION_ALREADY_RUNNING')
    running.start()
    return running
  }
  if (retired.size) throw new Error('SCHEDULED_COORDINATION_SHUTDOWN_INCOMPLETE')
  const scheduler = new ScheduledCoordination({
    db: deps.db,
    agents: deps.agents,
    getCommander: () => getCommanderService(),
    createProvider: () => createChatProviderFromSettings(deps.db),
    getSpeech: () => deps.getVoice?.()?.speech ?? null,
    canPlayAudio: deps.canPlayAudio
  })
  scheduler.start()
  running = scheduler
  runningSource = deps.db
  return scheduler
}

export function stopScheduledCoordination(): void {
  if (running && runningSource) {
    running.shutdown()
    retired.add({ source: runningSource, owner: running })
  }
  running = null
  runningSource = null
}

export async function closeScheduledCoordination(timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Scheduled coordination shutdown deadline must be an integer from 1 to 3000 ms')
  }
  stopScheduledCoordination()
  for (const entry of retired) closedSources.add(entry.source)
  const results = await Promise.allSettled([...retired].map(async entry => {
    await entry.owner.close(timeoutMs)
    retired.delete(entry)
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
