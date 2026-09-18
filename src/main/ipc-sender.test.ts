import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isTrustedSender, assertTrustedSender } from './ipc-sender'

const APP_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

function event(overrides: Record<string, unknown> = {}): Parameters<typeof isTrustedSender>[0] {
  return {
    sender: { getType: () => 'window' },
    senderFrame: { url: APP_URL, parent: null },
    ...overrides
  } as Parameters<typeof isTrustedSender>[0]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isTrustedSender', () => {
  it('accepts the main window top frame', () => {
    expect(isTrustedSender(event())).toBe(true)
  })

  it('rejects a webview guest', () => {
    expect(isTrustedSender(event({ sender: { getType: () => 'webview' } }))).toBe(false)
  })

  it('rejects a sub-frame of the main window', () => {
    expect(isTrustedSender(event({ senderFrame: { url: APP_URL, parent: {} } }))).toBe(false)
  })

  it('rejects a frame that is not the app URL', () => {
    expect(isTrustedSender(event({ senderFrame: { url: 'https://evil.example/', parent: null } }))).toBe(false)
    expect(isTrustedSender(event({ senderFrame: { url: 'file:///tmp/evil.html', parent: null } }))).toBe(false)
  })

  it('rejects an event with no sender frame (destroyed or detached)', () => {
    expect(isTrustedSender(event({ senderFrame: null }))).toBe(false)
  })
})

describe('assertTrustedSender', () => {
  it('passes for the main window', () => {
    expect(() => assertTrustedSender(event(), 'terminal:create')).not.toThrow()
  })

  it('throws for anything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => assertTrustedSender(event({ sender: { getType: () => 'webview' } }), 'terminal:create'))
      .toThrow(/terminal:create/)
  })
})
