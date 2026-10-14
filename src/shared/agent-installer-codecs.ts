import type { DesktopCommandMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

export const AGENT_INSTALLER_OPERATIONS = ['agent-installer:detect'] as const
export type AgentInstallerOperation = typeof AGENT_INSTALLER_OPERATIONS[number]
export const AGENT_INSTALLER_DETECTION_KEYS = ['nodejs', 'npm', 'pnpm', 'git', 'gh', 'glab', 'tea', 'rtk', 'claudeCode', 'opencode', 'codex', 'cursor', 'pi'] as const
export const AGENT_INSTALLER_BACKEND_KEYS = ['claudeCode', 'opencode', 'codex', 'cursor', 'pi'] as const
export const AGENT_INSTALLER_MINIMUM_PI_VERSION = '0.80.5'
export const AGENT_INSTALLER_LIMITS = { resultBytes: 8192, versionBytes: 128, reasonBytes: 256 } as const
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
export interface AgentInstallerCodec {
  encodeArguments(args: DesktopCommandMap['agent-installer:detect']['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap['agent-installer:detect']['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap['agent-installer:detect']['result']
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
export const AGENT_INSTALLER_CODECS = { 'agent-installer:detect': detection }
