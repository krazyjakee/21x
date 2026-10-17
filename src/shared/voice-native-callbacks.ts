/** Private local voice receipts. This schema never grants native availability. */
import { hasExactKeys, isRecord } from './service-protocol'
import { isDatabaseId } from './database-desktop-codecs'
import { isUiLeaseId } from './ui-desktop-codecs'
import type { VoiceActionOutcome, VoiceIntent } from './voice'
import type { OperationSchema } from '../service/transport/peer'

export const NATIVE_VOICE_LIMITS = Object.freeze({
  active: 16,
  epochIds: 4096,
  permissionMs: 120000,
  turnMs: 600000,
  pcmBytes: 6400,
  turnBytes: 19200000,
  pending: 8,
  pendingBytes: 256 * 1024,
  eventBytes: 256 * 1024,
  textBytes: 65536
})
export const NATIVE_VOICE_ERROR = 'The local voice operation is unavailable.'
export type NativeVoicePurpose = 'permission' | 'capture' | 'playback' | 'shortcut'
export interface NativeVoiceRegistration {
  voiceLeaseId: string
  uiLeaseId: string
  purpose: NativeVoicePurpose
  ttlMs: number
}
export type NativeVoiceBinding =
  | { voiceLeaseId: string; turnId: string; turnEpoch: string }
  | { voiceLeaseId: string; speechId: string; speechGeneration: number }
export type NativeVoiceEvent =
  | { type: 'partial' | 'final' | 'dictate'; turnId: string; turnEpoch: string; text: string }
  | { type: 'segment'; turnId: string; turnEpoch: string; text: string; index: number }
  | {
      type: 'state'
      turnId: string
      turnEpoch: string
      state:
        | 'listening'
        | 'transcribing'
        | 'awaiting_confirmation'
        | 'executing'
        | 'waiting_for_agent'
        | 'speaking'
        | 'idle'
    }
  | { type: 'error'; turnId: string; turnEpoch: string; message: typeof NATIVE_VOICE_ERROR }
  | { type: 'outcome'; turnId: string; turnEpoch: string; outcome: VoiceActionOutcome }
  | {
      type: 'navigate'
      turnId: string
      turnEpoch: string
      destination: 'tasks' | 'skills' | 'dashboard' | 'canvas' | 'commander' | 'overview' | 'settings'
      taskId: string | null
    }
  | { type: 'hotkey'; action: 'toggle' }
  | {
      type: 'speech-start'
      speechId: string
      speechGeneration: number
      source: 'agent_answer' | 'action_result' | 'read_last_answer' | 'preview' | 'manual' | 'conversation'
      text: string
      sampleRate: number
      truncated: boolean
      taskId?: string
    }
  | {
      type: 'speech-chunk'
      speechId: string
      speechGeneration: number
      index: number
      pcmBase64: string
      sampleRate: number
      text: string
    }
  | {
      type: 'speech-end'
      speechId: string
      speechGeneration: number
      reason: 'complete' | 'cancelled' | 'error' | 'skipped'
    }
export interface NativeVoiceAudio {
  voiceLeaseId: string
  turnId: string
  turnEpoch: string
  seq: number
  pcmBase64: string
}
export interface NativeVoiceBridge {
  acquire(value: NativeVoiceRegistration): Promise<{ voiceLeaseId: string; acquired: true }>
  permission(value: {
    voiceLeaseId: string
  }): Promise<{ voiceLeaseId: string; status: 'granted' | 'denied' | 'unavailable' }>
  bind(value: NativeVoiceBinding): Promise<{ voiceLeaseId: string; bound: true }>
  shortcut(value: { voiceLeaseId: string; accelerator: string }): Promise<{ voiceLeaseId: string; registered: true }>
  publish(value: {
    voiceLeaseId: string
    event: NativeVoiceEvent
  }): Promise<{ voiceLeaseId: string; delivered: boolean }>
  retire(value: { voiceLeaseId: string }): Promise<{ voiceLeaseId: string; retired: true }>
}
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  isRecord(value) && hasExactKeys(value, required, optional)
export const isVoiceLeaseId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number = NATIVE_VOICE_LIMITS.textBytes): value is string =>
  typeof value === 'string' &&
  !/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
  new TextEncoder().encode(value).length <= max
