import { describe, expect, it } from 'vitest'
import { isProductionInitialize, isProductionLaunchDescriptor, PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from './production-bootstrap'

export function launchDescriptor(root = '/private-fixture'): ProductionLaunchDescriptor {
  return { version: 1, kind: 'production-private-launch', launchId: 'launch_fixture_001', profileId: 'synthetic-profile',
    profileIntent: 'create-new', buildIdentity: 'production-fixture', resourceManifestSha256: 'a'.repeat(64),
    paths: { profileRoot: `${root}/profile`, workspaceRoot: `${root}/workspaces`, attachmentRoot: `${root}/attachments`,
      reposRoot: `${root}/repos`, resourceRoot: `${root}/resources`, tempRoot: `${root}/temp` },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported',
      configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
}

describe('sealed production launch descriptor codecs', () => {
  it('requires explicit fresh/copy intent and exact trusted path/capability fields', () => {
    const value = launchDescriptor()
    expect(isProductionLaunchDescriptor(value)).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, profileIntent: 'adopt-live' })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, paths: { ...value.paths, profileRoot: 'relative' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, energy: 'host' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, credentials: { key: 'plaintext' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, wildcard: true } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, workspaceFiles: 'host' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, workspaceFiles: 'unsupported' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, workspaceFiles: true } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentFiles: 'host' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentFiles: 'host', ui: 'host' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentFiles: 'unsupported' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentFiles: true } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentDownloads: 'host' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentDownloads: 'host', ui: 'host' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentDownloads: 'unsupported' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, attachmentDownloads: true } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, artifactClipboard: 'host' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, artifactClipboard: 'host', ui: 'host' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, artifactClipboard: 'unsupported' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, tray: 'host' } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, tray: 'host', ui: 'host' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, tray: 'unsupported' } })).toBe(true)
    expect(isProductionLaunchDescriptor({ ...value, capabilities: { ...value.capabilities, tray: true } })).toBe(false)
    expect(isProductionLaunchDescriptor({ ...value, environment: { API_KEY: 'plaintext' } })).toBe(false)
  })
  it('initialize cannot override profile/workspace/credential/bootstrap authority', () => {
    const initialize = { protocolVersion: 1, launchId: 'launch_fixture_001' }
    expect(isProductionInitialize(initialize)).toBe(true)
    for (const field of ['paths', 'credentials', 'workspaceDir', 'profileRoot', 'authority', 'operations'])
      expect(isProductionInitialize({ ...initialize, [field]: {} })).toBe(false)
    expect(isProductionInitialize({ protocolVersion: 1, launchId: '../bad' })).toBe(false)
  })
  it('native preparation/drain schemas accept only reviewed launch acknowledgements', () => {
    const prepare = PRODUCTION_HOST_SCHEMAS['host.production.prepare']
    const drain = PRODUCTION_HOST_SCHEMAS['host.production.drain']
    expect(prepare.validatePayload({ launchId: 'launch_fixture_001', resourceManifestSha256: 'a'.repeat(64) })).toBe(true)
    expect(prepare.validateResult({ launchId: 'launch_fixture_001', ready: true, processTree: 'supervised' })).toBe(true)
    expect(prepare.validateResult({ launchId: 'launch_fixture_001', ready: true, processTree: 'unverified' })).toBe(false)
    expect(drain.validatePayload({ launchId: 'launch_fixture_001', pid: 1 })).toBe(false)
    expect(drain.validateResult({ launchId: 'launch_fixture_001', acknowledged: false })).toBe(false)
    expect(drain.validateResult({ launchId: 'launch_fixture_001', acknowledged: true, executable: '/tmp/arbitrary' })).toBe(false)
  })
})
