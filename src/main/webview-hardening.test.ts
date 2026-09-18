import { describe, it, expect } from 'vitest'
import { hardenWebviewPreferences } from './webview-hardening'

describe('hardenWebviewPreferences', () => {
  it('strips preload and preloadURL from the attaching webview', () => {
    const webPreferences = {
      preload: '/tmp/evil-preload.js',
      preloadURL: 'file:///tmp/evil-preload.js'
    } as Parameters<typeof hardenWebviewPreferences>[0]

    hardenWebviewPreferences(webPreferences)

    expect('preload' in webPreferences).toBe(false)
    expect('preloadURL' in webPreferences).toBe(false)
  })

  it('forces node integration off and context isolation on', () => {
    const webPreferences = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false
    } as Parameters<typeof hardenWebviewPreferences>[0]

    hardenWebviewPreferences(webPreferences)

    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
  })

  it('also scrubs the raw webview attributes', () => {
    const webPreferences = {} as Parameters<typeof hardenWebviewPreferences>[0]
    const params: Record<string, unknown> = {
      src: 'https://example.com',
      preload: 'file:///tmp/evil-preload.js',
      preloadurl: 'file:///tmp/evil-preload.js',
      nodeintegration: 'true',
      webviewtag: 'true',
      contextisolation: 'false'
    }

    hardenWebviewPreferences(webPreferences, params)

    expect('preload' in params).toBe(false)
    expect('preloadurl' in params).toBe(false)
    expect('nodeintegration' in params).toBe(false)
    expect('webviewtag' in params).toBe(false)
    expect('contextisolation' in params).toBe(false)
    // The page the panel wanted still loads.
    expect(params.src).toBe('https://example.com')
  })
})
