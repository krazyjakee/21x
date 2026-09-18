import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { createAction, createPiece, createTrigger, Property, TriggerStrategy } from '@activepieces/pieces-framework'
import { applySchema } from '../../database/schema'
import { ConnectorStore } from '../connector-store'
import type { ConnectorCredentials } from '../credentials'
import type { ConnectorPieceAllowlist } from '../allowlist'
import { kvBackendFromConnectorStore, PieceHostClient, type PieceHostTransport, type PieceKvBackend } from './client'
import {
  PieceCancelledError,
  PieceExecutionError,
  PieceHostCrashedError,
  PieceNotAllowedError,
  PieceTimeoutError,
  SsrfBlockedError,
  UnsupportedPieceContext
} from './errors'
import { startPieceHost, type PieceModuleLoader } from './host-runtime'
import type { HostInboundMessage, HostOutboundMessage } from './protocol'
import type { HostLookup } from '../ssrf'

/**
 * Drives the real host runtime and PieceHostClient through a fake transport
 * (no utilityProcess). Messages are structuredClone'd to mimic IPC.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any
const loose = (ctx: unknown): Loose => ctx

const PIECE = '@21x/stub-piece'
const VERSION = '1.0.0'

/** Stands in for the provider API the stub piece polls. */
const remote = { items: [] as { id: string; ts: number }[] }
const hooks: { onCrash?: () => void } = {}

const stubPiece = createPiece({
  displayName: 'Stub',
  logoUrl: 'https://example.com/logo.png',
  authors: [],
  auth: undefined,
  actions: [
    createAction({
      name: 'echo',
      displayName: 'Echo',
      description: 'Returns its input and auth',
      props: { text: Property.ShortText({ displayName: 'Text', required: true }) },
      async run(ctx) {
        const c = loose(ctx)
        return { text: c.propsValue.text, auth: c.auth, project: c.project.id, step: c.step.name }
      }
    }),
    createAction({
      name: 'counter',
      displayName: 'Counter',
      description: 'Increments a value in the store',
      props: {},
      async run(ctx) {
        const store = loose(ctx).store
        const n = ((await store.get('n')) as number | null) ?? 0
        await store.put('n', n + 1)
        return n + 1
      }
    }),
    createAction({
      name: 'crash',
      displayName: 'Crash',
      description: 'Kills the host process',
      props: {},
      async run() {
        hooks.onCrash?.()
        return new Promise(() => undefined)
      }
    }),
    createAction({
      name: 'hang',
      displayName: 'Hang',
      description: 'Never finishes',
      props: {},
      async run() {
        return new Promise(() => undefined)
      }
    }),
    createAction({
      name: 'pause_flow',
      displayName: 'Pause',
      description: 'Uses flow control',
      props: {},
      async run(ctx) {
        loose(ctx).run.pause({ pauseMetadata: { type: 'DELAY' } })
        return 'unreachable'
      }
    }),
    createAction({
      name: 'swallow',
      displayName: 'Swallow',
      description: 'Catches the unsupported-context error and carries on',
      props: {},
      async run(ctx) {
        try {
          await loose(ctx).connections.get('other')
        } catch {
          /* a careless piece */
        }
        return 'looks fine'
      }
    }),
    createAction({
      name: 'throw_secret',
      displayName: 'Throw',
      description: 'Fails with the credential in the message',
      props: {},
      async run(ctx) {
        throw new Error(`request failed for token ${loose(ctx).auth.secret_text}`)
      }
    }),
    createAction({
      name: 'fetch_url',
      displayName: 'Fetch',
      description: 'Has a URL prop',
      props: { url: Property.ShortText({ displayName: 'URL', required: true }) },
      async run(ctx) {
        return { fetched: loose(ctx).propsValue.url }
      }
    }),
    createAction({
      name: 'not_allowlisted',
      displayName: 'Hidden',
      description: 'Exists in the piece but not in the allowlist',
      props: {},
      async run() {
        return 'should never run'
      }
    })
  ],
  triggers: [
    createTrigger({
      name: 'new_items',
      displayName: 'New items',
      description: 'Polls remote.items with a timestamp cursor',
      props: {},
      type: TriggerStrategy.POLLING,
      sampleData: {},
      async onEnable(ctx) {
        await loose(ctx).store.put('lastPoll', 100)
      },
      async onDisable() {
        /* nothing */
      },
      async run(ctx) {
        const store = loose(ctx).store
        const last = (await store.get('lastPoll')) as number | null
        if (last === null) throw new Error("lastPoll doesn't exist in the store.")
        const fresh = remote.items.filter((i) => i.ts > last)
        await store.put('lastPoll', fresh.reduce((acc, i) => Math.max(acc, i.ts), last))
        return fresh.map((i) => i.id)
      }
    }),
    createTrigger({
      name: 'polls_with_webhook_url',
      displayName: 'Confused poller',
      description: 'A polling trigger that asks for a webhook URL',
      props: {},
      type: TriggerStrategy.POLLING,
      sampleData: {},
      async onEnable(ctx) {
        await loose(ctx).store.put('url', loose(ctx).webhookUrl)
      },
      async onDisable() {
        /* nothing */
      },
      async run(ctx) {
        loose(ctx).setSchedule({ cronExpression: '* * * * *' })
        return []
      }
    }),
    createTrigger({
      name: 'webhook_items',
      displayName: 'Webhook',
      description: 'Push trigger',
      props: {},
      type: TriggerStrategy.WEBHOOK,
      sampleData: {},
      async onEnable(ctx) {
        await loose(ctx).store.put('url', loose(ctx).webhookUrl)
      },
      async onDisable() {
        /* nothing */
      },
      async run() {
        return []
      }
    })
  ]
})

