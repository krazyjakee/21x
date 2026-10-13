import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { createPortableDbFixture } from '../../test/helpers/portable-db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import {
  applyMobileAccessSettings, closeMobileApiServer, getMobileApiBinding,
  MOBILE_ACCESS_ENABLED_SETTING, setMobileApiDeps, startMobileApiServer, stopMobileApiServer
} from './mobile-api-server'

describe('portable mobile API ownership', () => {
  let source: ReturnType<typeof createPortableDbFixture>
  const token = 'fixture-mobile-owner-token'
  beforeEach(() => {
    source = createPortableDbFixture()
    source.db.createMobileSession('fixture-session', createHash('sha256').update(token).digest('hex'), 'fixture device')
    setMobileApiDeps({ db: source.db, agentManager: {} as never, githubManager: {} as never })
  })
  afterEach(async () => { await closeMobileApiServer(); source.rawDb.close() })
  const start = (agent: Parameters<typeof startMobileApiServer>[1] = {} as never) => startMobileApiServer(source.db, agent, {} as never, 0)

  it('coalesces startup and publishes only its actual native port', async () => {
    const first = start()
    expect(start()).toBe(first)
    const port = await first
    expect(port).toBeGreaterThan(0)
    expect(getMobileApiBinding()).toEqual({ host: '127.0.0.1', port })
  })

  it('joins cancellation during startup without stale binding publication or source revival', async () => {
    const result = expect(start()).rejects.toThrow('MOBILE_API_CLOSED')
    const stop = stopMobileApiServer()
    await closeMobileApiServer()
    await stop
    await result
    expect(getMobileApiBinding()).toBeNull()
    await expect(start()).rejects.toThrow('MOBILE_API_CLOSED')
    expect(source.rawDb.open).toBe(true)
  })

  it('retains a disconnected route through a failed close and its late SQLite write', async () => {
    const task = source.db.createTask(makeTask({ title: 'Original mobile fixture' }))!
    let finish!: () => void
    const held = new Promise<void>(done => { finish = done })
    let enter!: () => void
    const entered = new Promise<void>(done => { enter = done })
    const sendMessage = vi.fn(async () => {
      enter()
      await held
      source.db.updateTask(task.id, { title: 'Joined mobile write' })
      return { role: 'user' }
    })
    const port = await start({ sendMessage } as never)
    const abort = new AbortController()
    const request = fetch(`http://127.0.0.1:${port}/api/sessions/fixture-session/send`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'fixture prompt', taskId: task.id })
    }).catch(() => null)
    try {
      await entered
      abort.abort()
      await request
      await expect(closeMobileApiServer(5)).rejects.toThrow('MOBILE_API_SHUTDOWN_INCOMPLETE')
      expect(source.rawDb.open).toBe(true)
      expect(source.db.getTask(task.id)?.title).toBe('Original mobile fixture')
      let closed = false
      const retry = closeMobileApiServer().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      finish()
      await retry
      expect(source.db.getTask(task.id)?.title).toBe('Joined mobile write')
      expect(sendMessage).toHaveBeenCalledOnce()
      await expect(start()).rejects.toThrow('MOBILE_API_CLOSED')
    } finally { finish(); abort.abort(); await request; await closeMobileApiServer() }
  })

  it('joins actual WebSocket close and drops its binding before returning', async () => {
    const port = await start()
    const websocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
    websocket.on('error', () => {})
    const closed = once(websocket, 'close')
    try {
      await once(websocket, 'open')
      await closeMobileApiServer()
      await closed
      expect(websocket.readyState).toBe(WebSocket.CLOSED)
      expect(getMobileApiBinding()).toBeNull()
    } finally { websocket.terminate(); await closed }
  })

  it('cancels queued settings reconciliation before database reads or a new listener', async () => {
    source.db.setSetting(MOBILE_ACCESS_ENABLED_SETTING, 'true')
    const read = vi.spyOn(source.db, 'getSetting')
    const queued = applyMobileAccessSettings(0)
    await closeMobileApiServer()
    expect(await queued).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(getMobileApiBinding()).toBeNull()
  })

  it('validates deadlines before closing an active listener or its source', async () => {
    const port = await start()
    await expect(closeMobileApiServer(0)).rejects.toBeInstanceOf(RangeError)
    expect(await start()).toBe(port)
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
  })

  it('keeps a directly started source closed after an earlier completed stop', async () => {
    const other = createPortableDbFixture()
    try {
      setMobileApiDeps({ db: other.db, agentManager: {} as never, githubManager: {} as never })
      await start()
      await stopMobileApiServer()
      await closeMobileApiServer()
      await expect(start()).rejects.toThrow('MOBILE_API_CLOSED')
    } finally { other.rawDb.close() }
  })
})
