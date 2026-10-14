import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ start: vi.fn(async () => 'https://synthetic.trycloudflare.com'), stop: vi.fn(async () => {}), owner: { url: null as string | null, active: false } }))
vi.mock('./tunnel-manager-core', () => ({ TunnelManagerCore: class {
  start = mocks.start
  stop = mocks.stop
  get url() { return mocks.owner.url }
  get active() { return mocks.owner.active }
} }))
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }))
import { getTunnelUrl, isTunnelActive, startTunnel, stopTunnel, stopTunnelAcknowledged } from './tunnel-manager'
describe('Electron tunnel compatibility wrapper', () => {
  it('retains the original control results and delegates actual close to the same portable owner', async () => {
    expect(getTunnelUrl()).toBeNull()
    expect(await startTunnel(20620)).toBe('https://synthetic.trycloudflare.com')
    expect(mocks.start).toHaveBeenCalledWith(20620)
    mocks.owner.url = 'https://synthetic.trycloudflare.com'; mocks.owner.active = true
    expect(isTunnelActive()).toBe(true); expect(getTunnelUrl()).toBe(mocks.owner.url)
    expect(stopTunnel()).toBeUndefined()
    await stopTunnelAcknowledged(); expect(mocks.stop).toHaveBeenCalledTimes(2)
  })
})
