import { describe, expect, it } from 'vitest'

describe('standalone portable test runtime', () => {
  it('runs under pinned Node without an Electron runtime', () => {
    expect(process.versions.electron).toBeUndefined()
    expect(process.version).toBe('v22.23.2')
    expect(process.versions.modules).toBe('127')
  })

  it('fails when a portable test imports Electron instead of supplying a mock host', async () => {
    await expect(import('electron')).rejects.toThrow('Electron runtime imports are forbidden in the standalone Tauri suite')
  })
})
