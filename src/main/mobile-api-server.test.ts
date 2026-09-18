import { SyncManager } from './sync-manager'
import { finishSessionFeedback, updateTaskFromUser } from './session-feedback'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { WebSocket } from 'ws'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import {
  applyMobileAccessSettings,
  getMobileApiBinding,
  MOBILE_ACCESS_ENABLED_SETTING,
  MOBILE_LAN_ACCESS_SETTING,
  MOBILE_SESSION_IDLE_DAYS_SETTING,
  PAIR_RATE_LIMIT_MAX,
  setMobileApiDeps,
  startMobileApiServer,
  stopMobileApiServer
} from './mobile-api-server'

// We test the database-level route logic for the create task feature,
// which is the new functionality we're testing.

let db: DatabaseManager

describe('mobile-api-server: POST /api/tasks (create)', () => {
  beforeEach(() => {
    ;({ db } = createTestDb())
  })

  it('creates a task via DatabaseManager', () => {
    const task = db.createTask(makeTask({ title: 'Mobile Task', priority: 'high' }))

    expect(task).toBeDefined()
    expect(task!.title).toBe('Mobile Task')
    expect(task!.priority).toBe('high')
    expect(task!.status).toBe('not_started')
    expect(task!.id).toBeTruthy()
  })

  it('creates a task with all mobile form fields', () => {
    const task = db.createTask(makeTask({
      title: 'Full Mobile Task',
      description: 'Created from phone',
      type: 'coding',
      priority: 'critical',
      due_date: '2026-04-01T00:00:00.000Z',
      labels: ['mobile', 'urgent'],
      output_fields: [{ id: 'f1', name: 'Result', type: 'text' }],
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5'
    }))

    expect(task).toBeDefined()
    expect(task!.title).toBe('Full Mobile Task')
    expect(task!.description).toBe('Created from phone')
    expect(task!.type).toBe('coding')
    expect(task!.priority).toBe('critical')
    expect(task!.due_date).toBe('2026-04-01T00:00:00.000Z')
    expect(task!.labels).toEqual(['mobile', 'urgent'])
    expect(task!.output_fields).toEqual([{ id: 'f1', name: 'Result', type: 'text' }])
    expect(task!.is_recurring).toBe(true)
    expect(task!.recurrence_pattern).toBe('0 9 * * 1-5')
  })

  it('creates task with defaults for omitted fields', () => {
    const task = db.createTask({ title: 'Minimal Task' } as Parameters<typeof db.createTask>[0])

    expect(task).toBeDefined()
    expect(task!.title).toBe('Minimal Task')
    expect(task!.description).toBe('')
    expect(task!.type).toBe('general')
    expect(task!.priority).toBe('medium')
    expect(task!.status).toBe('not_started')
    expect(task!.labels).toEqual([])
    expect(task!.is_recurring).toBe(false)
  })

  it('created task is retrievable via getTask', () => {
    const task = db.createTask(makeTask({ title: 'Persisted' }))!
    const fetched = db.getTask(task.id)

    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(task.id)
    expect(fetched!.title).toBe('Persisted')
  })

  it('created task appears in getTasks list', () => {
    db.createTask(makeTask({ title: 'Task A' }))
    db.createTask(makeTask({ title: 'Task B' }))

    const tasks = db.getTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.map(t => t.title)).toContain('Task A')
    expect(tasks.map(t => t.title)).toContain('Task B')
  })

  it('created task can be updated', () => {
    const task = db.createTask(makeTask({ title: 'Original' }))!
    const updated = db.updateTask(task.id, { title: 'Modified', priority: 'high' })

    expect(updated!.title).toBe('Modified')
    expect(updated!.priority).toBe('high')
  })
})

describe('mobile-api-server: auth', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  it('starts without storing any plaintext credentials', async () => {
    const { db } = createTestDb()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await startMobileApiServer(
      db,
      {} as never,
      {} as never,
      0
    )

    // Old single-token auth is gone — no mobile_auth_token should be stored
    const legacyToken = db.getSetting('mobile_auth_token')
    expect(legacyToken).toBeFalsy()

    // No session tokens should appear in logs (sessions are created on pairing, not startup)
    const sessions = db.getMobileSessions()
    expect(sessions).toHaveLength(0)

    const logs = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(logs).toContain('[MobileAPI] Started on port')
  })
})

