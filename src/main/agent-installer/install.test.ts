import { describe, expect, it } from 'vitest'

import { getNodejsAssetName } from './nodejs.js'
import { selectGhMacAsset, selectRtkAsset } from './cli-tools.js'
import { getRtkInitPlans } from './rtk-integrations.js'

describe('getNodejsAssetName', () => {
  it('uses the universal macOS pkg name without an arch suffix', () => {
    expect(getNodejsAssetName('darwin', 'arm64', 'v22.20.0')).toBe('node-v22.20.0.pkg')
    expect(getNodejsAssetName('darwin', 'x64', 'v22.20.0')).toBe('node-v22.20.0.pkg')
  })

  it('retains platform-specific naming for Windows and Linux', () => {
    expect(getNodejsAssetName('win32', 'arm64', 'v22.20.0')).toBe('node-v22.20.0-arm64.msi')
    expect(getNodejsAssetName('linux', 'x64', 'v22.20.0')).toBe('node-v22.20.0-linux-x64.tar.xz')
  })
})

describe('selectGhMacAsset', () => {
  it('prefers the macOS zip asset when present', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_macOS_arm64.pkg', browser_download_url: 'https://example.com/gh.pkg' },
        { name: 'gh_2.92.0_macOS_arm64.zip', browser_download_url: 'https://example.com/gh.zip' }
      ]
    }, 'arm64')

    expect(asset?.name).toBe('gh_2.92.0_macOS_arm64.zip')
    expect(asset?.browser_download_url).toBe('https://example.com/gh.zip')
  })

  it('falls back to the macOS pkg asset when zip is unavailable', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_macOS_amd64.pkg', browser_download_url: 'https://example.com/gh.pkg' }
      ]
    }, 'x64')

    expect(asset?.name).toBe('gh_2.92.0_macOS_amd64.pkg')
  })

  it('returns null when no compatible macOS asset exists', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_linux_arm64.tar.gz', browser_download_url: 'https://example.com/gh.tgz' }
      ]
    }, 'arm64')

    expect(asset).toBeNull()
  })
})

describe('selectRtkAsset', () => {
  const release = {
    assets: [
      { name: 'rtk-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://example.com/mac-arm.tar.gz' },
      { name: 'rtk-x86_64-apple-darwin.tar.gz', browser_download_url: 'https://example.com/mac-x64.tar.gz' },
      { name: 'rtk-aarch64-unknown-linux-gnu.tar.gz', browser_download_url: 'https://example.com/linux-arm.tar.gz' },
      { name: 'rtk-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://example.com/linux-x64.tar.gz' }
    ]
  }

  it('selects the platform and architecture-specific archive', () => {
    expect(selectRtkAsset(release, 'darwin', 'arm64')?.name)
      .toBe('rtk-aarch64-apple-darwin.tar.gz')
    expect(selectRtkAsset(release, 'linux', 'x64')?.name)
      .toBe('rtk-x86_64-unknown-linux-musl.tar.gz')
  })

  it('returns null on unsupported platforms', () => {
    expect(selectRtkAsset(release, 'win32', 'x64')).toBeNull()
  })
})

describe('RTK backend setup', () => {
  it('uses each installed backend native integration and skips missing agents', () => {
    const plans = getRtkInitPlans({
      claudeCode: { installed: true },
      opencode: { installed: false },
      codex: { installed: true },
      cursor: { installed: true },
      pi: { installed: true, supported: false }
    })

    expect(plans.map((plan) => plan.key)).toEqual(['claudeCode', 'codex', 'cursor'])
    expect(plans.find((plan) => plan.key === 'claudeCode')?.args).toContain('--auto-patch')
    expect(plans.find((plan) => plan.key === 'codex')?.args).not.toContain('--auto-patch')
    expect(plans.find((plan) => plan.key === 'cursor')?.args).toEqual(
      expect.arrayContaining(['--agent', 'cursor'])
    )
  })
})
