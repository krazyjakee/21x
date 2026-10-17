import { hasExactKeys, isRecord } from './service-protocol'

/** Private pipe only. Provider, source, credentials and PKCE never cross this boundary. */
export interface NativeOAuthRegistration {
  flowId: string
  kind: 'loopback' | 'custom-scheme'
  stateSha256: string
  redirectUri: string
  authorizationUrl: string
  ttlMs: number
}
export type NativeOAuthOutcome = { status: 'code'; code: string } | { status: 'denied' | 'failed' }
export interface NativeOAuthCallback {
  flowId: string
  kind: 'custom-scheme'
  redirectUri: string
  state: string
  outcome: NativeOAuthOutcome
}
export interface NativeOAuthBridge {
  register(input: NativeOAuthRegistration): Promise<{ flowId: string; registered: true }>
  open(input: { flowId: string }): Promise<{ flowId: string; opened: true }>
  retire(input: { flowId: string }): Promise<{ flowId: string; retired: true }>
}
export const isOAuthFlowId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export const isOAuthState = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._~-]{16,256}$/.test(value)
export const isOAuthCode = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value)

export function isOAuthRedirect(kind: unknown, value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (kind === 'custom-scheme') return value === 'twentyonex://oauth/callback' || value === 'nuanu://oauth/callback'
  if (kind !== 'loopback' || !/^http:\/\/localhost:30(?:0[0-9]|10)\/callback$/.test(value)) return false
  return true
}
export function oauthAuthorizationFields(value: unknown): { state: string; redirectUri: string } | null {
  if (typeof value !== 'string' || value.length > 8192 || !/^https:\/\/[\x21-\x7e]+$/.test(value) || /[\\#]/.test(value)) return null
  try {
    const url = new URL(value)
    const authority = value.slice(8).split(/[/?]/)[0]
    if (!url.hostname || authority.includes('@') || url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('redirect_uri').length !== 1) return null
    const state = url.searchParams.get('state'), redirectUri = url.searchParams.get('redirect_uri')!
    return isOAuthState(state) ? { state, redirectUri } : null
  } catch { return null }
}
export function isNativeOAuthRegistration(value: unknown): value is NativeOAuthRegistration {
  if (!isRecord(value) || !hasExactKeys(value, ['flowId', 'kind', 'stateSha256', 'redirectUri', 'authorizationUrl', 'ttlMs']) || !isOAuthFlowId(value.flowId) || !isOAuthRedirect(value.kind, value.redirectUri) || typeof value.stateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.stateSha256) || !Number.isSafeInteger(value.ttlMs) || Number(value.ttlMs) < 1 || Number(value.ttlMs) > 300000) return false
  const fields = oauthAuthorizationFields(value.authorizationUrl)
  return fields !== null && fields.redirectUri === value.redirectUri
}
export function isNativeOAuthCallback(value: unknown): value is NativeOAuthCallback {
  if (!isRecord(value) || !hasExactKeys(value, ['flowId', 'kind', 'redirectUri', 'outcome', 'state']) || !isOAuthFlowId(value.flowId) || value.kind !== 'custom-scheme' || !isOAuthRedirect(value.kind, value.redirectUri) || !isOAuthState(value.state) || !isRecord(value.outcome)) return false
  return value.outcome.status === 'code' ? hasExactKeys(value.outcome, ['status', 'code']) && isOAuthCode(value.outcome.code) : hasExactKeys(value.outcome, ['status']) && (value.outcome.status === 'denied' || value.outcome.status === 'failed')
}
const flow = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['flowId']) && isOAuthFlowId(value.flowId)
const receipt = (field: 'registered' | 'opened' | 'retired') => (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['flowId', field]) && isOAuthFlowId(value.flowId) && value[field] === true
export const OAUTH_NATIVE_CALLBACK_SCHEMAS = {
  'host.oauth.register': { validatePayload: isNativeOAuthRegistration, validateResult: receipt('registered') },
  'host.oauth.open': { validatePayload: flow, validateResult: receipt('opened') },
  'host.oauth.retire': { validatePayload: flow, validateResult: receipt('retired') }
} as const
export const OAUTH_DELIVERY_SCHEMA = {
  validatePayload: isNativeOAuthCallback,
  validateResult: (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['accepted']) && typeof value.accepted === 'boolean'
} as const
