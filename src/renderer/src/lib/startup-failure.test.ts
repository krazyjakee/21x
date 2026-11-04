import { describe, expect, it, vi } from 'vitest'
import { renderStartupFailure } from './startup-failure'

describe('renderStartupFailure', () => {
  it('shows the native explanation with a working Try again control', () => {
    const root = document.createElement('div')
    root.textContent = 'stale content'
    const retry = vi.fn()
    renderStartupFailure(root, 'Another desktop service owns this profile.', retry)
    expect(root.getAttribute('role')).toBe('alert')
    expect(root.textContent).toContain('21x couldn’t start')
    expect(root.textContent).toContain('Another desktop service owns this profile.')
    expect(root.textContent).not.toContain('stale content')
    root.querySelector('button')!.click()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('falls back to generic guidance when the service never answered', () => {
    const root = document.createElement('div')
    renderStartupFailure(root, undefined, vi.fn())
    expect(root.textContent).toContain('did not answer')
  })
})