const ALLOWLIST: ConnectorPieceAllowlist = {
  allowedLicenses: ['MIT'],
  commercialPathPatterns: [],
  packages: {},
  reviewedLicenseExceptions: [],
  reviewedPathExceptions: [],
  pieces: {
    [PIECE]: {
      version: VERSION,
      exportName: 'stub',
      actions: {
        echo: {},
        counter: {},
        crash: {},
        hang: {},
        pause_flow: {},
        swallow: {},
        throw_secret: {},
        fetch_url: { urlProps: ['url'] }
      },
      triggers: {
        new_items: { strategy: 'POLLING' },
        polls_with_webhook_url: { strategy: 'POLLING' },
        // Misconfigured on purpose: the host still refuses a non-polling trigger.
        webhook_items: { strategy: 'POLLING' }
      }
    }
  }
}

/** The main side allows one more action than the host, to prove the host checks too. */
const CLIENT_ALLOWLIST: ConnectorPieceAllowlist = {
  ...ALLOWLIST,
  pieces: {
    [PIECE]: { ...ALLOWLIST.pieces[PIECE], actions: { ...ALLOWLIST.pieces[PIECE].actions, not_allowlisted: {} } }
  }
}

const loader: PieceModuleLoader = (name) => (name === PIECE ? { version: VERSION, module: { stub: stubPiece } } : undefined)

const fakeLookup: HostLookup = async (host) => {
  if (host === 'api.example.com') return ['93.184.216.34']
  if (host === 'intranet.example.com') return ['10.0.0.5']
  throw new Error('ENOTFOUND')
}

class FakeHostProcess implements PieceHostTransport {
  alive = true
  private readonly toHost: ((m: HostInboundMessage) => void)[] = []
  private readonly toMain: ((m: HostOutboundMessage) => void)[] = []
  private readonly exitHandlers: ((code: number | null) => void)[] = []

  constructor() {
    startPieceHost(
      {
        postMessage: (m) => {
          if (!this.alive) return
          const copy = structuredClone(m)
          setImmediate(() => this.alive && this.toMain.forEach((h) => h(copy)))
        },
        onMessage: (h) => this.toHost.push(h)
      },
      loader,
      { allowlist: ALLOWLIST, lookup: fakeLookup }
    )
  }

  postMessage(m: HostInboundMessage): void {
    if (!this.alive) return
    const copy = structuredClone(m)
    setImmediate(() => this.alive && this.toHost.forEach((h) => h(copy)))
  }

  onMessage(h: (m: HostOutboundMessage) => void): void {
    this.toMain.push(h)
  }

  onExit(h: (code: number | null) => void): void {
    this.exitHandlers.push(h)
  }

  kill(): void {
    this.exit(null)
  }

  crash(code: number): void {
    this.exit(code)
  }

  private exit(code: number | null): void {
    if (!this.alive) return
    this.alive = false
    setImmediate(() => this.exitHandlers.forEach((h) => h(code)))
  }
}

class MemoryKv implements PieceKvBackend {
  readonly data = new Map<string, unknown>()
  get(instanceId: string, scope: string, key: string): unknown {
    return this.data.has(`${instanceId}/${scope}/${key}`) ? this.data.get(`${instanceId}/${scope}/${key}`) : null
  }
  put(instanceId: string, scope: string, key: string, value: unknown): void {
    this.data.set(`${instanceId}/${scope}/${key}`, value)
  }
  delete(instanceId: string, scope: string, key: string): void {
    this.data.delete(`${instanceId}/${scope}/${key}`)
  }
}