describe('mobile-api-server: session tokens', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  async function startWithSession() {
    const { db } = createTestDb()
    const token = 'valid-session-token'
    db.createMobileSession('session-1', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0)
    return { db, token, base: `http://127.0.0.1:${port}` }
  }

  it.each([
    ['no token', undefined],
    ['an unknown token', 'Bearer not-a-session'],
    ['a malformed header', 'valid-session-token']
  ])('rejects API requests with %s', async (_label, authorization) => {
    const { base } = await startWithSession()

    const response = await fetch(`${base}/api/tasks`, { headers: authorization ? { Authorization: authorization } : {} })

    expect(response.status).toBe(401)
  })

  it('rejects a token once its session is revoked', async () => {
    const { db, token, base } = await startWithSession()
    db.revokeMobileSession('session-1')

    const response = await fetch(`${base}/api/tasks`, { headers: { Authorization: `Bearer ${token}` } })

    expect(response.status).toBe(401)
  })

  it('never sends task source credentials to the phone', async () => {
    const { db, token, base } = await startWithSession()
    db.createTaskSource({ name: 'HubSpot', plugin_id: 'hubspot', mcp_server_id: null, config: { access_token: 'pat-secret' } })

    const response = await fetch(`${base}/api/task-sources`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('HubSpot')
    expect(body).not.toContain('pat-secret')
  })
})

describe('mobile-api-server: POST /api/tasks over HTTP', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  async function start() {
    const { db } = createTestDb()
    const token = 'create-token'
    db.createMobileSession('create-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0)
    const post = (path: string, body: string) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body
    })
    return { db, post }
  }

  it('does not let a phone set a task source link', async () => {
    const { db, post } = await start()
    const source = db.createTaskSource({ name: 'Linear', plugin_id: 'linear', mcp_server_id: null })!

    const response = await post('/api/tasks', JSON.stringify({ title: 'Phone task', source_id: source.id, external_id: 'EXT-1', source: 'Linear' }))
    const task = await response.json() as { id: string }

    expect(response.status).toBe(200)
    expect(db.getTask(task.id)).toMatchObject({ title: 'Phone task', source_id: null, external_id: null, source: 'local' })
  })

  it('answers a malformed JSON body with 400', async () => {
    const { post } = await start()

    const response = await post('/api/tasks', '{not json')

    expect(response.status).toBe(400)
  })
})

describe('mobile-api-server: POST /api/tasks/:id coordinator wake-up', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  function startServer(agentManager: unknown) {
    const { db } = createTestDb()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // The server resolves the requested port, so pick a free-ish high port
    // instead of 0 (which would make the caller resolve port 0).
    return { db, logSpy, portPromise: startMobileApiServer(db, agentManager as never, {} as never, 0) }
  }

  function pairToken(db: DatabaseManager): string {
    const token = 'test-pairing-token'
    const hash = createHash('sha256').update(token).digest('hex')
    db.createMobileSession('sess-1', hash, 'test-device')
    return token
  }

  it('wakes the parent coordinator when a phone moves a subtask to ready_for_review', async () => {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent }
    const { db, portPromise } = startServer(agentManager)
    const port = await portPromise

    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    db.updateTask(subtask.id, { status: 'agent_working' })

    const token = pairToken(db)
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready_for_review' })
    })
    expect(res.status).toBe(200)

    expect(notifyParent).toHaveBeenCalledWith(parent.id, subtask.id)
  })

  it('does not wake the parent for a non-terminal or unchanged status from a phone', async () => {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent }
    const { db, portPromise } = startServer(agentManager)
    const port = await portPromise

    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!

    const token = pairToken(db)

    // Non-terminal transition
    await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'agent_working' })
    })
    expect(notifyParent).not.toHaveBeenCalled()

    // Title-only update
    await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' })
    })
    expect(notifyParent).not.toHaveBeenCalled()
  })
})

