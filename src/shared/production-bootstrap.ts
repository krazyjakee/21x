import { hasExactKeys, isRecord } from './service-protocol'
import { isAbsoluteHostPath } from './host-services'

export const PRODUCTION_BOOTSTRAP_VERSION = 1 as const
export const PRODUCTION_DESCRIPTOR_MAX_BYTES = 32 * 1024
export interface ProductionLaunchDescriptor {
  version: 1
  kind: 'production-private-launch'
  launchId: string
  profileId: string
  profileIntent: 'create-new' | 'load-authenticated-copy'
  buildIdentity: string
  resourceManifestSha256: string
  paths: { profileRoot: string; workspaceRoot: string; attachmentRoot: string; reposRoot: string; resourceRoot: string; tempRoot: string }
  capabilities: {
    workspaceFiles?: 'host' | 'unsupported'
    externalUrls: 'host' | 'unsupported'
    notifications: 'host' | 'unsupported'
    energy: 'unsupported'
    ui: 'unsupported'
    voice: 'unsupported'
    configuredMcp: 'enabled' | 'disabled'
    connectors: 'enabled' | 'disabled'
    managedTaskMcp: 'enabled' | 'disabled'
  }
}
export const isProductionLaunchId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)
export const isResourceDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const choice = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value)
export function isProductionLaunchDescriptor(value: unknown): value is ProductionLaunchDescriptor {
  if (!isRecord(value) || !isRecord(value.capabilities)) return false
  const capabilities = value.capabilities
  return isRecord(value) && hasExactKeys(value, ['version', 'kind', 'launchId', 'profileId', 'profileIntent', 'buildIdentity', 'resourceManifestSha256', 'paths', 'capabilities']) &&
    value.version === 1 && value.kind === 'production-private-launch' && isProductionLaunchId(value.launchId) && typeof value.profileId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.profileId) &&
    choice(value.profileIntent, ['create-new', 'load-authenticated-copy']) && typeof value.buildIdentity === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.buildIdentity) && isResourceDigest(value.resourceManifestSha256) &&
    isRecord(value.paths) && hasExactKeys(value.paths, ['profileRoot', 'workspaceRoot', 'attachmentRoot', 'reposRoot', 'resourceRoot', 'tempRoot']) && Object.values(value.paths).every(isAbsoluteHostPath) &&
    isRecord(value.capabilities) && hasExactKeys(value.capabilities, ['externalUrls', 'notifications', 'energy', 'ui', 'voice', 'configuredMcp', 'connectors', 'managedTaskMcp'], ['workspaceFiles']) &&
    (capabilities.workspaceFiles === undefined || choice(capabilities.workspaceFiles, ['host', 'unsupported'])) &&
    ['externalUrls', 'notifications'].every(key => choice(capabilities[key], ['host', 'unsupported'])) && ['energy', 'ui', 'voice'].every(key => capabilities[key] === 'unsupported') &&
    ['configuredMcp', 'connectors', 'managedTaskMcp'].every(key => choice(capabilities[key], ['enabled', 'disabled']))
}
export function isProductionInitialize(value: unknown): value is { protocolVersion: 1; launchId: string } {
  return isRecord(value) && hasExactKeys(value, ['protocolVersion', 'launchId']) && value.protocolVersion === 1 && isProductionLaunchId(value.launchId)
}

/** Exact launch-only callbacks. They carry no PIDs, paths, credentials or generic dispatcher. */
export const PRODUCTION_HOST_SCHEMAS = {
  'host.production.prepare': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['launchId', 'resourceManifestSha256']) && isProductionLaunchId(value.launchId) && isResourceDigest(value.resourceManifestSha256),
    validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['launchId', 'ready', 'processTree']) && isProductionLaunchId(value.launchId) && value.ready === true && value.processTree === 'supervised'
  },
  'host.production.drain': {
    validatePayload: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['launchId']) && isProductionLaunchId(value.launchId),
    validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['launchId', 'acknowledged']) && isProductionLaunchId(value.launchId) && value.acknowledged === true
  }
} as const
