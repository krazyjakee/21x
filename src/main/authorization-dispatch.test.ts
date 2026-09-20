import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { prepareAuthorizationDispatch, recordHumanAuthorization, revokeAuthorization, taskAuthorization } from './authorization'
import { captureAuthorizationSnapshot, sendPreservingAuthorization, sendWithAuthorization } from './authorization-dispatch'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let db: ReturnType<typeof createTestDb>['db']
let projectId: string
let taskId: string
let counter: number
beforeEach(() => {
  db = createTestDb().db
  projectId = db.createProject({ name: '21x' })!.id
  taskId = db.getCoordinatorTask(projectId)!.id
  counter = 0
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

function dispatch() {
  const key = `human-${++counter}`
  const text = 'Create tasks'
  const root = recordHumanAuthorization(db, { messageId: key, text, at: Date.now(), source: 'project-chat', projectId, taskId })
  const seq = prepareAuthorizationDispatch(db, { key, taskId, text, messageId: key })
  return { root, seq }
}

describe('adapter authorization boundary', () => {
  it('withholds new authority from old tools until backend idle is confirmed', async () => {
    const { root, seq } = dispatch()
    const idle = deferred<unknown>()
    const status = vi.fn().mockResolvedValueOnce({ type: 'busy' }).mockResolvedValueOnce({ type: 'idle' })
    const send = vi.fn(async () => { expect(taskAuthorization(db, taskId).origin!.id).toBe(root.id) })
    const wait = vi.fn(() => idle.promise)
    const pending = sendWithAuthorization(db, seq, status, send, wait)
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
    expect(send).not.toHaveBeenCalled()
    expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
    idle.resolve(undefined)
    await pending
    expect(send).toHaveBeenCalledOnce()
  })

  it('rejects the generation superseded during an asynchronous status/config boundary', async () => {
    const first = dispatch()
    const idle = deferred<{ type: string }>()
    const send = vi.fn(async () => {})
    const pending = sendWithAuthorization(db, first.seq, () => idle.promise, send)
    const rejection = expect(pending).rejects.toThrow('Stale')
    const second = dispatch()
    idle.resolve({ type: 'idle' })
    await rejection
    expect(send).not.toHaveBeenCalled()
    await sendWithAuthorization(db, second.seq, async () => ({ type: 'idle' }), send)
    expect(taskAuthorization(db, taskId).origin!.id).toBe(second.root.id)
  })

  it('serializes concurrent sends even when sendPrompt awaits before marking itself busy', async () => {
    const first = dispatch()
    const accepted = deferred<void>()
    const sendFirst = vi.fn(() => accepted.promise)
    const one = sendWithAuthorization(db, first.seq, async () => ({ type: 'idle' }), sendFirst)
    await vi.waitFor(() => expect(sendFirst).toHaveBeenCalledOnce())
    const second = dispatch()
    const idle = deferred<unknown>()
    const status = vi.fn().mockResolvedValueOnce({ type: 'busy' }).mockResolvedValueOnce({ type: 'idle' })
    const sendSecond = vi.fn(async () => {})
    const wait = vi.fn(() => idle.promise)
    const two = sendWithAuthorization(db, second.seq, status, sendSecond, wait)
    await Promise.resolve()
    expect(status).not.toHaveBeenCalled()
    expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
    accepted.resolve(undefined)
    await one
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
    expect(sendSecond).not.toHaveBeenCalled()
    idle.resolve(undefined)
    await two
    expect(sendSecond).toHaveBeenCalledOnce()
  })

  it('serializes startup/nudge sends and rejects an older captured continuation', async () => {
    const first = dispatch()
    await sendWithAuthorization(db, first.seq, async () => ({ type: 'idle' }), async () => {})
    const snapshot = captureAuthorizationSnapshot(db, taskId)
    const accepted = deferred<void>()
    const oldSend = vi.fn(() => accepted.promise)
    const continuation = sendPreservingAuthorization(db, taskId, snapshot, oldSend)
    await vi.waitFor(() => expect(oldSend).toHaveBeenCalledOnce())
    const next = dispatch()
    const status = vi.fn(async () => ({ type: 'idle' }))
    const send = vi.fn(async () => {})
    const newTurn = sendWithAuthorization(db, next.seq, status, send)
    await Promise.resolve()
    expect(status).not.toHaveBeenCalled()
    accepted.resolve(undefined)
    await continuation
    await newTurn
    await expect(sendPreservingAuthorization(db, taskId, snapshot, oldSend)).rejects.toThrow('Stale authorization continuation')
  })

  it('rejects nudges captured during an inactive reservation after it becomes active', async () => {
    const next = dispatch()
    const snapshot = captureAuthorizationSnapshot(db, taskId)
    const status = deferred<{ type: string }>()
    const send = vi.fn(async () => {})
    const newTurn = sendWithAuthorization(db, next.seq, () => status.promise, send)
    const nudge = vi.fn(async () => {})
    const continuation = sendPreservingAuthorization(db, taskId, snapshot, nudge)
    const rejected = expect(continuation).rejects.toThrow('Stale authorization continuation')
    expect(nudge).not.toHaveBeenCalled()
    status.resolve({ type: 'idle' })
    await newTurn
    await rejected
    expect(nudge).not.toHaveBeenCalled()
  })

  it('clears authority when adapter acceptance fails and releases the send lock', async () => {
    const first = dispatch()
    await expect(sendWithAuthorization(db, first.seq, async () => ({ type: 'idle' }), async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
    expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
    const next = dispatch()
    await sendWithAuthorization(db, next.seq, async () => ({ type: 'idle' }), async () => {})
    expect(taskAuthorization(db, taskId).origin!.id).toBe(next.root.id)
  })

  it.each(['revoked', 'expired'])('rechecks %s authorization after the final await', async reason => {
    const start = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(start)
    const { root, seq } = dispatch()
    const idle = deferred<{ type: string }>()
    const send = vi.fn(async () => {})
    const pending = sendWithAuthorization(db, seq, () => idle.promise, send)
    const rejection = expect(pending).rejects.toThrow('expired or was revoked')
    if (reason === 'revoked') revokeAuthorization(db, root.id, 'User cancelled')
    else vi.spyOn(Date, 'now').mockReturnValue(root.expiresAt)
    idle.resolve({ type: 'idle' })
    await rejection
    expect(send).not.toHaveBeenCalled()
    expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
  })

  it.each(['after-status', 'before-activation', 'before-send'] as const)(
    'fails closed when ownership is withdrawn at the %s boundary',
    async blockedStage => {
      const { seq } = dispatch()
      const send = vi.fn(async () => {})
      const seen: string[] = []
      await expect(sendWithAuthorization(
        db,
        seq,
        async () => ({ type: 'idle' }),
        send,
        undefined,
        undefined,
        stage => {
          seen.push(stage)
          if (stage === blockedStage) throw new Error('Stop owns this session generation')
        }
      )).rejects.toThrow('Stop owns this session generation')
      expect(seen).toContain(blockedStage)
      expect(send).not.toHaveBeenCalled()
      expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
    }
  )

  it.each(['error', 'waiting_approval', 'unknown'])('does not treat backend %s as confirmed idle', async type => {
    const { seq } = dispatch()
    const send = vi.fn(async () => {})
    await expect(sendWithAuthorization(db, seq, async () => ({ type }), send)).rejects.toThrow('Cannot authorize')
    expect(send).not.toHaveBeenCalled()
  })

  it('times out busy backends without activating authority', async () => {
    const { seq } = dispatch()
    const send = vi.fn(async () => {})
    await expect(sendWithAuthorization(db, seq, async () => ({ type: 'busy' }), send, async () => {}, 0)).rejects.toThrow('did not become idle')
    expect(send).not.toHaveBeenCalled()
    expect(taskAuthorization(db, taskId).effectivePermissions).toEqual([])
  })
})