describe('mobile-api-server: source completion action', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  it('completes manually without calling the source and preserves the choice after a refresh', async () => {
    const { db } = createTestDb()
    const source = db.createTaskSource({ name: 'Session Feedback', plugin_id: 'linear', mcp_server_id: null })!
    const task = db.createTask(makeTask({ source_id: source.id, external_id: 'remote-feedback', source: 'Session Feedback' }))!
    const executeAction = vi.fn()
    const token = 'test-manual-token'
    db.createMobileSession('manual-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0, { executeAction } as never)
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/complete`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completeAtSource: false })
    })
    expect(response.status).toBe(200)
    expect(db.getTask(task.id)).toMatchObject({status: 'completed', complete_at_source: false})
    expect(executeAction).not.toHaveBeenCalled()
    db.updateTask(task.id, {status: 'not_started', title: 'Refreshed title'}, 'task-source')
    expect(db.getTask(task.id)).toMatchObject({status: 'completed', title: 'Refreshed title', complete_at_source: false})
    db.close()
  })

  it.each(['approve', undefined])('sends the selected action %s to the source', async (action) => {
    const { db } = createTestDb()
    const source = db.createTaskSource({ name: 'Session Feedback', plugin_id: 'linear', mcp_server_id: null })!
    const task = db.createTask(makeTask({ source_id: source.id, source: 'Session Feedback',
      output_fields: action ? [{ id: 'action', name: 'Action', type: 'text', value: action }] : [] }))!
    const executeAction = vi.fn().mockResolvedValue({ success: true })
    const token = 'test-completion-token'
    db.createMobileSession('completion-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0, { executeAction } as never)
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/complete`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    })
    expect(response.status).toBe(200)
    expect(executeAction).toHaveBeenCalledWith(action || 'complete', expect.objectContaining({ id: task.id }), undefined, source.id)
    db.close()
  })

  it.each([true, false])('cancels pending learning before completing with source choice %s', async (completeAtSource) => {
    const { db } = createTestDb()
    const source = db.createTaskSource({ name: 'Session Feedback', plugin_id: 'notion', mcp_server_id: null })!
    const agent = db.createAgent({name: 'Learning agent', server_url: '', config: {}, is_default: false})!
    const task = db.createTask(makeTask({source_id: source.id, external_id: 'remote-feedback', source: 'Session Feedback'}))!
    db.updateTask(task.id, {agent_id: agent.id})
    updateTaskFromUser(db, task.id, {status: 'agent_learning', feedback_rating: 5, complete_at_source: completeAtSource})
    const executeAction = vi.fn().mockResolvedValue({success: true, taskUpdate: {status: 'completed'}})
    const sync = new SyncManager(db, {get: () => ({executeAction})} as never)
    const token = `learning-skip-${completeAtSource}`
    db.createMobileSession(`learning-skip-session-${completeAtSource}`, createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0, sync)
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/complete`, {
      method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({completeAtSource})
    })
    expect(response.status).toBe(200)
    expect(db.getTask(task.id)?.status).toBe('completed')
    await finishSessionFeedback(db, sync, task.id)
    expect(executeAction).toHaveBeenCalledTimes(completeAtSource ? 1 : 0)
    db.close()
  })
})


describe('mobile API: all four feedback/source combinations', () => {
  afterEach(() => { stopMobileApiServer(); vi.restoreAllMocks() })
  it.each([
    ['submit', true], ['submit', false], ['skip', true], ['skip', false]
  ] as const)('%s with source action %s', async (feedback, completeAtSource) => {
    const {db} = createTestDb()
    const source = db.createTaskSource({name: 'dmitry ai tasks', plugin_id: 'notion', mcp_server_id: null})!
    const agent = db.createAgent({name: 'Learning agent', server_url: '', config: {}, is_default: false})!
    const task = db.createTask(makeTask({source_id: source.id, external_id: 'notion-page', source: 'Notion', status: 'ready_for_review'}))!
    db.updateTask(task.id, {agent_id: agent.id})
    const notionRecord = {status: 'open'}
    const sourceAction = vi.fn(async () => {
      notionRecord.status = 'closed'
      return {success: true, taskUpdate: {status: 'completed'}}
    })
    const sync = new SyncManager(db, {get: () => ({executeAction: sourceAction})} as never)
    const token = 'four-cases-token'
    db.createMobileSession('four-cases-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0, sync)
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}${feedback === 'skip' ? '/complete' : ''}`, {
      method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(feedback === 'skip' ? {completeAtSource} : {
        status: 'agent_learning', feedback_rating: 4, feedback_comment: 'Useful', complete_at_source: completeAtSource
      })
    })
    expect(response.status).toBe(200)
    if (feedback === 'submit') {
      expect(db.getTask(task.id)?.status).toBe('agent_learning')
      expect(sourceAction).not.toHaveBeenCalled()
      await finishSessionFeedback(db, sync, task.id)
    }
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(sourceAction).toHaveBeenCalledTimes(completeAtSource ? 1 : 0)
    expect(notionRecord.status).toBe(completeAtSource ? 'closed' : 'open')
    db.close()
  })
})

