import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  installCliTool: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(), spawn: mocks.spawn }))
vi.mock('./detect.js', async importOriginal => ({ ...await importOriginal<typeof import('./detect.js')>(), detectInstalledAgents: mocks.detect }))
vi.mock('./cli-tools.js', async importOriginal => ({ ...await importOriginal<typeof import('./cli-tools.js')>(), installCliTool: mocks.installCliTool }))

import { installAgent } from './install.js'

describe('installing RTK', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.installCliTool.mockResolvedValue({ success: true, error: null, newStatus: {} })
  })

  it('installs the binary and runs no RTK setup, because global hooks can bypass deny rules', async () => {
    mocks.detect.mockResolvedValue({ rtk: { installed: false }, claudeCode: { installed: true }, opencode: { installed: true } })

    const result = await installAgent('rtk', vi.fn())

    expect(mocks.installCliTool).toHaveBeenCalledWith('rtk', expect.any(Function))
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('does nothing when RTK is already installed', async () => {
    mocks.detect.mockResolvedValue({ rtk: { installed: true } })

    const result = await installAgent('rtk', vi.fn())

    expect(mocks.installCliTool).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })
})
