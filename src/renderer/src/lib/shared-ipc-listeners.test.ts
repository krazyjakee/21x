import { expect, it, vi } from 'vitest'
import { subscribe } from './shared-ipc-listeners'
it('shares one owner, retains identical callbacks independently, and disposes after the final lease', () => {
  let receive!: (data: number) => void
  const off = vi.fn(), callback = vi.fn(), registrar = vi.fn((handler: (data: number) => void) => { receive = handler; return off })
  const first = subscribe('test-counted', registrar, callback), second = subscribe('test-counted', registrar, callback)
  expect(registrar).toHaveBeenCalledOnce()
  receive(1); expect(callback.mock.calls).toEqual([[1], [1]])
  first(); first(); expect(off).not.toHaveBeenCalled()
  receive(2); expect(callback.mock.calls).toEqual([[1], [1], [2]])
  second(); expect(off).toHaveBeenCalledOnce()
  const replacement = subscribe('test-counted', registrar, callback)
  first(); expect(off).toHaveBeenCalledOnce(); expect(registrar).toHaveBeenCalledTimes(2)
  replacement(); expect(off).toHaveBeenCalledTimes(2)
})
it('does not claim an unavailable owner and retries registration when a real owner becomes available', () => {
  let available = false, receive!: (data: string) => void
  const off = vi.fn(), firstCallback = vi.fn(), nextCallback = vi.fn()
  const registrar = vi.fn((handler: (data: string) => void) => { if (!available) return undefined; receive = handler; return off })
  const first = subscribe('test-unavailable', registrar, firstCallback)
  expect(off).not.toHaveBeenCalled(); expect(firstCallback).not.toHaveBeenCalled()
  available = true
  const next = subscribe('test-unavailable', registrar, nextCallback)
  expect(registrar).toHaveBeenCalledTimes(2)
  receive('durable update'); expect(firstCallback).toHaveBeenCalledWith('durable update'); expect(nextCallback).toHaveBeenCalledWith('durable update')
  first(); next(); expect(off).toHaveBeenCalledOnce()
})
it('removes a failed registration before allowing a successful retry', () => {
  const failed = vi.fn(), successful = vi.fn(), off = vi.fn()
  expect(() => subscribe('test-registration-failure', () => { throw new Error('Disconnected') }, failed)).toThrow('Disconnected')
  const release = subscribe('test-registration-failure', handler => { handler('ready'); return off }, successful)
  expect(failed).not.toHaveBeenCalled(); expect(successful).toHaveBeenCalledWith('ready')
  release(); expect(off).toHaveBeenCalledOnce()
})
