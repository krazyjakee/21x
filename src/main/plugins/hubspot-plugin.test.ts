import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { HubSpotPlugin } from './hubspot-plugin'
import type { PluginContext } from './types'
import { TaskStatus } from '../../shared/constants'
import type { DatabaseManager, TaskRecord } from '../database'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import {
  HUBSPOT_ACCOUNT,
  HUBSPOT_CONTACTS,
  HUBSPOT_FILE_777,
  HUBSPOT_FILE_777_BYTES,
  HUBSPOT_FILE_777_SIGNED,
  HUBSPOT_FILE_777_SIGNED_URL,
  HUBSPOT_NOTE_9001,
  HUBSPOT_OWNERS,
  HUBSPOT_PIPELINES,
  HUBSPOT_SEARCH_INCREMENTAL,
  HUBSPOT_SEARCH_PAGE_1,
  HUBSPOT_SEARCH_PAGE_2,
  HUBSPOT_TICKET_101_NOTES
} from '../../../test/fixtures/hubspot-api'

// ── Fake HubSpot API behind global fetch ─────────────────────

interface RecordedRequest {
  method: string
  url: URL
  headers: Record<string, string>
  body?: unknown
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/**
 * Routes the HubSpot client's fetch calls to fixture responses and records
 * every request. Tests override single endpoints to simulate failures.
 */
class FakeHubSpotApi {
  readonly requests: RecordedRequest[] = []
  /** Search results by page cursor: 'first' for the initial page. */
  searchPages: Record<string, unknown> = { first: HUBSPOT_SEARCH_PAGE_1, 'cursor-2': HUBSPOT_SEARCH_PAGE_2 }
  /** Routes ("METHOD origin/path") whose response is replaced for the rest of the test. */
  private readonly permanent = new Map<string, () => Response>()
  /** Routes whose next responses are replaced, in order, before falling back to the fixture. */
  private readonly queued = new Map<string, Array<() => Response>>()

  /** Replace an endpoint's response for the rest of the test. */
  fail(route: string, status: number, message = 'simulated failure'): void {
    this.permanent.set(route, () => json({ status: 'error', message }, status))
  }