const rate = (value: unknown): value is number => positive(value) && value >= 8000 && value <= 48000
export function voicePcmByteLength(value: unknown, max: number = NATIVE_VOICE_LIMITS.pcmBytes): number | null {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null
  const bytes = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  // Reject non-canonical unused bits without a Node/browser decoder dependency.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (
    (value.endsWith('==') && (alphabet.indexOf(value[value.length - 3]) & 15) !== 0) ||
    (value.endsWith('=') && !value.endsWith('==') && (alphabet.indexOf(value[value.length - 2]) & 3) !== 0)
  )
    return null
  return bytes >= 2 && bytes <= max && bytes % 2 === 0 ? bytes : null
}
export function isVoiceAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  const parts = value.split('+'),
    key = parts.pop()
  const aliases: Record<string, string> = {
    CommandOrControl: 'mod',
    Control: 'ctrl',
    Ctrl: 'ctrl',
    Alt: 'alt',
    Shift: 'shift',
    Super: 'meta',
    Meta: 'meta',
    Command: 'meta',
    Cmd: 'meta'
  }
  return (
    parts.length > 0 &&
    parts.length <= 4 &&
    parts.every((part) => Object.hasOwn(aliases, part)) &&
    new Set(parts.map((part) => aliases[part])).size === parts.length &&
    typeof key === 'string' &&
    /^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Escape|Enter)$/.test(key)
  )
}
export function isNativeVoiceRegistration(value: unknown): value is NativeVoiceRegistration {
  return (
    shape(value, ['voiceLeaseId', 'uiLeaseId', 'purpose', 'ttlMs']) &&
    isVoiceLeaseId(value.voiceLeaseId) &&
    isUiLeaseId(value.uiLeaseId) &&
    ['permission', 'capture', 'playback', 'shortcut'].includes(value.purpose as string) &&
    positive(value.ttlMs) &&
    value.ttlMs <= (value.purpose === 'permission' ? NATIVE_VOICE_LIMITS.permissionMs : NATIVE_VOICE_LIMITS.turnMs)
  )
}
export function isNativeVoiceBinding(value: unknown): value is NativeVoiceBinding {
  return (
    isRecord(value) &&
    isVoiceLeaseId(value.voiceLeaseId) &&
    ((shape(value, ['voiceLeaseId', 'turnId', 'turnEpoch']) &&
      isDatabaseId(value.turnId) &&
      isDatabaseId(value.turnEpoch)) ||
      (shape(value, ['voiceLeaseId', 'speechId', 'speechGeneration']) &&
        isDatabaseId(value.speechId) &&
        positive(value.speechGeneration)))
  )
}
const intentTypes = [
  'create_task',
  'assign_agent',
  'start_task',
  'reply_to_agent',
  'approve_checkpoint',
  'reject_checkpoint',
  'navigate',
  'read_last_answer',
  'cancel'
]
const views = ['tasks', 'skills', 'dashboard', 'canvas', 'commander', 'overview', 'settings']
function reference(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === 'current'
      ? shape(value, ['kind'])
      : value.kind === 'id'
        ? shape(value, ['kind', 'id']) && isDatabaseId(value.id)
        : value.kind === 'title' &&
          shape(value, ['kind', 'text']) &&
          text(value.text, 4096) &&
          value.text.trim().length > 0)
  )
}
export function isNativeVoiceIntent(value: unknown): value is VoiceIntent {
  if (!isRecord(value) || typeof value.type !== 'string' || !intentTypes.includes(value.type)) return false
  if (value.type === 'cancel') return shape(value, ['type'])
  if (value.type === 'create_task')
    return (
      shape(value, ['type', 'title'], ['description', 'priority']) &&
      text(value.title, 4096) &&
      value.title.trim().length > 0 &&
      (value.description === undefined || text(value.description)) &&
      (value.priority === undefined || ['critical', 'high', 'medium', 'low'].includes(value.priority as string))
    )
  if (value.type === 'navigate')
    return (
      shape(value, ['type', 'destination'], ['taskRef']) &&
      views.includes(value.destination as string) &&
      (value.taskRef === undefined || reference(value.taskRef))
    )
  if (!reference(value.taskRef)) return false
  if (value.type === 'assign_agent')
    return (
      shape(value, ['type', 'taskRef', 'agentName']) && text(value.agentName, 512) && value.agentName.trim().length > 0
    )
  if (value.type === 'reply_to_agent')
    return shape(value, ['type', 'taskRef', 'message']) && text(value.message) && value.message.trim().length > 0
  if (value.type === 'approve_checkpoint' || value.type === 'reject_checkpoint')
    return shape(value, ['type', 'taskRef'], ['message']) && (value.message === undefined || text(value.message))
  return shape(value, ['type', 'taskRef'])
}
export function isNativeVoiceOutcome(value: unknown): value is VoiceActionOutcome {
  if (!isRecord(value) || !isDatabaseId(value.turnId) || !isDatabaseId(value.turnEpoch)) return false
  const owner = ['status', 'turnId', 'turnEpoch']
  if (value.status === 'cancelled') return shape(value, owner)
  if (value.status === 'completed') return shape(value, [...owner, 'segments']) && natural(value.segments)
  if (value.status === 'dictation') return shape(value, [...owner, 'text']) && text(value.text)
  if (value.status === 'executed')
    return (
      shape(value, [...owner, 'intent', 'message'], ['taskId']) &&
      intentTypes.includes(value.intent as string) &&
      text(value.message) &&
      (value.taskId === undefined || isDatabaseId(value.taskId))
    )
  if (value.status === 'rejected')
    return (
      shape(value, [...owner, 'reason', 'message']) &&
      ['unrecognized', 'no_target', 'no_pending_approval', 'not_found', 'stale_turn', 'failed'].includes(
        value.reason as string
      ) &&
      (value.reason === 'failed' ? value.message === NATIVE_VOICE_ERROR : text(value.message))
    )
  if (
    value.status !== 'needs_confirmation' ||
    !shape(value, [...owner, 'proposal', 'reason'], ['candidates']) ||
    !['destructive', 'ambiguous_task', 'ambiguous_agent', 'low_confidence', 'policy'].includes(value.reason as string)
  )
    return false
  const proposal = value.proposal
  return (
    shape(proposal, ['intent', 'confidence', 'transcript', 'source', 'summary']) &&
    isNativeVoiceIntent(proposal.intent) &&
    typeof proposal.confidence === 'number' &&
    Number.isFinite(proposal.confidence) &&
    proposal.confidence >= 0 &&
    proposal.confidence <= 1 &&
    text(proposal.transcript) &&
    ['deterministic', 'classifier'].includes(proposal.source as string) &&
    text(proposal.summary, 8192) &&
    (value.candidates === undefined ||
      (Array.isArray(value.candidates) &&
        value.candidates.length <= 3 &&
        value.candidates.every(
          (item) =>
            shape(item, ['id', 'label', 'kind']) &&
            isDatabaseId(item.id) &&
            text(item.label, 4096) &&
            ['task', 'agent'].includes(item.kind as string)
        ) &&
        new Set(value.candidates.map((item) => (item as { id: string }).id)).size === value.candidates.length))
  )
}
export function isNativeVoiceEvent(value: unknown): value is NativeVoiceEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  const turn = ['type', 'turnId', 'turnEpoch'],
    speech = ['type', 'speechId', 'speechGeneration']
  if (['partial', 'final', 'dictate', 'segment', 'state', 'error', 'outcome', 'navigate'].includes(value.type)) {
    if (!isDatabaseId(value.turnId) || !isDatabaseId(value.turnEpoch)) return false
    if (value.type === 'outcome')
      return (
        shape(value, [...turn, 'outcome']) &&
        isNativeVoiceOutcome(value.outcome) &&
        value.outcome.turnId === value.turnId &&
        value.outcome.turnEpoch === value.turnEpoch
      )
    if (value.type === 'navigate')
      return (
        shape(value, [...turn, 'destination', 'taskId']) &&
        views.includes(value.destination as string) &&
        (value.taskId === null || isDatabaseId(value.taskId))
      )
    if (value.type === 'state')
      return (
        shape(value, [...turn, 'state']) &&
        [
          'listening',
          'transcribing',
          'awaiting_confirmation',
          'executing',
          'waiting_for_agent',
          'speaking',
          'idle'
        ].includes(value.state as string)
      )
    if (value.type === 'error') return shape(value, [...turn, 'message']) && value.message === NATIVE_VOICE_ERROR
    return (
      shape(value, [...turn, 'text', ...(value.type === 'segment' ? ['index'] : [])]) &&
      text(value.text) &&
      (value.type !== 'segment' || natural(value.index))
    )
  }
  if (value.type === 'hotkey') return shape(value, ['type', 'action']) && value.action === 'toggle'
  if (!isDatabaseId(value.speechId) || !positive(value.speechGeneration)) return false
  if (value.type === 'speech-start')
    return (
      shape(value, [...speech, 'source', 'text', 'sampleRate', 'truncated'], ['taskId']) &&
      ['agent_answer', 'action_result', 'read_last_answer', 'preview', 'manual', 'conversation'].includes(
        value.source as string
      ) &&
      text(value.text) &&
      rate(value.sampleRate) &&
      typeof value.truncated === 'boolean' &&
      (value.taskId === undefined || isDatabaseId(value.taskId))
    )
  if (value.type === 'speech-chunk')
    return (
      shape(value, [...speech, 'index', 'pcmBase64', 'sampleRate', 'text']) &&
      natural(value.index) &&
      voicePcmByteLength(value.pcmBase64, 128 * 1024) !== null &&
      rate(value.sampleRate) &&
      text(value.text)
    )
  return (
    value.type === 'speech-end' &&
    shape(value, [...speech, 'reason']) &&
    ['complete', 'cancelled', 'error', 'skipped'].includes(value.reason as string)
  )
}
export function isNativeVoiceAudio(value: unknown): value is NativeVoiceAudio {
  return (
    shape(value, ['voiceLeaseId', 'turnId', 'turnEpoch', 'seq', 'pcmBase64']) &&
    isVoiceLeaseId(value.voiceLeaseId) &&
    isDatabaseId(value.turnId) &&
    isDatabaseId(value.turnEpoch) &&
    positive(value.seq) &&
    voicePcmByteLength(value.pcmBase64) !== null
  )
}
export const isNativeVoiceLeaseRequest = (value: unknown): value is { voiceLeaseId: string } =>
  shape(value, ['voiceLeaseId']) && isVoiceLeaseId(value.voiceLeaseId)