describe('mobile-api-server: pairing rate limit', () => {
  afterEach(async () => {
    await stopMobileApiServer()
    vi.restoreAllMocks()
  })

  async function start() {
    const { db } = createTestDb()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0)
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    return { db, port, post }
  }

  it('answers 429 once the global pairing budget is spent, across both pairing endpoints', async () => {
    const { post } = await start()

    for (let i = 0; i < PAIR_RATE_LIMIT_MAX; i++) {
      const response = i % 2 === 0
        ? await post('/api/auth/pair/initiate', { code: `bogus-${i}` })
        : await post('/api/auth/pair/verify', { pairCodeId: `bogus-${i}`, pin: '000000' })
      expect(response.status).toBe(401)
    }

    const limitedInitiate = await post('/api/auth/pair/initiate', { code: 'bogus' })
    expect(limitedInitiate.status).toBe(429)
    expect(limitedInitiate.headers.get('retry-after')).toBeTruthy()
    const limitedVerify = await post('/api/auth/pair/verify', { pairCodeId: 'bogus', pin: '000000' })
    expect(limitedVerify.status).toBe(429)
  })

  it('rejects a valid init code while rate limited and accepts it once the window passes', async () => {
    const { db, post } = await start()
    db.setSetting('mobile_init_code_real', '1')
    db.setSetting('mobile_init_code_real_exp', String(Math.floor(Date.now() / 1000) + 300))
    for (let i = 0; i < PAIR_RATE_LIMIT_MAX; i++) await post('/api/auth/pair/initiate', { code: `bogus-${i}` })

    expect((await post('/api/auth/pair/initiate', { code: 'real' })).status).toBe(429)
    // The init code is still unused: a limited request never reaches the handler.
    expect(db.getSetting('mobile_init_code_real')).toBe('1')

    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000)
    expect((await post('/api/auth/pair/initiate', { code: 'real' })).status).toBe(200)
  })

  it('does not count authenticated API traffic against the pairing budget', async () => {
    const { db, port, post } = await start()
    const token = 'rate-limit-token'
    db.createMobileSession('rate-session', createHash('sha256').update(token).digest('hex'), 'test-device')

    for (let i = 0; i < PAIR_RATE_LIMIT_MAX + 5; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { Authorization: `Bearer ${token}` } })
      expect(response.status).toBe(200)
    }
    expect((await post('/api/auth/pair/initiate', { code: 'bogus' })).status).toBe(401)
  })
})

describe('mobile-api-server: session idle expiry', () => {
  afterEach(async () => {
    await stopMobileApiServer()
    vi.restoreAllMocks()
  })

  const DAY_MS = 86_400_000

  async function startWithSession() {
    const { db } = createTestDb()
    const token = 'idle-token'
    db.createMobileSession('idle-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0)
    const get = () => fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { Authorization: `Bearer ${token}` } })
    return { db, get }
  }

  it('keeps a session that was used within the default 7 days', async () => {
    const { get } = await startWithSession()
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * DAY_MS)

    expect((await get()).status).toBe(200)
  })

  it('rejects and revokes a session idle for longer than the default 7 days', async () => {
    const { db, get } = await startWithSession()
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 8 * DAY_MS)

    expect((await get()).status).toBe(401)
    expect(db.getMobileSessions()).toHaveLength(0)
    // Going back in time does not resurrect it.
    vi.spyOn(Date, 'now').mockReturnValue(realNow)
    expect((await get()).status).toBe(401)
  })

  it('honours a configured idle period', async () => {
    const { db, get } = await startWithSession()
    db.setSetting(MOBILE_SESSION_IDLE_DAYS_SETTING, '1')
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * DAY_MS)

    expect((await get()).status).toBe(401)
  })

  it('refuses the WebSocket upgrade for an expired session', async () => {
    const { db } = createTestDb()
    const token = 'idle-ws-token'
    db.createMobileSession('idle-ws-session', createHash('sha256').update(token).digest('hex'), 'test-device')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const port = await startMobileApiServer(db, {} as never, {} as never, 0)
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 8 * DAY_MS)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('rejected'))
    })
    ws.close()

    expect(outcome).toBe('rejected')
    expect(db.getMobileSessions()).toHaveLength(0)
  })
})

describe('mobile-api-server: mobile access settings', () => {
  afterEach(async () => {
    await stopMobileApiServer()
    vi.restoreAllMocks()
  })

  function setup() {
    const { db } = createTestDb()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setMobileApiDeps({ db, agentManager: {} as never, githubManager: {} as never })
    return db
  }

  it('does not listen when mobile access is off (the default)', async () => {
    setup()

    expect(await applyMobileAccessSettings(0)).toBeNull()
    expect(getMobileApiBinding()).toBeNull()
  })

  it('binds to 127.0.0.1 unless LAN access is opted into, and rebinds on change', async () => {
    const db = setup()
    db.setSetting(MOBILE_ACCESS_ENABLED_SETTING, 'true')

    const port = await applyMobileAccessSettings(0)
    expect(port).toBeGreaterThan(0)
    expect(getMobileApiBinding()).toEqual({ host: '127.0.0.1', port })
    expect((await fetch(`http://127.0.0.1:${port}/api/tasks`)).status).toBe(401)

    db.setSetting(MOBILE_LAN_ACCESS_SETTING, 'true')
    const lanPort = await applyMobileAccessSettings(0)
    expect(getMobileApiBinding()).toEqual({ host: '0.0.0.0', port: lanPort })

    db.setSetting(MOBILE_ACCESS_ENABLED_SETTING, 'false')
    expect(await applyMobileAccessSettings(0)).toBeNull()
    expect(getMobileApiBinding()).toBeNull()
    await expect(fetch(`http://127.0.0.1:${lanPort}/api/tasks`)).rejects.toThrow()
  })
})