  /** Use a response once, then fall back to the fixture. */
  once(route: string, respond: () => Response): void {
    this.queued.set(route, [...(this.queued.get(route) ?? []), respond])
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    this.requests.push({ method, url, headers, body })

    const route = `${method} ${url.origin}${url.pathname}`
    const next = this.queued.get(route)?.shift()
    if (next) return next()
    const replaced = this.permanent.get(route)
    if (replaced) return replaced()
    return this.route(method, url, body)
  }

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname
    if (url.origin !== 'https://api.hubapi.com') {
      if (`${url.origin}${path}` === HUBSPOT_FILE_777_SIGNED_URL) {
        return new Response(new Uint8Array(HUBSPOT_FILE_777_BYTES), { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(`no fixture for ${method} ${url}`, { status: 500 })
    }

    if (method === 'GET' && path === '/account-info/v3/details') return json(HUBSPOT_ACCOUNT)
    if (method === 'GET' && path === '/crm/v3/pipelines/tickets') return json(HUBSPOT_PIPELINES)
    if (method === 'POST' && path === '/crm/v3/objects/tickets/search') {
      const after = (body as { after?: string } | undefined)?.after ?? 'first'
      const page = this.searchPages[after]
      return page ? json(page) : json({ status: 'error', message: `unknown cursor ${after}` }, 400)
    }

    let match = path.match(/^\/crm\/v3\/owners\/(\d+)$/)
    if (method === 'GET' && match) {
      const owner = HUBSPOT_OWNERS[match[1]]
      return owner ? json(owner) : json({ status: 'error', message: 'Owner not found' }, 404)
    }
    match = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/)
    if (method === 'GET' && match) {
      const contact = HUBSPOT_CONTACTS[match[1]]
      return contact ? json(contact) : json({ status: 'error', message: 'Contact not found' }, 404)
    }
    match = path.match(/^\/crm\/v4\/objects\/tickets\/(\d+)\/associations\/notes$/)
    if (method === 'GET' && match) return json(match[1] === '101' ? HUBSPOT_TICKET_101_NOTES : { results: [] })
    if (method === 'GET' && path === '/crm/v3/objects/notes/9001') return json(HUBSPOT_NOTE_9001)
    if (method === 'GET' && path === '/files/v3/files/777') return json(HUBSPOT_FILE_777)
    if (method === 'GET' && path === '/files/v3/files/777/signed-url') return json(HUBSPOT_FILE_777_SIGNED)

    return new Response(`no fixture for ${method} ${path}`, { status: 500 })
  }
}

// ── Setup ────────────────────────────────────────────────────

const TOKEN = 'pat-test-token'
const config = { auth_type: 'private_app', access_token: TOKEN }

let api: FakeHubSpotApi
let db: DatabaseManager
let ctx: PluginContext
let sourceId: string
let plugin: HubSpotPlugin
let attachmentsDir: string

beforeEach(() => {
  api = new FakeHubSpotApi()
  vi.stubGlobal('fetch', api.fetch)

  attachmentsDir = mkdtempSync(join(tmpdir(), '20x-hubspot-'))
  ;({ db } = createTestDb())
  db.getAttachmentsDir = vi.fn(() => attachmentsDir)
  ctx = { db }
  sourceId = db.createTaskSource({ name: 'HubSpot', plugin_id: 'hubspot', mcp_server_id: null })!.id
  plugin = new HubSpotPlugin()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(attachmentsDir, { recursive: true, force: true })
})

function taskFor(ticketId: string): TaskRecord | undefined {
  return db.getTaskByExternalId(sourceId, ticketId)
}

function requestsTo(pathname: string): RecordedRequest[] {
  return api.requests.filter((r) => r.url.pathname === pathname)
}

describe('HubSpotPlugin importTasks (first sync)', () => {
  it('authenticates every API call with the private app token', async () => {
    await plugin.importTasks(sourceId, config, ctx)

    const apiRequests = api.requests.filter((r) => r.url.origin === 'https://api.hubapi.com')
    expect(apiRequests.length).toBeGreaterThan(0)
    for (const request of apiRequests) {
      expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('searches without filters, follows pagination and only imports open tickets', async () => {
    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })

    const searches = requestsTo('/crm/v3/objects/tickets/search')
    expect(searches).toHaveLength(2)
    expect(searches[0].body).toMatchObject({ limit: 100 })
    expect(searches[0].body).not.toHaveProperty('filterGroups')
    expect(searches[1].body).toMatchObject({ after: 'cursor-2' })

    // Ticket 103 sits in a CLOSED stage: not imported on the first sync.
    expect(taskFor('103')).toBeUndefined()
    expect(taskFor('104')).toBeDefined()
  })

  it('maps ticket fields, owner, contact and pipeline stage onto the task', async () => {
    await plugin.importTasks(sourceId, config, ctx)

    const task = taskFor('101')!
    expect(task).toMatchObject({
      title: 'Login page returns 500',
      status: TaskStatus.AgentWorking,
      priority: 'high',
      assignee: 'Ana Lopez',
      due_date: '2026-10-01',
      labels: ['BUG'],
      source: 'HubSpot',
      source_id: sourceId,
      external_id: '101',
      output_fields: [{ id: 'resolution', name: 'Resolution', type: 'text', required: false, value: '' }]
    })
    expect(task.description).toContain('Steps to reproduce:')
    expect(task.description).toContain('**Status:** Support Pipeline → In progress')
    expect(task.description).toContain('**Contact:** Bob Chen')
    expect(task.description).toContain('**Category:** BUG')
    expect(task.description).toContain('[View in HubSpot](https://app-eu1.hubspot.com/contacts/12345/record/0-5/101)')

    expect(taskFor('102')).toMatchObject({
      title: 'Billing question',
      status: TaskStatus.NotStarted,
      priority: 'low',
      assignee: '',
      labels: []
    })
    expect(taskFor('102')!.description).not.toContain('**Contact:**')

    // No priority set: medium. "Waiting" stage: not started.
    expect(taskFor('104')).toMatchObject({ priority: 'medium', status: TaskStatus.NotStarted })
  })

  it('downloads note attachments into the task', async () => {
    await plugin.importTasks(sourceId, config, ctx)

    const task = taskFor('101')!
    expect(task.attachments).toHaveLength(1)
    const attachment = task.attachments[0] as unknown as Record<string, unknown>
    expect(attachment).toMatchObject({
      filename: 'screenshot.png',
      size: HUBSPOT_FILE_777_BYTES.length,
      hubspot_file_id: '777',
      hubspot_url: HUBSPOT_FILE_777_SIGNED_URL
    })
    const files = readdirSync(attachmentsDir)
    expect(files).toEqual([`${attachment.id}-screenshot.png`])
    expect(readFileSync(join(attachmentsDir, files[0])).equals(HUBSPOT_FILE_777_BYTES)).toBe(true)

    expect(taskFor('102')!.attachments).toEqual([])
  })

  it('keeps the task when an attachment download fails', async () => {
    api.fail(`GET ${HUBSPOT_FILE_777_SIGNED_URL}`, 500)

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })
    expect(taskFor('101')!.attachments).toEqual([])
    expect(existsSync(attachmentsDir) ? readdirSync(attachmentsDir) : []).toEqual([])
  })
})

describe('HubSpotPlugin importTasks (incremental sync)', () => {
  beforeEach(async () => {
    await plugin.importTasks(sourceId, config, ctx)
    db.updateTaskSourceLastSynced(sourceId)
    api.requests.length = 0
    api.searchPages = { first: HUBSPOT_SEARCH_INCREMENTAL }
  })

  it('searches for recently modified tickets and refreshes existing tasks', async () => {
    const before = { login: taskFor('101')!.id, billing: taskFor('102')!.id }

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 0, updated: 2, errors: [] })

    const [search] = requestsTo('/crm/v3/objects/tickets/search')
    expect(search.body).toMatchObject({
      filterGroups: [{ filters: [expect.objectContaining({ propertyName: 'hs_lastmodifieddate', operator: 'GTE' })] }]
    })

    // Closed at HubSpot: completed here, with the resolution carried over.
    expect(taskFor('101')).toMatchObject({
      id: before.login,
      status: TaskStatus.Completed,
      resolution: 'Fixed in v2',
      output_fields: [expect.objectContaining({ id: 'resolution', value: 'Fixed in v2' })]
    })
    // Renamed and assigned: refreshed in place, still open.
    expect(taskFor('102')).toMatchObject({
      id: before.billing,
      title: 'Billing question (updated)',
      assignee: 'Ana Lopez',
      status: TaskStatus.NotStarted
    })
  })

