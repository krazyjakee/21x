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

  const stopButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find(button => button.textContent !== 'Try again')!
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

  it('offers no Try again when reloading cannot help', () => {
    const root = document.createElement('div')
    renderStartupFailure(root, 'Close 21x and open it again.', null)
    expect(root.querySelectorAll('button')).toHaveLength(0)
    renderStartupFailure(root, 'The folder is missing.', null, vi.fn(async () => true))
    expect(stopButton(root).textContent).toBe('Stop using the old folder')
    expect(root.querySelectorAll('button')).toHaveLength(1)
  })

  it('offers the old-folder action only when one is given', () => {
    const root = document.createElement('div')
    renderStartupFailure(root, 'Explanation', vi.fn())
    expect(root.querySelectorAll('button')).toHaveLength(1)
  })

  it('states what stopping costs before doing it, then tells the user to reopen', async () => {
    const root = document.createElement('div'), stop = vi.fn(async () => true)
    renderStartupFailure(root, 'The folder is missing.', null, stop)
    stopButton(root).click()
    expect(stop).not.toHaveBeenCalled()
    expect(root.textContent).toContain('reconnect it and reopen 21x instead')
    expect(root.textContent).toContain('workspaces, repositories and attachments will be empty')
    expect(root.textContent).toContain('will not go back to the old one')
    expect(root.textContent).toContain('stop preventing each other from running')
    expect(root.textContent).not.toContain('stays gone')
    stopButton(root).click()
    expect(stop).toHaveBeenCalledOnce()
    await settle()
    expect(root.textContent).toContain('Done. Close 21x and open it again.')
    expect(root.querySelectorAll('button')).toHaveLength(0)
  })

  it('says so when the folder came back, and when the action fails', async () => {
    for (const [stop, text] of [
      [async () => false, 'nothing was changed'],
      [async () => { throw new Error('private detail') }, 'That did not work']
    ] as const) {
      const root = document.createElement('div')
      renderStartupFailure(root, 'The folder is missing.', null, stop)
      stopButton(root).click()
      stopButton(root).click()
      await settle()
      expect(root.textContent).toContain(text)
      expect(root.textContent).not.toContain('private detail')
    }
  })

  it('falls back to generic guidance when the service never answered', () => {
    const root = document.createElement('div')
    renderStartupFailure(root, undefined, vi.fn())
    expect(root.textContent).toContain('did not answer')
  })
})
