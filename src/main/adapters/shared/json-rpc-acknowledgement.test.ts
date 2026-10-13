import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { writeJsonRpcAcknowledged } from './json-rpc'

function fixture() {
  let acknowledge!: (error?: Error | null) => void
  const frames: string[] = []
  const stdin = new Writable({ write(chunk, _encoding, callback) { frames.push(chunk.toString()); acknowledge = callback } })
  const process = Object.assign(new EventEmitter(), { stdin }) as unknown as ChildProcess
  return { peer: { process }, stdin, frames, finish: (error?: Error) => acknowledge(error) }
}

it('keeps a human reply pending until the actual writable callback acknowledges its bytes', async () => {
  const f = fixture(), settled = vi.fn()
  const reply = writeJsonRpcAcknowledged(f.peer, { id: 42, result: { decision: 'accept' } }, 'fixture')
  void reply.then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(f.frames).toEqual(['{"id":42,"result":{"decision":"accept"}}\n'])
  f.finish(); await reply
  expect(settled).toHaveBeenCalledOnce()
  expect(f.stdin.listenerCount('close')).toBe(0)
})

it('refuses an asynchronously failed pipe write without claiming success', async () => {
  const f = fixture()
  const reply = writeJsonRpcAcknowledged(f.peer, { id: 42 }, 'fixture')
  const rejected = expect(reply).rejects.toThrow('EPIPE')
  f.finish(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
  await rejected
})

it('releases a pending raw reply only after the actual pipe closes', async () => {
  const f = fixture()
  const reply = writeJsonRpcAcknowledged(f.peer, { id: 42 }, 'fixture')
  const rejected = expect(reply).rejects.toThrow('closed before acknowledgement')
  f.stdin.destroy(); await rejected
  expect(f.stdin.listenerCount('close')).toBe(0)
})
