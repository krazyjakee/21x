import type { DatabaseManager, TaskRecord } from '../database'
import type { SourceLifecycleOwner } from '../sync-manager'
import { TaskStatus } from '../../shared/constants'
import {
  CONNECTOR_BRIDGE_PLUGIN_ID,
  ConnectorBridgeEngine,
  ConnectorBridgeClosedError,
  DEFAULT_POLL_INTERVAL_MINUTES,
  type BridgeEngineOptions,
  type BridgeRuntime
} from '../connectors/bridge/engine'
import { CONNECTOR_TASK_MAPPINGS } from '../connectors/bridge/mappings'
import { BridgeScheduler } from '../connectors/bridge/scheduler'
import {
  PluginActionId,
  type ActionResult,
  type ConfigFieldOption,
  type PluginAction,
  type PluginConfigSchema,
  type PluginContext,
  type PluginSyncResult,
  type TaskSourcePlugin
} from './types'

/**
 * Task source backed by an embedded, allowlisted connector piece (issue #13).
 *
 * All provider logic lives in the piece plus a declarative mapping
 * (src/main/connectors/bridge/mappings.ts); this plugin only adapts the
 * connector-bridge engine to the TaskSourcePlugin contract. Pieces are never
 * reachable from coding agents: nothing here is exposed through MCP or the
 * task API.
 *
 * Config: `piece_name`, `connector_instance_id` (created by the config form
 * via the `connectors:*` IPC), `props` (the mapping's config props) and
 * `poll_interval_minutes` (0 = manual only).
 */

export interface ConnectorBridgeCoreOptions {
  /** The portable service owner must supply its runtime explicitly. */
  runtime: (db: DatabaseManager) => BridgeRuntime
  engine?: Omit<BridgeEngineOptions, 'runtime'>
}

export interface BridgePollingOptions {
  db: DatabaseManager
  /** Called after each scheduled sync (e.g. to refresh the renderer). */
  onSynced?: (sourceId: string, result: PluginSyncResult) => Promise<void> | void
  tickMs?: number
}

export class ConnectorBridgeCore implements TaskSourcePlugin {
  id = CONNECTOR_BRIDGE_PLUGIN_ID
  displayName = 'Connector (embedded piece)'
  description = 'Import tasks from an allowlisted connector piece such as Trello'
  icon = 'Plug'

  private readonly engines = new WeakMap<DatabaseManager, ConnectorBridgeEngine>()
  private readonly ownedEngines = new Set<ConnectorBridgeEngine>()
  private readonly ownedSchedulers = new Set<BridgeScheduler>()
  private scheduler: BridgeScheduler | null = null
  private closing = false
  private sourceLifecycle: SourceLifecycleOwner | null = null

  constructor(private readonly options: ConnectorBridgeCoreOptions) {}

  /** Install before polling starts. Scheduled work shares source mutation
   * admission/drain with manual import/export while retaining manual:false. */
  bindSourceLifecycle(owner: SourceLifecycleOwner): void {
    if (this.sourceLifecycle === owner) return
    // Legacy Electron startup installs the timer immediately before the sync
    // owner in the same call stack. Its deferred first pass can still bind;
    // an already accepted engine job cannot be retroactively claimed.
    if (this.sourceLifecycle || this.closing || [...this.ownedEngines].some(engine => engine.store.listInstances().some(instance => engine.isBusy(instance.id)))) throw new Error('Connector source lifecycle owner is unavailable')
    this.sourceLifecycle = owner
  }

  assertSourceLifecycle(owner: SourceLifecycleOwner): void {
    if (this.sourceLifecycle !== owner) throw new Error('Connector source lifecycle owner does not match')
  }

  engineFor(db: DatabaseManager): ConnectorBridgeEngine {
    if (this.closing) throw new ConnectorBridgeClosedError()
    let engine = this.engines.get(db)
    if (!engine) {
      const runtime = this.options.runtime(db)
      engine = new ConnectorBridgeEngine({ ...this.options.engine, runtime })
      this.engines.set(db, engine)
      this.ownedEngines.add(engine)
    }
    return engine
  }

  getConfigSchema(): PluginConfigSchema {
    return [
      {
        key: 'piece_name',
        label: 'Connector',
        type: 'select',
        required: true,
        options: pieceOptions()
      },
      {
        key: 'poll_interval_minutes',
        label: 'Sync every (minutes)',
        type: 'number',
        default: DEFAULT_POLL_INTERVAL_MINUTES,
        description: '0 syncs only when you ask'
      }
    ]
  }

