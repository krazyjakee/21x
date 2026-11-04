import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fitTextarea, resetFieldSizingSupportForTests, resetTextarea } from './textarea-autosize'

/** jsdom has no layout: model scrollHeight/clientHeight from the inline height. */
function field(contentHeight: () => number): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  const writes: string[] = []
  let height = ''
  Object.defineProperty(el.style, 'height', { get: () => height, set: (value: string) => { height = value; writes.push(value) } })
  Object.defineProperty(el, 'scrollHeight', { get: contentHeight })
  Object.defineProperty(el, 'clientHeight', { get: () => (height.endsWith('px') ? parseInt(height, 10) : 32) })
  return Object.assign(el, { writes })
}
const writes = (el: HTMLTextAreaElement) => (el as HTMLTextAreaElement & { writes: string[] }).writes

afterEach(() => { vi.unstubAllGlobals(); resetFieldSizingSupportForTests() })

describe('fitTextarea without CSS field-sizing', () => {
  beforeEach(() => { vi.stubGlobal('CSS', { supports: () => false }) })

  it('grows to the content without resetting to auto first', () => {
    let content = 32
    const el = field(() => content)
    el.value = 'one line'; fitTextarea(el, 120)
    expect(writes(el)).toEqual([])
    el.value = 'one line that wraps onto a second'; content = 56; fitTextarea(el, 120)
    expect(writes(el)).toEqual(['56px'])
  })

  it('caps the height', () => {
    const el = field(() => 400)
    el.value = 'x'.repeat(500); fitTextarea(el, 120)
    expect(el.style.height).toBe('120px')
  })

  it('measures from auto only when text got shorter', () => {
    let content = 80
    const el = field(() => content)
    el.value = 'long text'; fitTextarea(el, 120)
    el.value = 'long'; content = 32; fitTextarea(el, 120)
    expect(writes(el)).toEqual(['80px', 'auto', '32px'])
  })

  it('returns to one line when cleared or reset', () => {
    const el = field(() => 80)
    el.value = 'text'; fitTextarea(el, 120)
    el.value = ''; fitTextarea(el, 120)
    expect(el.style.height).toBe('auto')
    resetTextarea(el)
    expect(el.style.height).toBe('auto')
  })
})

describe('fitTextarea with CSS field-sizing', () => {
  it('leaves sizing to CSS', () => {
    vi.stubGlobal('CSS', { supports: (property: string, value: string) => property === 'field-sizing' && value === 'content' })
    const el = field(() => 400)
    el.value = 'x'.repeat(500); fitTextarea(el, 120); resetTextarea(el)
    expect(writes(el)).toEqual([])
  })
})
