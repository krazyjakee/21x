import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { get as httpGet } from 'http'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { createTestDb } from '../../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../../database'
import { PluginActionId, TaskStatus } from '../../../shared/constants'
import { ConnectorBridgePlugin } from '../../plugins/connector-bridge-plugin'
import type { PluginContext } from '../../plugins/types'
import { pkceChallenge } from '../../oauth/pkce'
import { CONNECTOR_PIECE_ALLOWLIST, type ConnectorPieceAllowlist } from '../allowlist'
import { ConnectorStore } from '../connector-store'
import { ConnectorCredentialStore } from '../credentials'
import { ConnectorOAuthService } from '../oauth'
import { kvBackendFromConnectorStore, PieceHostClient, type PieceHostTransport } from '../piece-host/client'
import { PieceNotAllowedError } from '../piece-host/errors'
import { startPieceHost } from '../piece-host/host-runtime'
import { loadBundledPiece } from '../piece-host/piece-registry'
import type { HostInboundMessage, HostOutboundMessage } from '../piece-host/protocol'
import { ConnectorBridgeEngine, type BridgeRuntime } from './engine'
import { CONNECTOR_TASK_MAPPINGS } from './mappings'
import type { RetryPolicy } from './retry'
import { readCursor } from './state'

/**
 * Todoist OAuth2 proof (issue #15, docs/taskSources.md "Connector OAuth2").
 *
 * Runs the REAL pinned @activepieces/piece-todoist bundle through the real
 * piece-host runtime (in-process, behind a fake transport) and the connector
 * bridge, with the OAuth2 token resolved by ConnectorOAuthService, against a
 * FAKE Todoist: a fake authorization server (the "browser" is a function that
 * parses the authorization URL and hits the real loopback callback server
 * over localhost), a fake token endpoint and a fake task API. pieces-common
 * sends every request through the global `fetch`, and so does the connector
 * OAuth provider, so replacing `globalThis.fetch` keeps everything off the
 * network. The piece code, the allowlist, the OAuth settings and the Todoist
 * task mapping are the production ones.
 *
 * Real Todoist tokens never expire and no refresh token is issued; the fake
 * provider issues expiring tokens with refresh tokens so the refresh and
 * revoked-refresh paths are exercised too.
 */

const PIECE = '@activepieces/piece-todoist'
const VERSION = '0.5.0'
const CLIENT_ID = 'todoist-app-client-id-0123456789'
const CLIENT_SECRET = 'todoist-app-client-secret-abcdef0123456789abcdef'
const AUTH_URL = 'https://todoist.com/oauth/authorize'
const TOKEN_URL = 'https://todoist.com/oauth/access_token'
const API = 'https://api.todoist.com/api/v1'
const FILTER = '#Work | overdue'
const RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 }
const PAGE_SIZE = 3

// ── Fake Todoist ────────────────────────────────────────────────

interface TodoistTask {
  id: string
  content: string
  description: string
  due: { date: string; string: string; lang: string; is_recurring: boolean } | null
  labels: string[]
  checked: boolean
  priority: number
  project_id: string
  added_at: string
  updated_at: string
}

interface ApiRequest {
  method: string
  url: URL
  headers: Headers
  body: Record<string, unknown> | null
  form: URLSearchParams | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

function task(id: string, overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id,
    content: `Task ${id}`,
    description: '',
    due: null,
    labels: [],
    checked: false,
    priority: 1,
    project_id: '2203306141',
    added_at: '2026-09-01T00:00:00.000000Z',
    updated_at: '2026-09-01T00:00:00.000000Z',
    ...overrides
  }
}

type FetchInput = string | URL | { url: string }
type FetchInit = { method?: string; body?: unknown; headers?: HeadersInit } | undefined

class FakeTodoist {
  readonly tasks = new Map<string, TodoistTask>()
  readonly requests: ApiRequest[] = []
  readonly authorizeUrls: URL[] = []
  readonly overrides: ((req: ApiRequest) => Response | undefined)[] = []
  /** Whether the fake provider requires PKCE (the real Todoist does not document it). */
  pkce = false
  /** Seconds a token lives; null = never expires and no refresh token (real Todoist). */
  expiresIn: number | null = 3600
  /** Set to make every refresh fail with invalid_grant (the user revoked the app). */
  refreshRevoked = false
  private issued = 0
  private readonly pendingCodes = new Map<string, { redirectUri: string; challenge: string | null }>()
  readonly accessTokens = new Set<string>()
  private readonly refreshTokens = new Set<string>()

  add(t: TodoistTask): TodoistTask {
    this.tasks.set(t.id, t)
    return t
  }

  /** Invalidates every access token, as revoking the app in Todoist would. */
  revokeAccess(): void {
    this.accessTokens.clear()
  }