  async resolveOptions(resolverKey: string): Promise<ConfigFieldOption[]> {
    if (resolverKey === 'pieces') return pieceOptions()
    return []
  }

  getActions(): PluginAction[] {
    // Completion goes through executeAction(PluginActionId.Complete).
    return []
  }

  importTasks(sourceId: string, config: Record<string, unknown>, ctx: PluginContext): Promise<PluginSyncResult> {
    return this.engineFor(ctx.db).sync(sourceId, config, ctx, { manual: true })
  }

  async exportUpdate(
    task: TaskRecord,
    changedFields: Record<string, unknown>,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<void> {
    const result = await this.engineFor(ctx.db).pushUpdate(task, changedFields, config, { queueOnFailure: true })
    if (!result.ok && !result.skipped) {
      // Already redacted by the engine.
      console.warn(`[connector-bridge] Update for task ${task.id} ${result.queued ? 'queued for retry' : 'failed'}: ${result.error}`)
    }
  }

  async executeAction(
    actionId: string,
    task: TaskRecord,
    _input: string | undefined,
    config: Record<string, unknown>,
    ctx: PluginContext
  ): Promise<ActionResult> {
    if (actionId !== PluginActionId.Complete) return { success: false, error: `Unknown action: ${actionId}` }
    const result = await this.engineFor(ctx.db).pushUpdate(task, { status: TaskStatus.Completed }, config, { queueOnFailure: false })
    if (result.ok && !result.skipped) return { success: true, taskUpdate: { status: TaskStatus.Completed } }
    return { success: false, error: result.error ?? 'This connector cannot complete items at the source' }
  }

  /** Starts interval polling and retry scheduling for every bridge source. */
  startPolling({ db, onSynced, tickMs }: BridgePollingOptions): void {
    if (this.closing) throw new ConnectorBridgeClosedError()
    if (this.scheduler) return
    const engine = this.engineFor(db)
    this.scheduler = new BridgeScheduler({
      db,
      store: engine.store,
      isBusy: (id) => engine.isBusy(id),
      tickMs,
      runSource: async (sourceId) => {
        const run = async (): Promise<void> => {
          const source = db.getTaskSource(sourceId)
          if (!source) return
          const result = await engine.sync(sourceId, { ...source.config }, { db, sourceId }, { manual: false })
          if (result.errors.length === 0) db.updateTaskSourceLastSynced(sourceId)
          await onSynced?.(sourceId, result)
        }
        if (this.sourceLifecycle) await this.sourceLifecycle.runSourceWork(sourceId, run)
        else await run()
      }
    })
    this.ownedSchedulers.add(this.scheduler)
    this.scheduler.start()
  }

  stopPolling(): void {
    this.scheduler?.stop()
    this.scheduler = null
  }

  /** Join active and previously paused polling callbacks and all bridge jobs. */
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Connector plugin shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.closing = true
    const results = await Promise.allSettled([
      ...[...this.ownedSchedulers].map(scheduler => scheduler.close(timeoutMs)),
      ...[...this.ownedEngines].map(engine => engine.close(timeoutMs))
    ])
    const incomplete = results.find(result => result.status === 'rejected')
    if (incomplete?.status === 'rejected') throw incomplete.reason
    this.ownedSchedulers.clear()
    this.ownedEngines.clear()
    this.scheduler = null
  }

  getSetupDocumentation(): string {
    const pieces = Object.values(CONNECTOR_TASK_MAPPINGS)
      .map((m) => `- **${m.label}**: ${m.auth.help ?? ''}`)
      .join('\n')
    return `# Connector task source

Imports tasks through an embedded, allowlisted connector piece. Only the piece
actions named in its task mapping can run; nothing else from the piece is
reachable, and coding agents never see the connection.

## Available connectors

${pieces}

## Setup

1. Choose the connector and enter its credentials, or for an OAuth connector
   (Todoist) paste your own app's client id and secret and click Connect to
   sign in through the browser. Everything is encrypted with the OS keychain;
   if the keychain is unavailable you can keep it for this session only.
2. Fill in the connector settings (for Trello, the board id; for Todoist, a
   filter such as \`#Work | overdue\`).
3. Pick how often to sync (0 = only when you click Sync).

Title, due date and completion made in 21x are written back to the source.
Items that keep failing are set aside as dead letters; the sync result lists
every per-item error, and a failed sync never removes existing tasks.
`
  }
}

function pieceOptions(): ConfigFieldOption[] {
  return Object.values(CONNECTOR_TASK_MAPPINGS).map((m) => ({ value: m.pieceName, label: m.label }))
}
