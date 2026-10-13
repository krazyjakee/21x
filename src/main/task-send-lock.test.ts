import { describe, expect, it } from 'vitest'
import { serializeTaskSend } from './task-send-lock'

describe('task send ownership', () => {
  it('returns each callback result while preserving FIFO and independent task progress', async () => {
    const owner = {}
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = serializeTaskSend(owner, 'captain', async () => { order.push('first'); await gate; return { state: 'completed' } })
    const second = serializeTaskSend(owner, 'captain', async () => { order.push('second'); return null })
    expect(await serializeTaskSend(owner, 'other-task', async () => 'independent')).toBe('independent')
    expect(order).toEqual(['first'])
    release()
    expect(await first).toEqual({ state: 'completed' })
    expect(await second).toBeNull()
    expect(order).toEqual(['first', 'second'])
  })

  it('releases ownership after rejection so a queued legacy void send still runs', async () => {
    const owner = {}
    const failure = serializeTaskSend(owner, 'captain', async () => { throw new Error('Failed attempt') })
    let sent = false
    const next = serializeTaskSend(owner, 'captain', async () => { sent = true })
    await expect(failure).rejects.toThrow('Failed attempt')
    expect(await next).toBeUndefined()
    expect(sent).toBe(true)
  })
})