  /** The "browser": validates the authorization request and sends the user back to the loopback URI. */
  readonly browser = async (url: string): Promise<void> => {
    const u = new URL(url)
    this.authorizeUrls.push(u)
    if (`${u.origin}${u.pathname}` !== AUTH_URL) throw new Error(`unexpected authorization URL ${url}`)
    const p = u.searchParams
    if (p.get('response_type') !== 'code') throw new Error('response_type must be code')
    if (p.get('client_id') !== CLIENT_ID) throw new Error('unknown client_id')
    const redirectUri = p.get('redirect_uri') ?? ''
    if (!/^http:\/\/localhost:30[01]\d\/callback$/.test(redirectUri)) throw new Error(`redirect_uri not registered: ${redirectUri}`)
    if (p.get('scope') !== 'data:read_write') throw new Error(`unexpected scope ${p.get('scope')}`)
    const state = p.get('state')
    if (!state) throw new Error('missing state')
    const challenge = p.get('code_challenge')
    if (this.pkce) {
      if (!challenge || p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 challenge required')
    }
    const code = `code-${++this.issued}-${Math.random().toString(36).slice(2)}`
    this.pendingCodes.set(code, { redirectUri, challenge })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', state)
    // The user lands on the loopback page a moment later; `fetch` is faked, so use node's http.
    setImmediate(() => {
      httpGet(back, { headers: { Connection: 'close' } }, (res) => res.resume()).on('error', () => undefined)
    })
  }

  readonly fetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? {})
    const raw = init?.body
    const isForm = (headers.get('content-type') ?? '').includes('x-www-form-urlencoded')
    const form = isForm && typeof raw === 'string' ? new URLSearchParams(raw) : null
    const body = !isForm && typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    const req: ApiRequest = { method, url, headers, body, form }
    this.requests.push(req)
    for (const override of this.overrides) {
      const res = override(req)
      if (res) return res
    }
    if (href.startsWith(TOKEN_URL)) return this.token(req)
    return this.api(req)
  }

  private issueTokens(): Record<string, unknown> {
    const n = ++this.issued
    const access = `at-${n}-${Math.random().toString(36).slice(2)}0123456789`
    this.accessTokens.add(access)
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer' }
    if (this.expiresIn !== null) {
      const refresh = `rt-${n}-${Math.random().toString(36).slice(2)}0123456789`
      this.refreshTokens.add(refresh)
      out.refresh_token = refresh
      out.expires_in = this.expiresIn
    }
    return out
  }

  private token(req: ApiRequest): Response {
    if (req.method !== 'POST' || !req.form) return json(400, { error: 'invalid_request' })
    const f = req.form
    if (f.get('client_id') !== CLIENT_ID) return json(401, { error: 'invalid_client' })
    const grant = f.get('grant_type')
    if (grant === 'authorization_code') {
      const pending = this.pendingCodes.get(f.get('code') ?? '')
      this.pendingCodes.delete(f.get('code') ?? '')
      if (!pending) return json(400, { error: 'invalid_grant', error_description: 'unknown code' })
      if (f.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      if (this.pkce) {
        const verifier = f.get('code_verifier')
        if (!verifier || pkceChallenge(verifier) !== pending.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      } else if (f.get('client_secret') !== CLIENT_SECRET) {
        return json(401, { error: 'invalid_client', error_description: 'bad secret' })
      }
      return json(200, this.issueTokens())
    }
    if (grant === 'refresh_token') {
      if (!this.pkce && f.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' })
      const refresh = f.get('refresh_token') ?? ''
      if (this.refreshRevoked || !this.refreshTokens.has(refresh)) {
        return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' })
      }
      // Rotation: the old pair stops working.
      this.refreshTokens.delete(refresh)
      const n = refresh.split('-')[1]
      for (const t of [...this.accessTokens]) if (t.startsWith(`at-${n}-`)) this.accessTokens.delete(t)
      return json(200, this.issueTokens())
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private api(req: ApiRequest): Response {
    if (!req.url.href.startsWith(API)) return text(404, `unexpected host ${req.url.host}`)
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ') || !this.accessTokens.has(auth.slice(7))) return json(401, { error: 'Unauthorized' })
    const path = req.url.pathname.slice('/api/v1'.length)
    if (req.method === 'GET' && path === '/tasks/filter') {
      if (req.url.searchParams.get('query') !== FILTER) return json(400, { error: 'unknown filter' })
      const active = [...this.tasks.values()].filter((t) => !t.checked)
      const start = parseInt(req.url.searchParams.get('cursor') ?? '0', 10)
      const page = active.slice(start, start + PAGE_SIZE)
      const next = start + PAGE_SIZE < active.length ? String(start + PAGE_SIZE) : null
      return json(200, { results: page, next_cursor: next })
    }
    const one = /^\/tasks\/([^/]+)(\/close|\/reopen)?$/.exec(path)
    if (req.method === 'POST' && one) {
      const existing = this.tasks.get(one[1])
      if (!existing) return json(404, { error: 'Task not found' })
      if (one[2] === '/close') {
        existing.checked = true
        return new Response(null, { status: 204 })
      }
      if (one[2] === '/reopen') {
        existing.checked = false
        return new Response(null, { status: 204 })
      }
      const b = req.body ?? {}
      if (typeof b.content === 'string') existing.content = b.content
      if (typeof b.description === 'string') existing.description = b.description
      if (Array.isArray(b.labels)) existing.labels = b.labels as string[]
      if (typeof b.due_datetime === 'string') existing.due = { date: b.due_datetime, string: b.due_datetime, lang: 'en', is_recurring: false }
      if (typeof b.due_date === 'string') existing.due = { date: b.due_date, string: b.due_date, lang: 'en', is_recurring: false }
      return json(200, existing)
    }
    return json(404, { error: `Cannot ${req.method} ${path}` })
  }
}

// ── In-process piece host ───────────────────────────────────────

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
      loadBundledPiece,
      {
        lookup: async () => {
          throw new Error('DNS lookups are disabled in this test')
        }
      }
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
    if (!this.alive) return
    this.alive = false
    setImmediate(() => this.exitHandlers.forEach((h) => h(null)))
  }
}

// ── Fake keychain ───────────────────────────────────────────────

const MARKER = Buffer.from('fake-keychain:')
const KEY = 0x5a

function fakeEncrypt(value: string): Buffer {
  const plain = Buffer.from(value, 'utf8')
  const out = Buffer.alloc(MARKER.length + plain.length)
  MARKER.copy(out)
  for (let i = 0; i < plain.length; i++) out[MARKER.length + i] = plain[i] ^ KEY
  return out
}

function fakeDecrypt(value: Buffer): string {
  if (!value.subarray(0, MARKER.length).equals(MARKER)) throw new Error('not encrypted by this keychain')
  const out = Buffer.alloc(value.length - MARKER.length)
  for (let i = 0; i < out.length; i++) out[i] = value[MARKER.length + i] ^ KEY
  return out.toString('utf8')
}

// ── Harness ─────────────────────────────────────────────────────

interface Harness {
  store: ConnectorStore
  credentialStore: ConnectorCredentialStore
  oauth: ConnectorOAuthService
  client: PieceHostClient
  processes: FakeHostProcess[]
  runtime: BridgeRuntime
  allowlist: ConnectorPieceAllowlist
}

let db: DatabaseManager
let instanceId: string
let projectId: string
let sourceId: string
let config: Record<string, unknown>
let ctx: PluginContext
let now: number
let api: FakeTodoist
let harnesses: Harness[]
let realFetch: typeof globalThis.fetch
let tlsEnv: string | undefined
type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void }
let consoleError: ConsoleSpy
let consoleWarn: ConsoleSpy

function makeHarness(opts: { allowlist?: ConnectorPieceAllowlist } = {}): Harness {
  const allowlist = opts.allowlist ?? CONNECTOR_PIECE_ALLOWLIST
  const store = new ConnectorStore(db)
  const credentialStore = new ConnectorCredentialStore(store)
  const oauth = new ConnectorOAuthService({
    store,
    credentials: credentialStore,
    openExternal: api.browser,
    fetch: api.fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    allowlist
  })
  const processes: FakeHostProcess[] = []
  const client = new PieceHostClient({
    createTransport: () => {
      const p = new FakeHostProcess()
      processes.push(p)
      return p
    },
    kv: kvBackendFromConnectorStore(store),
    credentials: oauth,
    defaultTimeoutMs: 5_000,
    allowlist
  })
  const runtime: BridgeRuntime = { store, credentials: oauth, client }
  const harness = { store, credentialStore, oauth, client, processes, runtime, allowlist }
  harnesses.push(harness)
  return harness
}

const engineOptions = (h: Harness) => ({ retry: RETRY, itemMaxAttempts: 3, now: () => now, log: () => undefined, allowlist: h.allowlist })

function makeEngine(h: Harness = makeHarness()): ConnectorBridgeEngine {
  return new ConnectorBridgeEngine({ ...engineOptions(h), runtime: h.runtime })
}

function makePlugin(h: Harness = makeHarness()): ConnectorBridgePlugin {
  return new ConnectorBridgePlugin({ runtime: () => h.runtime, engine: engineOptions(h) })
}

async function connect(h: Harness): Promise<string> {
  await h.oauth.connect(instanceId, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const creds = h.credentialStore.get(instanceId)
  if (creds?.type !== 'oauth2') throw new Error('not connected')
  return creds.accessToken
}

function tasks() {
  return db.getTasks({ projectId }).filter((t) => t.source_id === sourceId)
}

function snapshot() {
  return tasks().map((t) => ({ id: t.id, external_id: t.external_id, title: t.title, status: t.status, due_date: t.due_date }))
}

function tokenRequests(grant: string): ApiRequest[] {
  return api.requests.filter((r) => r.url.href.startsWith(TOKEN_URL) && r.form?.get('grant_type') === grant)
}

function filterRequests(): ApiRequest[] {
  return api.requests.filter((r) => r.method === 'GET' && r.url.pathname === '/api/v1/tasks/filter')
}

function taskPosts(): ApiRequest[] {
  return api.requests.filter((r) => r.method === 'POST' && r.url.pathname.startsWith('/api/v1/tasks/'))
}

function loggedText(): string {
  return [...consoleError.mock.calls, ...consoleWarn.mock.calls].map((c) => c.map((v) => String(v)).join(' ')).join('\n')
}

function secretsOf(...tokens: string[]): string[] {
  return [CLIENT_SECRET, ...tokens.filter(Boolean)]
}

beforeEach(() => {
  ;({ db } = createTestDb())
  instanceId = new ConnectorStore(db).createInstance({ pieceName: PIECE, pieceVersion: VERSION, displayName: 'Todoist' }).id
  projectId = db.createProject({ name: 'Todoist project' })!.id
  config = { piece_name: PIECE, connector_instance_id: instanceId, props: { filter_query: FILTER }, poll_interval_minutes: 10 }
  sourceId = db.createTaskSource({ name: 'Todoist', plugin_id: 'connector-bridge', mcp_server_id: null, project_id: projectId, config })!.id
  ctx = { db, sourceId }
  now = 1_700_000_000_000
  harnesses = []
  api = new FakeTodoist()
  realFetch = globalThis.fetch
  globalThis.fetch = api.fetch as unknown as typeof globalThis.fetch
  tlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  vi.mocked(safeStorage.encryptString).mockImplementation(fakeEncrypt)
  vi.mocked(safeStorage.decryptString).mockImplementation(fakeDecrypt)
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  for (const h of harnesses) h.client.dispose()
  globalThis.fetch = realFetch
  if (tlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsEnv
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
  consoleError.mockRestore()
  consoleWarn.mockRestore()
})

// ── Wiring ──────────────────────────────────────────────────────

describe('Todoist is only an allowlist entry, a declarative mapping and a registry line', () => {
  it('mentions Todoist in no connector source file except the allowlist, the mapping and the static registry', () => {
    const root = join(__dirname, '..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && /todoist/i.test(readFileSync(path, 'utf8'))) {
          hits.push(relative(root, path))
        }
      }
    }
    walk(root)
    expect(hits.sort()).toEqual(['allowlist.ts', 'bridge/mappings.ts', 'piece-host/piece-registry.ts'])
  })

  it('has a pure-data mapping whose operations exist in the pinned piece, and OAuth settings that match the piece', () => {
    const mapping = CONNECTOR_TASK_MAPPINGS[PIECE]
    expect(JSON.parse(JSON.stringify(mapping))).toEqual(mapping)
    expect(mapping.auth.type).toBe('oauth2')
    expect(mapping.import.target).toEqual({ type: 'action', name: 'todoist_filter_tasks' })
    expect(mapping.update?.statusActions?.complete.action).toBe('todoist_complete_task')

    const loaded = loadBundledPiece(PIECE)!
    expect(loaded.version).toBe(VERSION)
    const piece = loaded.module.todoist as { getAction(name: string): unknown; getTrigger(name: string): { type?: string } | undefined }
    const entry = CONNECTOR_PIECE_ALLOWLIST.pieces[PIECE]
    for (const name of Object.keys(entry.actions)) expect(piece.getAction(name), name).toBeDefined()
    for (const name of Object.keys(entry.triggers)) expect(piece.getTrigger(name)?.type, name).toBe('POLLING')

    // The allowlist's OAuth settings are the piece's own PieceAuth.OAuth2 declaration, and no secret is shipped.
    const auth = loaded.module.todoistAuth as { authUrl: string; tokenUrl: string; scope: string[] }
    expect(entry.oauth).toMatchObject({ mode: 'user-supplied', authUrl: auth.authUrl, tokenUrl: auth.tokenUrl, scopes: auth.scope, pkce: false, loopbackRedirect: true })
    expect(JSON.stringify(CONNECTOR_PIECE_ALLOWLIST)).not.toMatch(/client_?secret"\s*:/i)
    expect(entry.oauth?.clientId).toBeUndefined()
  })

  it('refuses Todoist operations outside the allowlist before a host is started', async () => {
    const h = makeHarness()
    const base = { instanceId, pieceName: PIECE, pieceVersion: VERSION }
    await expect(h.client.runAction({ ...base, actionName: 'todoist_delete_task', propsValue: { task_id: 'a' } })).rejects.toBeInstanceOf(PieceNotAllowedError)
    await expect(h.client.runAction({ ...base, actionName: 'todoist_create_task' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    await expect(h.client.runAction({ ...base, actionName: 'custom_api_call' })).rejects.toBeInstanceOf(PieceNotAllowedError)
    expect(h.processes).toHaveLength(0)
  })
})

// ── Connect ─────────────────────────────────────────────────────

describe('connect through the loopback flow', () => {
  it('builds the authorization URL the provider expects, exchanges the code with the client secret, and stores the token encrypted', async () => {
    const h = makeHarness()
    expect(h.oauth.status(instanceId)).toEqual({ state: 'none', expiresAt: null })

    const token = await connect(h)

    expect(api.authorizeUrls).toHaveLength(1)
    const p = api.authorizeUrls[0].searchParams
    expect(`${api.authorizeUrls[0].origin}${api.authorizeUrls[0].pathname}`).toBe(AUTH_URL)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('client_id')).toBe(CLIENT_ID)
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/localhost:30[01]\d\/callback$/)
    expect(p.get('scope')).toBe('data:read_write')
    expect(p.get('state')).toMatch(/^[a-z0-9]{20,}$/)
    // Todoist does not document PKCE, so the allowlist turns it off and nothing PKCE-shaped is sent.
    expect(p.has('code_challenge')).toBe(false)
    expect(p.has('code_challenge_method')).toBe(false)
    // Nothing secret goes into the browser.
    expect(api.authorizeUrls[0].href).not.toContain(CLIENT_SECRET)

    const [exchange] = tokenRequests('authorization_code')
    expect(tokenRequests('authorization_code')).toHaveLength(1)
    expect(exchange.headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(exchange.form?.get('client_secret')).toBe(CLIENT_SECRET)
    expect(exchange.form?.get('redirect_uri')).toBe(p.get('redirect_uri'))
    expect(exchange.form?.has('code_verifier')).toBe(false)

    // Stored with the instance's credentials as keychain ciphertext, refresh token and expiry included.
    expect(h.store.getInstance(instanceId)).toMatchObject({ authType: 'oauth2', hasStoredAuth: true })
    const blob = h.store.getAuthBlob(instanceId)!.auth!
    expect(blob.toString('utf8')).not.toContain(token)
    expect(blob.toString('utf8')).not.toContain(CLIENT_SECRET)
    expect(h.credentialStore.get(instanceId)).toMatchObject({
      type: 'oauth2',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      accessToken: token,
      expiresAt: now + 3600_000,
      tokenType: 'Bearer'
    })
    expect(h.oauth.status(instanceId)).toEqual({ state: 'connected', expiresAt: now + 3600_000 })
  })

  it('sends a PKCE S256 challenge and verifier for a provider that supports it, without a client secret', async () => {
    const allowlist = structuredClone(CONNECTOR_PIECE_ALLOWLIST)
    allowlist.pieces[PIECE].oauth!.pkce = true
    api.pkce = true
    const h = makeHarness({ allowlist })

    await h.oauth.connect(instanceId, { clientId: CLIENT_ID })

    const p = api.authorizeUrls[0].searchParams
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('code_challenge_method')).toBe('S256')
    const [exchange] = tokenRequests('authorization_code')
    expect(exchange.form?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(pkceChallenge(exchange.form!.get('code_verifier')!)).toBe(p.get('code_challenge'))
    expect(exchange.form?.has('client_secret')).toBe(false)
    expect(h.credentialStore.get(instanceId)).toMatchObject({ type: 'oauth2', clientSecret: null })
    expect(h.oauth.status(instanceId).state).toBe('connected')
  })

  it('stores nothing when the token endpoint refuses the code exchange', async () => {
    const h = makeHarness()
    api.overrides.push((req) => (req.url.href.startsWith(TOKEN_URL) ? json(401, { error: 'invalid_client', error_description: 'bad secret' }) : undefined))
    await expect(h.oauth.connect(instanceId, { clientId: CLIENT_ID, clientSecret: 'wrong-secret-000000' })).rejects.toThrow(/invalid_client: bad secret/)
    expect(h.store.getInstance(instanceId)?.hasStoredAuth).toBe(false)
    expect(h.oauth.status(instanceId).state).toBe('none')
  })

  it('fails fast with the keychain remediation before opening the browser when persistent storage is unavailable', async () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const h = makeHarness()
    await expect(h.oauth.connect(instanceId, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).rejects.toMatchObject({ code: 'CONNECTOR_CREDENTIALS_UNAVAILABLE', sessionOnlyAvailable: true })
    expect(api.authorizeUrls).toHaveLength(0)

    await h.oauth.connect(instanceId, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, 'session')
    expect(h.credentialStore.getStorage(instanceId)).toBe('session')
    expect(h.oauth.status(instanceId).state).toBe('connected')
  })
})

// ── Import ──────────────────────────────────────────────────────

describe('import through the real todoist_filter_tasks action with the resolved token', () => {
  it('follows every page, sends the access token as a bearer, and maps tasks to canonical fields', async () => {
    api.add(task('a', { content: 'Fix the login bug', description: 'Users see a blank page.', due: { date: '2026-10-01', string: 'Oct 1', lang: 'en', is_recurring: false }, labels: ['bug', 'urgent'] }))
    api.add(task('b', { content: 'No due date' }))
    api.add(task('c', { content: 'Timed', due: { date: '2026-10-02T09:30:00', string: '', lang: 'en', is_recurring: false } }))
    api.add(task('d'))
    api.add(task('e'))
    api.add(task('done', { content: 'Already done', checked: true }))
    const h = makeHarness()
    const token = await connect(h)
    const plugin = makePlugin(h)

    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 5, updated: 0, errors: [] })

    expect(db.getTaskByExternalId(sourceId, 'a')).toMatchObject({
      title: 'Fix the login bug',
      description: 'Users see a blank page.',
      due_date: new Date('2026-10-01').toISOString(),
      labels: ['bug', 'urgent'],
      status: TaskStatus.NotStarted,
      project_id: projectId,
      source: 'Todoist'
    })
    expect(db.getTaskByExternalId(sourceId, 'b')).toMatchObject({ title: 'No due date', due_date: null })
    expect(db.getTaskByExternalId(sourceId, 'c')?.due_date).toBe(new Date('2026-10-02T09:30:00').toISOString())
    // Completed tasks are not active, so Todoist never returns them and no task is created.
    expect(db.getTaskByExternalId(sourceId, 'done')).toBeUndefined()

    // 5 active tasks, 3 per page: the piece asked twice, following next_cursor, with the OAuth bearer each time.
    const pages = filterRequests()
    expect(pages).toHaveLength(2)
    expect(pages.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, '3'])
    for (const r of pages) {
      expect(r.url.origin).toBe('https://api.todoist.com')
      expect(r.url.searchParams.get('query')).toBe(FILTER)
      expect(r.headers.get('authorization')).toBe(`Bearer ${token}`)
    }
    // No token exchange or refresh was needed for a fresh token.
    expect(tokenRequests('refresh_token')).toHaveLength(0)
  })

  it('reports a clear error and connects nothing when the instance has no OAuth connection yet', async () => {
    api.add(task('a'))
    const plugin = makePlugin()
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result).toEqual({ imported: 0, updated: 0, errors: ['Todoist is not connected: connect it in the task source settings.'] })
    expect(api.requests).toHaveLength(0)
  })
})

