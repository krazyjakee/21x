import { UnsupportedPieceContext } from './errors'
import type { PieceInvocation, PieceStoreScope } from './protocol'

/**
 * The subset of the Activepieces action / polling-trigger context that 21x
 * provides (issue #12). Built inside the piece host for a single call.
 *
 * Supported: `auth` (resolved per call by the main process), `propsValue`,
 * `store` (proxied to the main-process KV backend, scoped to the instance),
 * `step.name`, a minimal `project` stub and `executionType: 'BEGIN'`.
 *
 * Everything else a piece can reach — flows, connections lookup, webhook URLs,
 * server API URL/token, platform files, tags, output updates, agent tools,
 * stop/pause/respond/waitpoints, setSchedule, app listeners — throws
 * UnsupportedPieceContext. The throw is also recorded, so a piece that catches
 * it still fails the call: unsupported use is never a silent no-op.
 *
 * Throwing accessors are non-enumerable so destructuring or spreading the
 * context (as pieces-common's polling helper does) does not trip them; only
 * actually reading or calling the feature does.
 */

/** Structural view of the framework's Piece / IAction / ITrigger that the host relies on. */
export interface HostedAction {
  run(ctx: unknown): Promise<unknown>
}

export interface HostedTrigger {
  type?: string
  onEnable(ctx: unknown): Promise<unknown>
  onDisable(ctx: unknown): Promise<unknown>
  run(ctx: unknown): Promise<unknown>
  test?(ctx: unknown): Promise<unknown>
}

export interface HostedPiece {
  getAction(name: string): HostedAction | undefined
  getTrigger(name: string): HostedTrigger | undefined
}

export function isHostedPiece(value: unknown): value is HostedPiece {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as HostedPiece).getAction === 'function' &&
    typeof (value as HostedPiece).getTrigger === 'function'
  )
}

/** Host-side handle to the main-process KV backend, already bound to the call's instance. */
export interface PieceStoreChannel {
  get(scope: PieceStoreScope, key: string): Promise<unknown>
  put(scope: PieceStoreScope, key: string, value: unknown): Promise<void>
  delete(scope: PieceStoreScope, key: string): Promise<void>
}

/** Collects unsupported-context use so a swallowed throw still fails the call. */
export class UnsupportedUseRecorder {
  first: UnsupportedPieceContext | null = null

  fail(feature: string): never {
    const err = new UnsupportedPieceContext(feature)
    if (!this.first) this.first = err
    throw err
  }
}

/** Activepieces StoreScope values: PROJECT = 'COLLECTION', FLOW = 'FLOW' (the default). */
function mapStoreScope(scope: unknown, recorder: UnsupportedUseRecorder): PieceStoreScope {
  if (scope === undefined || scope === null || scope === 'FLOW') return 'flow'
  if (scope === 'COLLECTION' || scope === 'PROJECT') return 'project'
  return recorder.fail(`store scope ${String(scope)}`)
}

function assertKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('context.store keys must be non-empty strings')
  return key
}

export function createStoreShim(channel: PieceStoreChannel, recorder: UnsupportedUseRecorder): Record<string, unknown> {
  return {
    async put(key: unknown, value: unknown, scope?: unknown): Promise<unknown> {
      await channel.put(mapStoreScope(scope, recorder), assertKey(key), value === undefined ? null : value)
      return value
    },
    async get(key: unknown, scope?: unknown): Promise<unknown> {
      const value = await channel.get(mapStoreScope(scope, recorder), assertKey(key))
      return value === undefined ? null : value
    },
    async delete(key: unknown, scope?: unknown): Promise<void> {
      await channel.delete(mapStoreScope(scope, recorder), assertKey(key))
    }
  }
}

/** Adds a non-enumerable accessor that throws UnsupportedPieceContext when read. */
function unsupportedValue(target: object, prop: string, feature: string, recorder: UnsupportedUseRecorder): void {
  Object.defineProperty(target, prop, {
    enumerable: false,
    configurable: false,
    get: () => recorder.fail(feature)
  })
}

/** An object whose listed methods throw UnsupportedPieceContext when called. */
function unsupportedMethods(prefix: string, methods: string[], recorder: UnsupportedUseRecorder): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const m of methods) obj[m] = () => recorder.fail(`${prefix}.${m}()`)
  return obj
}

function serverStub(recorder: UnsupportedUseRecorder): object {
  const server = {}
  for (const prop of ['apiUrl', 'publicUrl', 'token']) unsupportedValue(server, prop, `server.${prop}`, recorder)
  return server
}

function baseContext(invocation: PieceInvocation, channel: PieceStoreChannel, recorder: UnsupportedUseRecorder): Record<string, unknown> {
  const flows = unsupportedMethods('flows', ['list'], recorder)
  unsupportedValue(flows, 'current', 'flows.current', recorder)
  const ctx: Record<string, unknown> = {
    auth: invocation.auth,
    propsValue: invocation.propsValue,
    store: createStoreShim(channel, recorder),
    step: { name: invocation.target.name },
    project: {
      id: invocation.projectId,
      externalId: async () => undefined
    },
    flows,
    connections: unsupportedMethods('connections', ['get'], recorder),
    server: serverStub(recorder),
    files: unsupportedMethods('files', ['write'], recorder)
  }
  return ctx
}

export function buildActionContext(
  invocation: PieceInvocation,
  channel: PieceStoreChannel,
  recorder: UnsupportedUseRecorder,
  runId: string
): Record<string, unknown> {
  const ctx = baseContext(invocation, channel, recorder)
  ctx.executionType = 'BEGIN'
  ctx.tags = unsupportedMethods('tags', ['add'], recorder)
  ctx.output = unsupportedMethods('output', ['update'], recorder)
  ctx.agent = unsupportedMethods('agent', ['tools'], recorder)
  ctx.run = {
    id: runId,
    ...unsupportedMethods('run', ['stop', 'pause', 'respond', 'createWaitpoint', 'waitForWaitpoint'], recorder)
  }
  ctx.generateResumeUrl = () => recorder.fail('generateResumeUrl()')
  unsupportedValue(ctx, 'resumePayload', 'resumePayload', recorder)
  return ctx
}

export function buildPollingTriggerContext(
  invocation: PieceInvocation,
  channel: PieceStoreChannel,
  recorder: UnsupportedUseRecorder
): Record<string, unknown> {
  const ctx = baseContext(invocation, channel, recorder)
  // 21x's scheduler owns the polling interval.
  ctx.setSchedule = () => recorder.fail('setSchedule()')
  ctx.app = unsupportedMethods('app', ['createListeners'], recorder)
  unsupportedValue(ctx, 'webhookUrl', 'webhookUrl', recorder)
  unsupportedValue(ctx, 'payload', 'payload', recorder)
  return ctx
}
