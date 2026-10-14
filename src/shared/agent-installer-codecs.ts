import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const AGENT_INSTALLER_OPERATIONS = ['agent-installer:detect', 'agent-installer:install'] as const
export const AGENT_INSTALLER_EVENTS = ['agent-installer:progress'] as const
export type AgentInstallerOperation = typeof AGENT_INSTALLER_OPERATIONS[number]
export const AGENT_INSTALLER_DETECTION_KEYS = ['nodejs', 'npm', 'pnpm', 'git', 'gh', 'glab', 'tea', 'rtk', 'claudeCode', 'opencode', 'codex', 'cursor', 'pi'] as const
export const AGENT_INSTALLER_BACKEND_KEYS = ['claudeCode', 'opencode', 'codex', 'cursor', 'pi'] as const
export const AGENT_INSTALLER_MINIMUM_PI_VERSION = '0.80.5'
export const AGENT_INSTALLER_LIMITS = { resultBytes: 8192, versionBytes: 128, reasonBytes: 256, progressBytes: 1024, requests: 16, progressEvents: 16 } as const
export const AGENT_INSTALLER_PUBLIC_ERRORS = Object.freeze({
  unavailable: 'CLI installation is unavailable in this desktop host.',
  unsupported: 'This CLI does not have a portable installation plan.',
  failed: 'CLI installation failed.',
  notDetected: 'The installed CLI could not be verified.',
  piUnsupported: 'The installed Pi CLI is unsupported.',
  adapterMissing: 'The Pi MCP adapter could not be verified.'
})
export const AGENT_INSTALLER_PROGRESS = Object.freeze({
  starting: { output: 'Preparing CLI installation.', percent: 5 },
  installing: { output: 'Installing the selected CLI.', percent: 50 },
  verifying: { output: 'Checking the installed CLI.', percent: 90 },
  complete: { output: 'CLI installation complete.', percent: 100 },
  error: { output: 'CLI installation failed.', percent: 100 }
})
export type AgentInstallerName = typeof AGENT_INSTALLER_DETECTION_KEYS[number]
export type AgentInstallerProgressStage = keyof typeof AGENT_INSTALLER_PROGRESS
export const isAgentInstallerName = (value: unknown): value is AgentInstallerName => typeof value === 'string' && (AGENT_INSTALLER_DETECTION_KEYS as readonly string[]).includes(value)
const version = (value: unknown): value is string => typeof value === 'string' && value.length <= AGENT_INSTALLER_LIMITS.versionBytes && /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:\.windows\.\d{1,6}|-(?:alpha|beta|rc|dev|next)(?:[.-]\d{1,6})?)?$/i.test(value)
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const piSupported = (value: string): boolean => {
  const parts = value.split('.').map(part => Number.parseInt(part, 10) || 0), required = [0, 80, 5]
  for (let index = 0; index < Math.max(parts.length, required.length); index++) {
    if ((parts[index] || 0) !== (required[index] || 0)) return (parts[index] || 0) > (required[index] || 0)
  }
  return true
}
export function isAgentInstallerDetection(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [...AGENT_INSTALLER_DETECTION_KEYS]) || !isJsonValue(value) || new TextEncoder().encode(JSON.stringify(value)).length > AGENT_INSTALLER_LIMITS.resultBytes) return false
  for (const key of AGENT_INSTALLER_DETECTION_KEYS) {
    const status = value[key]
    if (!isRecord(status) || typeof status.installed !== 'boolean' || !(status.version === null || version(status.version)) || !status.installed && status.version !== null) return false
    if (key === 'pi') {
      if (!hasExactKeys(status, ['installed', 'version', 'supported', 'reason'])) return false
      const supported = status.installed && status.version !== null && piSupported(status.version)
      const reason = supported ? null : !status.installed ? 'Pi CLI is not installed.' : status.version
        ? `Pi ${status.version} is unsupported. Update to ${AGENT_INSTALLER_MINIMUM_PI_VERSION} or newer.`
        : `Could not determine the Pi version. Pi ${AGENT_INSTALLER_MINIMUM_PI_VERSION} or newer is required.`
      if (status.supported !== supported || status.reason !== reason) return false
    } else if (key === 'rtk') {
      if (!hasExactKeys(status, ['installed', 'version', 'configured', 'integrations'], ['reason']) || typeof status.configured !== 'boolean' ||
        !isRecord(status.integrations) || !hasExactKeys(status.integrations, [...AGENT_INSTALLER_BACKEND_KEYS]) || !Object.values(status.integrations).every(item => typeof item === 'boolean')) return false
      const required = AGENT_INSTALLER_BACKEND_KEYS.filter(backend => {
        const row = value[backend] as Record<string, unknown>
        return row?.installed === true && row.supported !== false
      })
      if (status.configured !== (status.installed && required.length > 0 && required.every(backend => (status.integrations as Record<string, unknown>)[backend] === true))) return false
    } else if (!hasExactKeys(status, ['installed', 'version'], ['reason'])) return false
    if (key !== 'pi' && status.reason !== undefined && (!['CLI detection timed out.', 'CLI detection failed.'].includes(status.reason as string) || status.installed)) return false
  }
  return true
}
export interface AgentInstallerCodec<K extends AgentInstallerOperation = 'agent-installer:detect'> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
const detection: AgentInstallerCodec = {
  validateArguments: value => Array.isArray(value) && value.length === 0,
  encodeArguments(args) { if (!Array.isArray(args) || args.length !== 0) return fail('INVALID_ARGUMENTS'); return {} },
  decodeArguments(value) { if (!isRecord(value) || !hasExactKeys(value, [])) return fail('INVALID_ARGUMENTS'); return [] },
  validateResult: isAgentInstallerDetection,
  encodeResult(value) { if (!isAgentInstallerDetection(value) || !isJsonValue(value)) return fail('INVALID_RESULT'); return { defined: true, value } },
  decodeResult(value) { if (!isAgentInstallerDetection(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap['agent-installer:detect']['result'] },
  validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && isAgentInstallerDetection(value.value) }
}
export function isAgentInstallerInstallResult(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error', 'newStatus']) && typeof value.success === 'boolean' &&
    (value.success ? value.error === null : typeof value.error === 'string' && (Object.values(AGENT_INSTALLER_PUBLIC_ERRORS) as string[]).includes(value.error)) &&
    isAgentInstallerDetection(value.newStatus) && isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_INSTALLER_LIMITS.resultBytes
}
const installation: AgentInstallerCodec<'agent-installer:install'> = {
  validateArguments: value => Array.isArray(value) && value.length === 1 && isAgentInstallerName(value[0]),
  encodeArguments(args) { if (!Array.isArray(args) || args.length !== 1 || !isAgentInstallerName(args[0])) return fail('INVALID_ARGUMENTS'); return { agentName: args[0] } },
  decodeArguments(value) { if (!isRecord(value) || !hasExactKeys(value, ['agentName']) || !isAgentInstallerName(value.agentName)) return fail('INVALID_ARGUMENTS'); return [value.agentName] },
  validateResult: isAgentInstallerInstallResult,
  encodeResult(value) { if (!isAgentInstallerInstallResult(value) || !isJsonValue(value)) return fail('INVALID_RESULT'); return { defined: true, value } },
  decodeResult(value) { if (!isAgentInstallerInstallResult(value)) return fail('INVALID_RESULT'); return value as DesktopCommandMap['agent-installer:install']['result'] },
  validateWireResult(value) { return isRecord(value) && hasExactKeys(value, ['defined', 'value']) && value.defined === true && isAgentInstallerInstallResult(value.value) }
}
export const AGENT_INSTALLER_CODECS = { 'agent-installer:detect': detection, 'agent-installer:install': installation }
export function isAgentInstallerProgress(value: unknown): value is DesktopEventMap['agent-installer:progress'] {
  if (!isRecord(value) || !hasExactKeys(value, ['agentName', 'stage', 'output', 'percent']) || !isAgentInstallerName(value.agentName) ||
    typeof value.stage !== 'string' || !Object.hasOwn(AGENT_INSTALLER_PROGRESS, value.stage)) return false
  const stage = AGENT_INSTALLER_PROGRESS[value.stage as AgentInstallerProgressStage]
  return value.output === stage.output && value.percent === stage.percent && isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_INSTALLER_LIMITS.progressBytes
}
export function projectAgentInstallerProgress(agentName: AgentInstallerName, stage: unknown): DesktopEventMap['agent-installer:progress'] {
  if (!isAgentInstallerName(agentName) || typeof stage !== 'string' || !Object.hasOwn(AGENT_INSTALLER_PROGRESS, stage)) return fail('INVALID_ARGUMENTS')
  return { agentName, stage, ...AGENT_INSTALLER_PROGRESS[stage as AgentInstallerProgressStage] }
}
export const AGENT_INSTALLER_EVENT_CODECS = { 'agent-installer:progress': {
  validatePayload: isAgentInstallerProgress,
  encodePayload(value: unknown): JsonValue { if (!isAgentInstallerProgress(value)) return fail('INVALID_ARGUMENTS'); return value as JsonValue },
  decodePayload(value: JsonValue): DesktopEventMap['agent-installer:progress'] { if (!isAgentInstallerProgress(value)) return fail('INVALID_RESULT'); return value }
} }
