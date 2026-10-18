import { hasExactKeys, isRecord } from './service-protocol'
import { isAbsoluteHostPath } from './host-services'

export const PRODUCTION_BOOTSTRAP_VERSION = 1 as const
export const PRODUCTION_DESCRIPTOR_MAX_BYTES = 32 * 1024
/** Private owner observations contain finite metadata only, never error text,
 * paths, credentials, queue payloads or process identifiers. */
export const PRODUCTION_OWNER_PHASES = ['new', 'starting', 'ready', 'stopping', 'blocked', 'stopped', 'failed'] as const
export const PRODUCTION_OWNER_STAGES = ['new', 'profile-lock', 'resources', 'native-readiness', 'credentials', 'database-preflight',
  'database', 'secret-broker', 'task-api', 'services', 'recovery', 'background', 'ready', 'released'] as const
export const PRODUCTION_RECOVERY_CODES = ['PROFILE_IN_USE', 'PROFILE_DUPLICATE_OWNER', 'PROFILE_LOCK_INVALID', 'PROFILE_LOCK_LOST',
  'PROFILE_NOT_EMPTY', 'PROFILE_LOW_DISK', 'PROFILE_DATABASE_LOCKED', 'PROFILE_DATABASE_CORRUPT', 'PROFILE_DATABASE_PATH_INVALID',
  'PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE', 'PROFILE_CREDENTIAL_OR_DATABASE_INVALID', 'DATABASE_UNAVAILABLE',
  'RESOURCE_UNAVAILABLE', 'MANAGED_MCP_RESOURCE_UNAVAILABLE', 'CONNECTOR_RESOURCES_REQUIRED', 'AGENT_CLI_UNAVAILABLE',
  'NATIVE_RUNTIME_UNAVAILABLE', 'SECRET_STORE_UNAVAILABLE', 'OWNER_CLOSING', 'OWNER_DRAIN_BLOCKED', 'OWNER_FENCE_FAILED', 'BOOTSTRAP_FAILED'] as const
export interface ProductionOwnerState {
  phase: typeof PRODUCTION_OWNER_PHASES[number]
  stage: typeof PRODUCTION_OWNER_STAGES[number]
  code: typeof PRODUCTION_RECOVERY_CODES[number] | null
  owned: boolean
}
export function isProductionOwnerState(value: unknown): value is ProductionOwnerState {
  return isRecord(value) && hasExactKeys(value, ['phase', 'stage', 'code', 'owned']) &&
    PRODUCTION_OWNER_PHASES.some(phase => phase === value.phase) && PRODUCTION_OWNER_STAGES.some(stage => stage === value.stage) &&
    (value.code === null || PRODUCTION_RECOVERY_CODES.some(code => code === value.code)) && typeof value.owned === 'boolean'
}
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
    workspaceCleanup?: 'host' | 'unsupported'
    attachmentFiles?: 'host' | 'unsupported'
    attachmentDownloads?: 'host' | 'unsupported'
    attachmentSelections?: 'host' | 'unsupported'
    windowState?: 'host' | 'unsupported'
    artifactClipboard?: 'host' | 'unsupported'
    tray?: 'host' | 'unsupported'
    oauthFlows?: 'host' | 'unsupported'
    artifactViewer?: 'host' | 'unsupported'
    externalUrls: 'host' | 'unsupported'
    notifications: 'host' | 'unsupported'
    energy: 'host' | 'unsupported'
    ui: 'host' | 'unsupported'
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
    isRecord(value.capabilities) && hasExactKeys(value.capabilities, ['externalUrls', 'notifications', 'energy', 'ui', 'voice', 'configuredMcp', 'connectors', 'managedTaskMcp'], ['workspaceFiles', 'workspaceCleanup', 'attachmentFiles', 'attachmentDownloads', 'attachmentSelections', 'windowState', 'artifactClipboard', 'tray', 'oauthFlows', 'artifactViewer']) &&
    (capabilities.artifactViewer === undefined || choice(capabilities.artifactViewer, ['host', 'unsupported'])) &&
    (capabilities.artifactViewer !== 'host' || capabilities.ui === 'host') &&
    (capabilities.oauthFlows === undefined || choice(capabilities.oauthFlows, ['host', 'unsupported'])) &&
    (capabilities.oauthFlows !== 'host' || capabilities.externalUrls === 'host') &&
    (capabilities.tray === undefined || choice(capabilities.tray, ['host', 'unsupported'])) &&
    (capabilities.tray !== 'host' || capabilities.ui === 'host') &&
    (capabilities.workspaceFiles === undefined || choice(capabilities.workspaceFiles, ['host', 'unsupported'])) &&
    (capabilities.workspaceCleanup === undefined || choice(capabilities.workspaceCleanup, ['host', 'unsupported'])) &&
    (capabilities.attachmentFiles === undefined || choice(capabilities.attachmentFiles, ['host', 'unsupported'])) &&
    (capabilities.attachmentFiles !== 'host' || capabilities.ui === 'host') &&
    (capabilities.attachmentSelections === undefined || choice(capabilities.attachmentSelections, ['host', 'unsupported'])) &&
    (capabilities.attachmentSelections !== 'host' || capabilities.ui === 'host') &&
    (capabilities.windowState === undefined || choice(capabilities.windowState, ['host', 'unsupported'])) &&
    (capabilities.windowState !== 'host' || capabilities.ui === 'host') &&
    (capabilities.attachmentDownloads === undefined || choice(capabilities.attachmentDownloads, ['host', 'unsupported'])) &&
    (capabilities.attachmentDownloads !== 'host' || capabilities.ui === 'host') &&
    (capabilities.artifactClipboard === undefined || choice(capabilities.artifactClipboard, ['host', 'unsupported'])) &&
    (capabilities.artifactClipboard !== 'host' || capabilities.ui === 'host') &&
    ['externalUrls', 'notifications', 'ui', 'energy'].every(key => choice(capabilities[key], ['host', 'unsupported'])) && capabilities.voice === 'unsupported' &&
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
