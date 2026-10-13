import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallMedia } from '@shared/commander-call'
import { bindPresenceLevel } from './presence-level'

let frames: Map<number, FrameRequestCallback>, count: number, intersect: IntersectionObserverCallback, reduced: boolean
beforeEach(() => {
  frames = new Map(); count = 0; reduced = false
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frames.set(++count, callback); return count }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => frames.delete(id)))
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback } observe() {} disconnect() {} })
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: reduced }) as MediaQueryList)
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function frame() { const [id, callback] = [...frames][0]; frames.delete(id); callback(0) }
function visibility(visible: boolean) { intersect([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver) }
function meter() {
  const element = document.createElement('div'); document.body.append(element)
  const media = { outputLevel: vi.fn(() => .3), inputLevel: vi.fn(() => .7) } as unknown as CallMedia
  return { element, media }
}
describe('visible Commander output level', () => {
  it('writes analyser-derived style directly and pauses offscreen until visible again', () => {
    const { element, media } = meter(), stop = bindPresenceLevel(element, media, 'output')
    expect(frames.size).toBe(0)
    visibility(true); frame()
    expect(element.style.getPropertyValue('--commander-level')).toBe('0.3')
    expect(media.outputLevel).toHaveBeenCalledOnce()
    visibility(false)
    expect(frames.size).toBe(0)
    expect(element.style.getPropertyValue('--commander-level')).toBe('0')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    visibility(true); expect(frames.size).toBe(1)
    stop(); expect(frames.size).toBe(0)
  })
  it('uses fixed reduced-motion steps and cancels the frame when the tile unmounts', () => {
    reduced = true
    const { element, media } = meter(), stop = bindPresenceLevel(element, media, 'input')
    visibility(true); frame()
    expect(element.style.getPropertyValue('--commander-level')).toBe('1')
    vi.mocked(media.inputLevel).mockReturnValue(.3); frame()
    expect(element.style.getPropertyValue('--commander-level')).toBe('0.5')
    vi.mocked(media.inputLevel).mockReturnValue(0); frame()
    expect(element.style.getPropertyValue('--commander-level')).toBe('0')
    element.remove(); frame(); expect(frames.size).toBe(0)
    stop()
  })
})