// ── Refresh ─────────────────────────────────────────────────────

describe('refresh of an expired token', () => {
  it('refreshes once before the piece runs, persists the new token set, and uses it for every call', async () => {
    api.add(task('a'))
    const h = makeHarness()
    const first = await connect(h)
    const plugin = makePlugin(h)
    await plugin.importTasks(sourceId, config, ctx)

    now += 3600_000 // the fake provider's expires_in has passed
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result).toEqual({ imported: 0, updated: 1, errors: [] })

    const refreshes = tokenRequests('refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0].form?.get('client_id')).toBe(CLIENT_ID)
    expect(refreshes[0].form?.get('client_secret')).toBe(CLIENT_SECRET)
    expect(refreshes[0].form?.get('refresh_token')).toMatch(/^rt-/)

    const stored = h.credentialStore.get(instanceId)
    expect(stored?.type).toBe('oauth2')
    const second = stored?.type === 'oauth2' ? stored.accessToken : ''
    expect(second).not.toBe(first)
    expect(stored).toMatchObject({ expiresAt: now + 3600_000 })
    expect(h.oauth.status(instanceId)).toEqual({ state: 'connected', expiresAt: now + 3600_000 })
    // The import after the refresh used the new bearer; the old one never appears again.
    const later = filterRequests().slice(1)
    expect(later).toHaveLength(1)
    expect(later[0].headers.get('authorization')).toBe(`Bearer ${second}`)

    // A completion within the same window reuses the fresh token: no second refresh.
    const t = db.getTaskByExternalId(sourceId, 'a')!
    expect(await plugin.executeAction(PluginActionId.Complete, t, undefined, config, ctx)).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(tokenRequests('refresh_token')).toHaveLength(1)
    expect(taskPosts()[taskPosts().length - 1].headers.get('authorization')).toBe(`Bearer ${second}`)
  })

  it('refreshes ahead of expiry (five-minute margin) and survives a restart with the persisted token set', async () => {
    api.add(task('a'))
    const first = makeHarness()
    await connect(first)
    await makePlugin(first).importTasks(sourceId, config, ctx)
    first.client.dispose()

    now += 3600_000 - 4 * 60_000 // 4 minutes before expiry: inside the margin
    const second = makeHarness()
    expect(await makePlugin(second).importTasks(sourceId, config, ctx)).toEqual({ imported: 0, updated: 1, errors: [] })
    expect(tokenRequests('refresh_token')).toHaveLength(1)
    expect(second.oauth.status(instanceId).state).toBe('connected')
  })
})