function makeClient(opts: { kv?: PieceKvBackend; creds?: Record<string, ConnectorCredentials | null> } = {}): {
  client: PieceHostClient
  processes: FakeHostProcess[]
} {
  const processes: FakeHostProcess[] = []
  const creds = opts.creds ?? {}
  const client = new PieceHostClient({
    createTransport: () => {
      const p = new FakeHostProcess()
      processes.push(p)
      return p
    },
    kv: opts.kv ?? new MemoryKv(),
    credentials: { get: (id) => creds[id] ?? null },
    allowlist: CLIENT_ALLOWLIST,
    defaultTimeoutMs: 2_000
  })
  return { client, processes }
}

const base = { instanceId: 'inst-1', pieceName: PIECE, pieceVersion: VERSION }

describe('PieceHostClient + host runtime', () => {
  beforeEach(() => {
    hooks.onCrash = undefined
    remote.items = []
  })

  it('runs an action through IPC and returns its output, with auth resolved per call', async () => {
    const creds: Record<string, ConnectorCredentials | null> = { 'inst-1': { type: 'secret_text', secret: 'first-secret' } }
    const { client, processes } = makeClient({ creds })

    const out = await client.runAction({ ...base, actionName: 'echo', propsValue: { text: 'hi' } })
    expect(out).toEqual({
      text: 'hi',
      auth: { type: 'SECRET_TEXT', secret_text: 'first-secret' },
      project: '21x-connector-inst-1',
      step: 'echo'
    })

    creds['inst-1'] = { type: 'basic', username: 'key', password: 'token' }
    const second = (await client.runAction({ ...base, actionName: 'echo', propsValue: { text: 'again' } })) as Loose
    expect(second.auth).toEqual({ type: 'BASIC_AUTH', username: 'key', password: 'token' })
    expect(processes).toHaveLength(1)
    client.dispose()
  })

  it('scopes context.store to the calling instance', async () => {
    const kv = new MemoryKv()
    const { client } = makeClient({ kv })
    expect(await client.runAction({ ...base, actionName: 'counter' })).toBe(1)
    expect(await client.runAction({ ...base, actionName: 'counter' })).toBe(2)
    expect(await client.runAction({ ...base, instanceId: 'inst-2', actionName: 'counter' })).toBe(1)
    expect(kv.get('inst-1', 'flow', 'n')).toBe(2)
    expect(kv.get('inst-2', 'flow', 'n')).toBe(1)
    client.dispose()
  })

  it('surfaces a host crash as PieceHostCrashedError and restarts on the next call', async () => {
    const { client, processes } = makeClient()
    hooks.onCrash = () => processes[processes.length - 1].crash(134)

    const err = await client.runAction({ ...base, actionName: 'crash' }).catch((e) => e)
    expect(err).toBeInstanceOf(PieceHostCrashedError)
    expect((err as PieceHostCrashedError).exitCode).toBe(134)

    expect(await client.runAction({ ...base, actionName: 'echo', propsValue: { text: 'alive' } })).toMatchObject({ text: 'alive' })
    expect(client.starts).toBe(2)
    client.dispose()
  })

  it('kills the host on timeout and serves the next call from a fresh one', async () => {
    const { client, processes } = makeClient()
    const err = await client.runAction({ ...base, actionName: 'hang', timeoutMs: 50 }).catch((e) => e)
    expect(err).toBeInstanceOf(PieceTimeoutError)
    expect(processes[0].alive).toBe(false)

    expect(await client.runAction({ ...base, actionName: 'echo', propsValue: { text: 'ok' } })).toMatchObject({ text: 'ok' })
    expect(processes).toHaveLength(2)
    client.dispose()
  })

  it('cancels through an AbortSignal and kills the host', async () => {
    const { client, processes } = makeClient()
    const controller = new AbortController()
    const pending = client.runAction({ ...base, actionName: 'hang', signal: controller.signal }).catch((e) => e)
    setTimeout(() => controller.abort(), 20)
    expect(await pending).toBeInstanceOf(PieceCancelledError)
    expect(processes[0].alive).toBe(false)
    client.dispose()
  })

  it('throws UnsupportedPieceContext for flow control, webhook URLs and scheduling, even when swallowed', async () => {
    const { client } = makeClient()
    const pause = await client.runAction({ ...base, actionName: 'pause_flow' }).catch((e) => e)
    expect(pause).toBeInstanceOf(UnsupportedPieceContext)
    expect((pause as UnsupportedPieceContext).feature).toBe('run.pause()')

    const hook = { ...base, triggerName: 'polls_with_webhook_url' }
    const webhook = await client.runTrigger({ ...hook, hook: 'onEnable' }).catch((e) => e)
    expect(webhook).toBeInstanceOf(UnsupportedPieceContext)
    expect((webhook as UnsupportedPieceContext).feature).toBe('webhookUrl')
    const schedule = await client.runTrigger({ ...hook, hook: 'run' }).catch((e) => e)
    expect((schedule as UnsupportedPieceContext).feature).toBe('setSchedule()')

    const swallowed = await client.runAction({ ...base, actionName: 'swallow' }).catch((e) => e)
    expect(swallowed).toBeInstanceOf(UnsupportedPieceContext)
    expect((swallowed as UnsupportedPieceContext).feature).toBe('connections.get()')
    client.dispose()
  })

  it('refuses non-allowlisted pieces, versions, actions and non-polling triggers', async () => {
    const { client, processes } = makeClient()
    await expect(client.runAction({ ...base, pieceName: '@activepieces/piece-evil', actionName: 'x' })).rejects.toBeInstanceOf(
      PieceNotAllowedError
    )
    await expect(client.runAction({ ...base, pieceVersion: '1.0.1', actionName: 'echo' })).rejects.toBeInstanceOf(
      PieceNotAllowedError
    )
    await expect(client.runAction({ ...base, actionName: 'unknown' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    // Refused on the main side: no host process was started.
    expect(processes).toHaveLength(0)

    // Allowed by the client's list but not the host's: the host refuses too.
    await expect(client.runAction({ ...base, actionName: 'not_allowlisted' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    await expect(
      client.runTrigger({ ...base, triggerName: 'webhook_items', hook: 'onEnable' })
    ).rejects.toBeInstanceOf(PieceNotAllowedError)
    client.dispose()
  })

  it('redacts the credential from piece error messages', async () => {
    const { client } = makeClient({ creds: { 'inst-1': { type: 'secret_text', secret: 'sekrit-token-123' } } })
    const err = await client.runAction({ ...base, actionName: 'throw_secret' }).catch((e) => e)
    expect(err).toBeInstanceOf(PieceExecutionError)
    expect((err as Error).message).not.toContain('sekrit-token-123')
    client.dispose()
  })

  it('applies the SSRF guard to allowlisted URL props', async () => {
    const { client } = makeClient()
    const run = (url: string): Promise<unknown> => client.runAction({ ...base, actionName: 'fetch_url', propsValue: { url } })
    await expect(run('https://api.example.com/v1')).resolves.toEqual({ fetched: 'https://api.example.com/v1' })
    await expect(run('http://127.0.0.1:8080/admin')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(run('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(run('http://intranet.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(run('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError)
    client.dispose()
  })
})

describe('polling trigger cursor in connector_kv', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '21x-piece-host-'))
    remote.items = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function openStore(): { db: InstanceType<typeof Database>; store: ConnectorStore } {
    const db = new Database(join(dir, 'app.db'))
    db.pragma('foreign_keys = ON')
    applySchema(db)
    return { db, store: new ConnectorStore({ db }) }
  }

  it('persists the cursor across a simulated app restart', async () => {
    // First app run: enable the trigger, which stores the initial cursor.
    const first = openStore()
    const instance = first.store.createInstance({ pieceName: PIECE, pieceVersion: VERSION })
    const run1 = makeClient({ kv: kvBackendFromConnectorStore(first.store) })
    const trigger = { ...base, instanceId: instance.id, triggerName: 'new_items' }
    await run1.client.runTrigger({ ...trigger, hook: 'onEnable' })
    remote.items = [
      { id: 'a', ts: 150 },
      { id: 'b', ts: 200 }
    ]
    expect(await run1.client.runTrigger({ ...trigger, hook: 'run' })).toEqual(['a', 'b'])
    expect(first.store.kvGet(instance.id, 'flow', 'lastPoll')).toBe(200)
    run1.client.dispose()
    first.db.close()

    // Second app run: new database handle, new client, new host process.
    const second = openStore()
    const run2 = makeClient({ kv: kvBackendFromConnectorStore(second.store) })
    remote.items.push({ id: 'c', ts: 300 })
    expect(await run2.client.runTrigger({ ...trigger, hook: 'run' })).toEqual(['c'])
    expect(second.store.kvGet(instance.id, 'flow', 'lastPoll')).toBe(300)
    run2.client.dispose()
    second.db.close()
  })
})