  it('does not import a ticket that was closed before it was ever seen', async () => {
    await plugin.importTasks(sourceId, config, ctx)
    expect(taskFor('105')).toBeUndefined()
  })

  it('does not download an attachment it already has', async () => {
    await plugin.importTasks(sourceId, config, ctx)

    expect(api.requests.filter((r) => r.url.href === HUBSPOT_FILE_777_SIGNED_URL)).toHaveLength(0)
    expect(taskFor('101')!.attachments).toHaveLength(1)
  })
})

describe('HubSpotPlugin importTasks error handling', () => {
  it('fails fast without a token', async () => {
    const result = await plugin.importTasks(sourceId, { auth_type: 'private_app' }, ctx)

    expect(result).toEqual({
      imported: 0,
      updated: 0,
      errors: ['Authentication failed. Please configure OAuth or provide a Private App token.']
    })
    expect(api.requests).toHaveLength(0)
  })

  it('reports an authentication failure and imports nothing', async () => {
    api.fail('GET https://api.hubapi.com/crm/v3/pipelines/tickets', 401)

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({
      imported: 0,
      updated: 0,
      errors: ['Import failed: HubSpot authentication failed. Please re-authenticate.']
    })
    expect(db.getTasks()).toHaveLength(0)
  })

  it('records a per-ticket error and carries on with the rest', async () => {
    // The ticket URL needs the account details; every ticket hits this.
    api.fail('GET https://api.hubapi.com/account-info/v3/details', 500, 'internal error')

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toMatch(/^Failed to import "Login page returns 500": HubSpot API error: 500/)
    expect(db.getTasks()).toHaveLength(0)
  })

  it('retries after a 429 and then succeeds', async () => {
    api.once(
      'GET https://api.hubapi.com/crm/v3/pipelines/tickets',
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
    )

    const result = await plugin.importTasks(sourceId, config, ctx)

    expect(result).toEqual({ imported: 3, updated: 0, errors: [] })
    // 429, retry, then the second (open-stage filter) lookup.
    expect(requestsTo('/crm/v3/pipelines/tickets')).toHaveLength(3)
  })
})