// ── Revoked ─────────────────────────────────────────────────────

describe('revoked tokens', () => {
  it('refresh refused with invalid_grant: a clear per-instance error, no retries, no task changes, no leaked secrets, and reconnect recovers', async () => {
    api.add(task('a'))
    api.add(task('b'))
    const h = makeHarness()
    const first = await connect(h)
    const plugin = makePlugin(h)
    await plugin.importTasks(sourceId, config, ctx)
    const before = snapshot()

    api.refreshRevoked = true
    now += 3600_000
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result).toMatchObject({ imported: 0, updated: 0 })
    expect(result.errors).toEqual(['Todoist sync failed: Todoist access was revoked or has expired; reconnect it in the task source settings. Existing tasks were kept.'])
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null, lastError: 'Todoist access was revoked or has expired; reconnect it in the task source settings.' })
    expect(h.store.listDeadLetters(instanceId)).toEqual([])
    expect(snapshot()).toEqual(before)
    expect(h.oauth.status(instanceId)).toEqual({ state: 'revoked', expiresAt: null })
    // One refresh attempt, then no piece call: Todoist itself was never asked with a dead token.
    expect(tokenRequests('refresh_token')).toHaveLength(1)
    expect(filterRequests()).toHaveLength(1)

    // Subsequent syncs do not keep hammering the token endpoint.
    await plugin.importTasks(sourceId, config, ctx)
    expect(tokenRequests('refresh_token')).toHaveLength(1)

    // Cached tasks stay usable; the completion gate fails cleanly and a local edit is queued, not dead-lettered.
    const t = db.getTaskByExternalId(sourceId, 'a')!
    expect(db.updateTask(t.id, { title: 'Edited while revoked' })?.title).toBe('Edited while revoked')
    const action = await plugin.executeAction(PluginActionId.Complete, t, undefined, config, ctx)
    expect(action).toEqual({ success: false, error: 'Todoist access was revoked or has expired; reconnect it in the task source settings.' })
    expect(db.getTaskByExternalId(sourceId, 'a')?.status).toBe(TaskStatus.NotStarted)
    await plugin.exportUpdate(t, { title: 'Edited while revoked' }, config, ctx)
    expect(readCursor(h.store.getSyncState(instanceId)?.cursor).pending.a).toMatchObject({ changed: { title: 'Edited while revoked' } })
    expect(h.store.listDeadLetters(instanceId)).toEqual([])

    for (const s of [JSON.stringify(result), JSON.stringify(action), h.store.getSyncState(instanceId)?.lastError ?? '', loggedText()]) {
      for (const secret of secretsOf(first)) expect(s).not.toContain(secret)
    }

    // Reconnect: a new browser flow, then the next sync lands the queued edit and imports again.
    api.refreshRevoked = false
    const second = await connect(h)
    expect(second).not.toBe(first)
    expect(h.oauth.status(instanceId).state).toBe('connected')
    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 0, updated: 2, errors: [] })
    expect(api.tasks.get('a')?.content).toBe('Edited while revoked')
    expect(readCursor(h.store.getSyncState(instanceId)?.cursor).pending).toEqual({})
    expect(h.store.getSyncState(instanceId)?.lastError).toBeNull()
  })

  it('a non-expiring token (real Todoist) revoked at the provider: HTTP 401 is a permanent error and no refresh is attempted', async () => {
    api.expiresIn = null
    api.add(task('a'))
    const h = makeHarness()
    const token = await connect(h)
    expect(h.credentialStore.get(instanceId)).toMatchObject({ type: 'oauth2', refreshToken: null, expiresAt: null })
    expect(h.oauth.status(instanceId)).toEqual({ state: 'connected', expiresAt: null })
    const plugin = makePlugin(h)
    expect((await plugin.importTasks(sourceId, config, ctx)).imported).toBe(1)
    const before = snapshot()

    api.revokeAccess()
    now += 365 * 24 * 3600_000 // a year later: still no refresh, because the provider never gave one
    const result = await plugin.importTasks(sourceId, config, ctx)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('HTTP 401')
    expect(result.errors[0]).toContain('Existing tasks were kept')
    expect(h.store.getSyncState(instanceId)).toMatchObject({ attemptCount: 0, nextRetryAt: null })
    expect(h.store.listDeadLetters(instanceId)).toEqual([])
    expect(snapshot()).toEqual(before)
    expect(tokenRequests('refresh_token')).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('an expired token with no refresh token asks the user to reconnect', async () => {
    api.add(task('a'))
    const h = makeHarness()
    await connect(h)
    // Simulate a provider that expires tokens but issued no refresh token.
    const creds = h.credentialStore.get(instanceId)
    if (creds?.type !== 'oauth2') throw new Error('not oauth2')
    h.credentialStore.set(instanceId, { ...creds, refreshToken: null })
    now += 3600_000
    const result = await makePlugin(h).importTasks(sourceId, config, ctx)
    expect(result.errors).toEqual(['Todoist sync failed: Todoist access has expired and cannot be renewed; reconnect it in the task source settings. Existing tasks were kept.'])
    expect(h.oauth.status(instanceId).state).toBe('revoked')
    expect(api.requests.filter((r) => r.url.href.startsWith(API))).toHaveLength(0)
  })
})