const receipt =
  (field: string) =>
  (value: unknown): boolean =>
    shape(value, ['voiceLeaseId', field]) && isVoiceLeaseId(value.voiceLeaseId) && value[field] === true
export const NATIVE_VOICE_HOST_SCHEMAS: Record<string, OperationSchema> = {
  'host.voice.acquire': { validatePayload: isNativeVoiceRegistration, validateResult: receipt('acquired') },
  'host.voice.permission': {
    validatePayload: isNativeVoiceLeaseRequest,
    validateResult: (value) =>
      shape(value, ['voiceLeaseId', 'status']) &&
      isVoiceLeaseId(value.voiceLeaseId) &&
      ['granted', 'denied', 'unavailable'].includes(value.status as string)
  },
  'host.voice.bind': { validatePayload: isNativeVoiceBinding, validateResult: receipt('bound') },
  'host.voice.shortcut': {
    validatePayload: (value) =>
      shape(value, ['voiceLeaseId', 'accelerator']) &&
      isVoiceLeaseId(value.voiceLeaseId) &&
      isVoiceAccelerator(value.accelerator),
    validateResult: receipt('registered')
  },
  'host.voice.publish': {
    validatePayload: (value) =>
      shape(value, ['voiceLeaseId', 'event']) &&
      isVoiceLeaseId(value.voiceLeaseId) &&
      isNativeVoiceEvent(value.event) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= NATIVE_VOICE_LIMITS.eventBytes,
    validateResult: (value) =>
      shape(value, ['voiceLeaseId', 'delivered']) &&
      isVoiceLeaseId(value.voiceLeaseId) &&
      typeof value.delivered === 'boolean'
  },
  'host.voice.retire': { validatePayload: isNativeVoiceLeaseRequest, validateResult: receipt('retired') }
}
export const NATIVE_VOICE_DELIVERY_SCHEMAS: Record<string, OperationSchema> = {
  'engine.voice.audio': {
    validatePayload: isNativeVoiceAudio,
    validateResult: (value) => shape(value, ['accepted']) && typeof value.accepted === 'boolean'
  },
  'engine.voice.hotkey': {
    validatePayload: isNativeVoiceLeaseRequest,
    validateResult: (value) => shape(value, ['accepted']) && typeof value.accepted === 'boolean'
  },
  'engine.voice.revoked': {
    validatePayload: isNativeVoiceLeaseRequest,
    validateResult: (value) => shape(value, ['accepted']) && typeof value.accepted === 'boolean'
  }
}