// ── Round trip ──────────────────────────────────────────────────

describe('round trip through the real update / complete / reopen actions', () => {
  it('closes the task at the source before completing it locally, pushes title and due date, and reopens', async () => {
    const a = api.add(task('a'))
    const h = makeHarness()
    await connect(h)
    const plugin = makePlugin(h)
    await plugin.importTasks(sourceId, config, ctx)
    const t = db.getTaskByExternalId(sourceId, 'a')!

    expect(await plugin.executeAction(PluginActionId.Complete, t, undefined, config, ctx)).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(taskPosts().map((r) => r.url.pathname)).toEqual(['/api/v1/tasks/a/close'])
    expect(a.checked).toBe(true)

    await plugin.exportUpdate(t, { title: 'Ship it', due_date: '2026-12-24', status: TaskStatus.NotStarted, labels: ['x'] }, config, ctx)
    // Reopen first (dedicated action), then the field update; labels are not round-tripped.
    expect(taskPosts().slice(1).map((r) => r.url.pathname)).toEqual(['/api/v1/tasks/a/reopen', '/api/v1/tasks/a'])
    // A calendar day, not a timestamp: the piece would send a timestamp as `due_date`, which Todoist refuses.
    expect(taskPosts()[2].body).toEqual({ content: 'Ship it', due_date: '2026-12-24' })
    expect(a).toMatchObject({ checked: false, content: 'Ship it' })
    expect(a.due?.date).toBe('2026-12-24')

    // 21x-only workflow states and descriptions are never sent.
    await plugin.exportUpdate(t, { status: TaskStatus.AgentWorking }, config, ctx)
    await plugin.exportUpdate(t, { description: 'not round-tripped' }, config, ctx)
    expect(taskPosts()).toHaveLength(3)

    expect(await plugin.importTasks(sourceId, config, ctx)).toEqual({ imported: 0, updated: 1, errors: [] })
    expect(db.getTaskByExternalId(sourceId, 'a')).toMatchObject({ title: 'Ship it', due_date: '2026-12-24T00:00:00.000Z', status: TaskStatus.NotStarted })
  })

  it('a 5xx on the field update after a successful close is retried later without dead-lettering', async () => {
    const a = api.add(task('a'))
    const h = makeHarness()
    await connect(h)
    const engine = makeEngine(h)
    await engine.sync(sourceId, config, ctx)
    let failures = 1
    api.overrides.push((req) => (req.method === 'POST' && req.url.pathname === '/api/v1/tasks/a' && failures-- > 0 ? json(503, { error: 'down' }) : undefined))
    const result = await engine.pushUpdate({ external_id: 'a' }, { title: 'Renamed', status: TaskStatus.Completed }, config, { queueOnFailure: true })
    expect(result).toMatchObject({ ok: false, queued: true })
    expect(a.checked).toBe(true)
    expect(a.content).toBe('Task a')
    now += 1000
    await engine.sync(sourceId, config, ctx)
    expect(a.content).toBe('Renamed')
    expect(readCursor(h.store.getSyncState(instanceId)?.cursor).pending).toEqual({})
    expect(h.store.listDeadLetters(instanceId)).toEqual([])
  })
})

// ── Disconnect ──────────────────────────────────────────────────

describe('disconnect', () => {
  it('forgets the token set and the client registration; the next sync asks to connect again', async () => {
    api.add(task('a'))
    const h = makeHarness()
    await connect(h)
    h.oauth.disconnect(instanceId)
    expect(h.oauth.status(instanceId)).toEqual({ state: 'none', expiresAt: null })
    expect(h.store.getInstance(instanceId)).toMatchObject({ authType: null, hasStoredAuth: false })
    const result = await makePlugin(h).importTasks(sourceId, config, ctx)
    expect(result.errors).toEqual(['Todoist is not connected: connect it in the task source settings.'])
    expect(filterRequests()).toHaveLength(0)
  })
})
