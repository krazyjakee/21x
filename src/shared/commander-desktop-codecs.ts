import type { DesktopCommandMap, DesktopEventMap } from './desktop-operations'
import type { OptionalResult } from './host-services'
import type { ChatMessage, ChatRuntimeEvent } from './chat'
import type { CommanderEvent } from './commander'
import { COMMANDER_MESSAGE_ROLES } from './commander'
import { isChatImageMimeType, sanitizeChatImageName, validateChatImageInputs, type ChatImageInput } from './chat-images'
import { hasExactKeys, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'

/** Frame limits do not authorize operations or grant project/session access. */
export const COMMANDER_DESKTOP_LIMITS = {
  records: 128, fieldBytes: 64 * 1024, wireBytes: 768 * 1024,
  imageBytes: 192 * 1024, imageTotalBytes: 384 * 1024, images: 5,
  titleChars: 500, searchChars: 200, toolCalls: 32
} as const
export const COMMANDER_DESKTOP_OPERATIONS = [
  'commander:listSessions', 'commander:createSession', 'commander:renameSession', 'commander:archiveSession',
  'commander:listMessages', 'commander:markRead', 'commander:setActiveSession', 'commander:send', 'commander:getImage',
  'commander:cancel', 'commander:undoAction', 'commander:getActivity', 'chat:start', 'chat:cancel'
] as const
export type CommanderDesktopOperation = typeof COMMANDER_DESKTOP_OPERATIONS[number]
export const COMMANDER_DESKTOP_EVENTS = ['commander:event', 'chat:event'] as const
export type CommanderDesktopEvent = typeof COMMANDER_DESKTOP_EVENTS[number]
export const COMMANDER_DESKTOP_ERROR = 'The Commander request failed.'
export const CHAT_DESKTOP_ERROR = 'The chat request failed.'
export interface CommanderImageBytes { name: string; mimeType: ChatImageInput['mimeType']; encoding: 'base64'; byteLength: number; data: string }
export interface CommanderImageEnvelope { version: 1; images: CommanderImageBytes[] }
export interface CommanderCommandCodec<K extends CommanderDesktopOperation> {
  encodeArguments(args: DesktopCommandMap[K]['apiArguments']): JsonValue
  decodeArguments(payload: JsonValue): DesktopCommandMap[K]['apiArguments']
  validateArguments(args: unknown): boolean
  encodeResult(value: unknown): OptionalResult<JsonValue>
  decodeResult(value: JsonValue | undefined): DesktopCommandMap[K]['result']
  validateResult(value: unknown): boolean
  validateWireResult(value: unknown): boolean
}
const fail = (code: 'INVALID_ARGUMENTS' | 'INVALID_RESULT'): never => { throw new ServiceProtocolError(code) }
const shape = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => isRecord(value) && hasExactKeys(value, required, optional)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const text = (value: unknown, max: number = COMMANDER_DESKTOP_LIMITS.fieldBytes): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && new TextEncoder().encode(value).length <= max
const characters = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && text(value, maximum * 4)
export const isCommanderSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
const nullable = (value: unknown, check: (item: unknown) => boolean): boolean => value === null || check(value)
/** Bound traversal before JSON materialization, including nested tool input. */
function boundedJson(value: unknown, maximum: number = COMMANDER_DESKTOP_LIMITS.wireBytes): value is JsonValue {
  let bytes = 0, nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 16_384 || depth > 16 || bytes > maximum) return false
    if (item === null || typeof item === 'boolean') { bytes += 5; return bytes <= maximum }
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; bytes += 32; return bytes <= maximum }
    if (typeof item === 'string') {
      if (item.length > maximum) return false
      bytes += new TextEncoder().encode(JSON.stringify(item)).length
      return bytes <= maximum
    }
    if (Array.isArray(item)) { if (item.length > COMMANDER_DESKTOP_LIMITS.records) return false; bytes += item.length + 2; return item.every(child => visit(child, depth + 1)) }
    if (!isRecord(item)) return false
    const keys = Object.keys(item)
    if (keys.length > 64) return false
    bytes += keys.length * 2 + 2
    return keys.every(key => text(key, 256) && visit(key, depth + 1) && visit(item[key], depth + 1))
  }
  return visit(value, 0)
}
const list = (value: unknown, check: (item: unknown) => boolean, maximum: number = COMMANDER_DESKTOP_LIMITS.records): value is unknown[] => Array.isArray(value) && value.length <= maximum && value.every(check)
const toolCall = (value: unknown): boolean => shape(value, ['id', 'name', 'input']) && identity(value.id) && text(value.name, 256) && !!value.name && isRecord(value.input) && boundedJson(value.input, COMMANDER_DESKTOP_LIMITS.fieldBytes)
const stopReason = (value: unknown): boolean => ['end_turn', 'max_tokens', 'cancelled', 'tool_limit', 'error'].includes(value as string)

function imageInputs(value: unknown): value is ChatImageInput[] {
  if (!Array.isArray(value) || value.length > COMMANDER_DESKTOP_LIMITS.images) return false
  let total = 0
  for (const item of value) {
    if (!shape(item, ['name', 'mimeType', 'data']) || !isChatImageMimeType(item.mimeType) || !text(item.name, 200) ||
      sanitizeChatImageName(item.name, item.mimeType) !== item.name || typeof item.data !== 'string' || item.data.length > Math.ceil(COMMANDER_DESKTOP_LIMITS.imageBytes / 3) * 4) return false
    try {
      const validated = validateChatImageInputs([item])[0]
      if (!validated || validated.mimeType !== item.mimeType || validated.size > COMMANDER_DESKTOP_LIMITS.imageBytes) return false
      const canonical = typeof atob === 'function' && typeof btoa === 'function' ? btoa(atob(item.data)) : Buffer.from(item.data, 'base64').toString('base64')
      if (canonical !== item.data) return false
      total += validated.size
      if (total > COMMANDER_DESKTOP_LIMITS.imageTotalBytes) return false
    } catch { return false }
  }
  return true
}
function encodeImages(images: ChatImageInput[]): CommanderImageEnvelope {
  if (!imageInputs(images)) return fail('INVALID_ARGUMENTS')
  return { version: 1, images: validateChatImageInputs(images).map(image => ({ name: image.name, mimeType: image.mimeType, encoding: 'base64', byteLength: image.size, data: image.data })) }
}
function decodeImages(value: unknown): ChatImageInput[] {
  if (!shape(value, ['version', 'images']) || value.version !== 1 || !Array.isArray(value.images) || value.images.length > COMMANDER_DESKTOP_LIMITS.images) return fail('INVALID_ARGUMENTS')
  const images = value.images.map(item => {
    if (!shape(item, ['name', 'mimeType', 'encoding', 'byteLength', 'data']) || item.encoding !== 'base64' || !integer(item.byteLength) || item.byteLength > COMMANDER_DESKTOP_LIMITS.imageBytes) return fail('INVALID_ARGUMENTS')
    return { name: item.name, mimeType: item.mimeType, data: item.data }
  })
  if (!imageInputs(images)) return fail('INVALID_ARGUMENTS')
  const validated = validateChatImageInputs(images)
  if (validated.some((image, index) => image.size !== (value.images as CommanderImageBytes[])[index].byteLength)) return fail('INVALID_ARGUMENTS')
  return images
}
const imageRef = (value: unknown): boolean => shape(value, ['id', 'name', 'mime_type', 'size']) && isCommanderSessionId(value.id) && text(value.name, 200) && isChatImageMimeType(value.mime_type) && integer(value.size) && value.size <= 5 * 1024 * 1024
export function isCommanderDesktopSession(value: unknown): boolean {
  return shape(value, ['id', 'title', 'created_at', 'updated_at', 'archived', 'last_read_at', 'unread_count'], ['is_report_inbox']) && isCommanderSessionId(value.id) && text(value.title, 2000) && integer(value.created_at) && integer(value.updated_at) &&
    typeof value.archived === 'boolean' && nullable(value.last_read_at, integer) && integer(value.unread_count) && (value.is_report_inbox === undefined || typeof value.is_report_inbox === 'boolean')
}
export function isCommanderDesktopMessage(value: unknown): boolean {
  return shape(value, ['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'tool_name', 'is_error', 'project_id', 'correlation_id', 'created_at'], ['images', 'input_mode']) && identity(value.id) && isCommanderSessionId(value.session_id) && COMMANDER_MESSAGE_ROLES.includes(value.role as never) && text(value.content) &&
    nullable(value.tool_calls, item => list(item, toolCall, COMMANDER_DESKTOP_LIMITS.toolCalls)) && nullable(value.tool_call_id, identity) && nullable(value.tool_name, item => text(item, 256)) && typeof value.is_error === 'boolean' &&
    nullable(value.project_id, isCommanderSessionId) && nullable(value.correlation_id, identity) && integer(value.created_at) &&
    (value.images === undefined || value.role === 'user' && list(value.images, imageRef, COMMANDER_DESKTOP_LIMITS.images)) &&
    (value.input_mode === undefined || value.input_mode === null || value.role === 'user' && ['voice', 'typed'].includes(value.input_mode as string)) && boundedJson(value)
}
function chatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || !text(value.content)) return false
  if (value.role === 'user') return hasExactKeys(value, ['role', 'content'], ['images']) && (value.images === undefined || imageInputs(value.images))
  if (value.role === 'assistant') return hasExactKeys(value, ['role', 'content'], ['toolCalls']) && (value.toolCalls === undefined || list(value.toolCalls, toolCall, COMMANDER_DESKTOP_LIMITS.toolCalls))
  return value.role === 'tool' && hasExactKeys(value, ['role', 'toolCallId', 'name', 'content'], ['isError']) && identity(value.toolCallId) && text(value.name, 256) && (value.isError === undefined || typeof value.isError === 'boolean')
}
function encodeChatMessage(message: ChatMessage): JsonValue {
  return message.role === 'user' && message.images ? { ...message, images: encodeImages(message.images) } as unknown as JsonValue : message as unknown as JsonValue
}
function decodeChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) return fail('INVALID_ARGUMENTS')
  const message = value.role === 'user' && Object.hasOwn(value, 'images') ? { ...value, images: decodeImages(value.images) } : value
  if (!chatMessage(message)) return fail('INVALID_ARGUMENTS')
  return message
}
function chatImagesBounded(messages: ChatMessage[]): boolean {
  let count = 0, bytes = 0
  try {
    for (const message of messages) if (message.role === 'user' && message.images) {
      count += message.images.length
      if (count > COMMANDER_DESKTOP_LIMITS.images) return false
      for (const image of validateChatImageInputs(message.images)) bytes += image.size
      if (bytes > COMMANDER_DESKTOP_LIMITS.imageTotalBytes) return false
    }
  } catch { return false }
  return true
}
const chatRequest = (value: unknown): boolean => shape(value, ['messages'], ['system', 'maxToolCalls']) && boundedJson(value) && list(value.messages, chatMessage) && chatImagesBounded(value.messages as ChatMessage[]) && value.messages.length > 0 && (value.messages.at(-1) as ChatMessage).role !== 'assistant' &&
  (value.system === undefined || text(value.system, 32 * 1024)) && (value.maxToolCalls === undefined || integer(value.maxToolCalls) && value.maxToolCalls <= COMMANDER_DESKTOP_LIMITS.toolCalls) && boundedJson(value)
const activity = (value: unknown): boolean => shape(value, ['epoch', 'sequence', 'turnId', 'phase', 'ageMs', 'openTools', 'hasText'], ['outcome', 'reason']) && identity(value.epoch) && integer(value.sequence) && value.sequence > 0 && nullable(value.turnId, identity) &&
  ['thinking', 'working', 'tool', 'idle', 'error', 'unknown'].includes(value.phase as string) && typeof value.ageMs === 'number' && Number.isFinite(value.ageMs) && value.ageMs >= 0 &&
  list(value.openTools, item => shape(item, ['id', 'name']) && identity(item.id) && text(item.name, 256), COMMANDER_DESKTOP_LIMITS.toolCalls) && typeof value.hasText === 'boolean' &&
  (value.outcome === undefined || ['finished', 'stopped', 'failed'].includes(value.outcome as string)) && (value.reason === undefined || text(value.reason, 4096))
function runtimeEvent(value: unknown, fullDone: boolean): boolean {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'text_delta': return hasExactKeys(value, ['type', 'text']) && text(value.text)
    case 'tool_call_start': return hasExactKeys(value, ['type', 'id', 'name', 'input']) && toolCall({ id: value.id, name: value.name, input: value.input })
    case 'tool_call_result': return hasExactKeys(value, ['type', 'id', 'name', 'content', 'isError']) && identity(value.id) && text(value.name, 256) && text(value.content) && typeof value.isError === 'boolean'
    case 'error': return hasExactKeys(value, ['type', 'message']) && text(value.message, 4096)
    case 'done': return stopReason(value.stopReason) && (fullDone ? hasExactKeys(value, ['type', 'stopReason', 'messages', 'usage']) && list(value.messages, chatMessage) && chatImagesBounded(value.messages as ChatMessage[]) && shape(value.usage, ['inputTokens', 'outputTokens']) && integer(value.usage.inputTokens) && integer(value.usage.outputTokens) : hasExactKeys(value, ['type', 'stopReason']))
    default: return false
  }
}
function commanderEvent(value: unknown): value is CommanderEvent {
  if (!isRecord(value) || value.activity !== undefined && !activity(value.activity)) return false
  switch (value.type) {
    case 'turn_started': return hasExactKeys(value, ['type', 'sessionId', 'turnId'], ['activity']) && isCommanderSessionId(value.sessionId) && identity(value.turnId)
    case 'turn_event': return hasExactKeys(value, ['type', 'sessionId', 'turnId', 'event'], ['activity']) && isCommanderSessionId(value.sessionId) && identity(value.turnId) && runtimeEvent(value.event, false)
    case 'messages_appended': return hasExactKeys(value, ['type', 'sessionId', 'messages'], ['activity', 'turnId']) && isCommanderSessionId(value.sessionId) && list(value.messages, message => isCommanderDesktopMessage(message) && (message as { session_id: string }).session_id === value.sessionId) && (value.turnId === undefined || identity(value.turnId))
    case 'session_updated': return hasExactKeys(value, ['type', 'session'], ['activity']) && isCommanderDesktopSession(value.session)
    default: return false
  }
}

interface Descriptor { args(value: unknown): boolean; encode(args: unknown[]): JsonValue; decode(payload: JsonValue): unknown[]; result(value: unknown): boolean; encodeResult?(value: unknown): JsonValue; decodeResult?(value: JsonValue | undefined): unknown }
const idArg = (key: string) => ({ args: (value: unknown) => Array.isArray(value) && value.length === 1 && isCommanderSessionId(value[0]), encode: (args: unknown[]) => ({ [key]: args[0] as string }), decode: (value: JsonValue) => { if (!shape(value, [key]) || !isCommanderSessionId(value[key])) return fail('INVALID_ARGUMENTS'); return [value[key]] } })
const sessionOrNull = (value: unknown) => value === null || isCommanderDesktopSession(value)
const cancelled = (value: unknown) => shape(value, ['cancelled']) && typeof value.cancelled === 'boolean'
const descriptors: Record<CommanderDesktopOperation, Descriptor> = {
  'commander:listSessions': {
    args: value => Array.isArray(value) && value.length <= 1 && (value[0] === undefined || shape(value[0], [], ['search', 'includeArchived']) && (value[0].search === undefined || characters(value[0].search, COMMANDER_DESKTOP_LIMITS.searchChars)) && (value[0].includeArchived === undefined || typeof value[0].includeArchived === 'boolean')),
    encode: args => { const opts = args[0] as { search?: string; includeArchived?: boolean } | undefined; return { ...(opts?.search === undefined ? {} : { search: opts.search }), ...(opts?.includeArchived === undefined ? {} : { includeArchived: opts.includeArchived }) } },
    decode: value => { if (!shape(value, [], ['search', 'includeArchived'])) return fail('INVALID_ARGUMENTS'); return Object.keys(value).length ? [value] : [] }, result: value => list(value, isCommanderDesktopSession)
  },
  'commander:createSession': {
    args: value => Array.isArray(value) && value.length <= 1 && (value[0] === undefined || shape(value[0], [], ['title']) && (value[0].title === undefined || characters(value[0].title, COMMANDER_DESKTOP_LIMITS.titleChars))),
    encode: args => { const opts = args[0] as { title?: string } | undefined; if (opts?.title === undefined) return {} as JsonValue; return { title: opts.title } }, decode: value => { if (!shape(value, [], ['title'])) return fail('INVALID_ARGUMENTS'); return Object.hasOwn(value, 'title') ? [value] : [] }, result: isCommanderDesktopSession
  },
  'commander:renameSession': { args: value => Array.isArray(value) && value.length === 2 && isCommanderSessionId(value[0]) && characters(value[1], COMMANDER_DESKTOP_LIMITS.titleChars), encode: args => ({ id: args[0] as string, title: args[1] as string }), decode: value => { if (!shape(value, ['id', 'title'])) return fail('INVALID_ARGUMENTS'); return [value.id, value.title] }, result: sessionOrNull },
  'commander:archiveSession': { args: value => Array.isArray(value) && value.length === 2 && isCommanderSessionId(value[0]) && typeof value[1] === 'boolean', encode: args => ({ id: args[0] as string, archived: args[1] as boolean }), decode: value => { if (!shape(value, ['id', 'archived'])) return fail('INVALID_ARGUMENTS'); return [value.id, value.archived] }, result: sessionOrNull },
  'commander:listMessages': { ...idArg('sessionId'), result: value => shape(value, ['messages', 'activeTurnId']) && list(value.messages, isCommanderDesktopMessage) && nullable(value.activeTurnId, identity) },
  'commander:markRead': { ...idArg('sessionId'), result: sessionOrNull },
  'commander:setActiveSession': { args: value => Array.isArray(value) && value.length === 1 && nullable(value[0], isCommanderSessionId), encode: args => ({ sessionId: args[0] as string | null }), decode: value => { if (!shape(value, ['sessionId'])) return fail('INVALID_ARGUMENTS'); return [value.sessionId] }, result: value => value === undefined },
  'commander:send': {
    args: value => Array.isArray(value) && value.length >= 2 && value.length <= 3 && isCommanderSessionId(value[0]) && text(value[1]) && (value[2] === undefined || imageInputs(value[2])) && (!!(value[1] as string).trim() || (value[2] as ChatImageInput[] | undefined)?.length !== undefined && (value[2] as ChatImageInput[]).length > 0),
    encode: args => ({ sessionId: args[0] as string, text: args[1] as string, ...(args[2] === undefined ? {} : { images: encodeImages(args[2] as ChatImageInput[]) as unknown as JsonValue }) }),
    decode: value => { if (!shape(value, ['sessionId', 'text'], ['images'])) return fail('INVALID_ARGUMENTS'); return Object.hasOwn(value, 'images') ? [value.sessionId, value.text, decodeImages(value.images)] : [value.sessionId, value.text] },
    result: value => shape(value, ['turnId', 'message']) && identity(value.turnId) && isCommanderDesktopMessage(value.message)
  },
  'commander:getImage': {
    ...idArg('id'), result: value => value === null || shape(value, ['id', 'name', 'mimeType', 'data']) && isCommanderSessionId(value.id) && imageInputs([{ name: value.name, mimeType: value.mimeType, data: value.data }]),
    encodeResult: value => { if (value === null) return null; const image = value as ChatImageInput & { id: string }; return { version: 1, id: image.id, ...encodeImages([imageInput(image)]).images[0] } as unknown as JsonValue },
    decodeResult: value => { if (value === null) return null; if (!shape(value, ['version', 'id', 'name', 'mimeType', 'encoding', 'byteLength', 'data']) || value.version !== 1 || !isCommanderSessionId(value.id)) return fail('INVALID_RESULT'); const { id, name, mimeType, encoding, byteLength, data } = value; return { id, ...decodeImages({ version: 1, images: [{ name, mimeType, encoding, byteLength, data }] })[0] } }
  },
  'commander:cancel': { ...idArg('sessionId'), result: cancelled },
  'commander:undoAction': { args: value => Array.isArray(value) && value.length === 2 && isCommanderSessionId(value[0]) && identity(value[1]), encode: args => ({ sessionId: args[0] as string, actionId: args[1] as string }), decode: value => { if (!shape(value, ['sessionId', 'actionId'])) return fail('INVALID_ARGUMENTS'); return [value.sessionId, value.actionId] }, result: value => shape(value, ['alreadyUndone', 'message']) && typeof value.alreadyUndone === 'boolean' && isCommanderDesktopMessage(value.message) },
  'commander:getActivity': { ...idArg('sessionId'), result: activity, encodeResult: value => { const snapshot = value as Record<string, JsonValue>; return { ...snapshot, ...(snapshot.phase === 'error' && snapshot.reason !== undefined ? { reason: COMMANDER_DESKTOP_ERROR } : {}) } } },
  'chat:start': {
    args: value => Array.isArray(value) && value.length === 1 && chatRequest(value[0]), encode: args => { const input = args[0] as { messages: ChatMessage[]; system?: string; maxToolCalls?: number }; return { messages: input.messages.map(encodeChatMessage), ...(input.system === undefined ? {} : { system: input.system }), ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }) } },
    decode: value => { if (!shape(value, ['messages'], ['system', 'maxToolCalls']) || !Array.isArray(value.messages) || value.messages.length > COMMANDER_DESKTOP_LIMITS.records) return fail('INVALID_ARGUMENTS'); return [{ ...value, messages: value.messages.map(decodeChatMessage) }] }, result: value => shape(value, ['turnId', 'provider', 'model']) && identity(value.turnId) && text(value.provider, 256) && text(value.model, 512)
  },
  'chat:cancel': { ...idArg('turnId'), result: cancelled }
}
function imageInput(image: ChatImageInput): ChatImageInput { return { name: image.name, mimeType: image.mimeType, data: image.data } }
function commandCodec<K extends CommanderDesktopOperation>(operation: K): CommanderCommandCodec<K> {
  const descriptor = descriptors[operation]
  return {
    validateArguments: descriptor.args,
    encodeArguments(args) { if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); const value = descriptor.encode(args); if (!boundedJson(value)) return fail('INVALID_ARGUMENTS'); return value },
    decodeArguments(payload) { if (!boundedJson(payload)) return fail('INVALID_ARGUMENTS'); const args = descriptor.decode(payload); if (!descriptor.args(args)) return fail('INVALID_ARGUMENTS'); return args as DesktopCommandMap[K]['apiArguments'] },
    validateResult: value => descriptor.result(value) && (value === undefined || boundedJson(value)),
    encodeResult(value) { if (!descriptor.result(value) || value !== undefined && !boundedJson(value)) return fail('INVALID_RESULT'); if (value === undefined) return { defined: false }; const wire = descriptor.encodeResult ? descriptor.encodeResult(value) : value; if (!boundedJson(wire)) return fail('INVALID_RESULT'); return { defined: true, value: wire } },
    decodeResult(value) {
      try { const result = descriptor.decodeResult ? descriptor.decodeResult(value) : value; if (!descriptor.result(result) || result !== undefined && !boundedJson(result)) return fail('INVALID_RESULT'); return result as DesktopCommandMap[K]['result'] }
      catch { return fail('INVALID_RESULT') }
    },
    validateWireResult(value) {
      try {
        if (!shape(value, ['defined'], ['value']) || typeof value.defined !== 'boolean' || value.defined !== Object.hasOwn(value, 'value')) return false
        if (value.defined && !boundedJson(value.value)) return false
        const result = descriptor.decodeResult ? descriptor.decodeResult(value.value as JsonValue | undefined) : value.value
        return descriptor.result(result) && (result === undefined || boundedJson(result))
      } catch { return false }
    }
  }
}
export const COMMANDER_COMMAND_CODECS = Object.fromEntries(COMMANDER_DESKTOP_OPERATIONS.map(operation => [operation, commandCodec(operation)])) as { [K in CommanderDesktopOperation]: CommanderCommandCodec<K> }

function encodeRuntimeEvent(event: ChatRuntimeEvent | Exclude<ChatRuntimeEvent, { type: 'done' }> | { type: 'done'; stopReason: string }, fullDone: boolean): JsonValue {
  if (event.type === 'error') return { type: 'error', message: fullDone ? CHAT_DESKTOP_ERROR : COMMANDER_DESKTOP_ERROR }
  if (event.type === 'done' && fullDone && 'messages' in event) return { ...event, messages: event.messages.map(encodeChatMessage) } as unknown as JsonValue
  return event as unknown as JsonValue
}
function isCommanderDesktopEvent(value: unknown): value is DesktopEventMap['commander:event'] { return commanderEvent(value) && boundedJson(value) }
function isChatDesktopEvent(value: unknown): value is DesktopEventMap['chat:event'] { return shape(value, ['turnId', 'event']) && identity(value.turnId) && runtimeEvent(value.event, true) && boundedJson(value) }
export const COMMANDER_EVENT_CODECS = {
  'commander:event': {
    validatePayload: isCommanderDesktopEvent,
    encodePayload(value: CommanderEvent): JsonValue {
      if (!isCommanderDesktopEvent(value)) return fail('INVALID_ARGUMENTS')
      return { ...value, ...(value.type === 'turn_event' ? { event: encodeRuntimeEvent(value.event, false) } : {}), ...(value.activity?.phase === 'error' && value.activity.reason !== undefined ? { activity: { ...value.activity, reason: COMMANDER_DESKTOP_ERROR } } : {}) } as unknown as JsonValue
    },
    decodePayload(value: JsonValue): DesktopEventMap['commander:event'] { if (!isCommanderDesktopEvent(value)) return fail('INVALID_ARGUMENTS'); return value }
  },
  'chat:event': {
    validatePayload: isChatDesktopEvent,
    encodePayload(value: DesktopEventMap['chat:event']): JsonValue { if (!isChatDesktopEvent(value)) return fail('INVALID_ARGUMENTS'); const event = encodeRuntimeEvent(value.event, true); return { turnId: value.turnId, event } },
    decodePayload(value: JsonValue): DesktopEventMap['chat:event'] {
      if (!boundedJson(value) || !shape(value, ['turnId', 'event']) || !identity(value.turnId) || !isRecord(value.event)) return fail('INVALID_ARGUMENTS')
      const event = value.event.type === 'done' && Array.isArray(value.event.messages) ? { ...value.event, messages: value.event.messages.map(decodeChatMessage) } : value.event
      const decoded = { turnId: value.turnId, event }
      if (!isChatDesktopEvent(decoded)) return fail('INVALID_ARGUMENTS')
      return decoded
    }
  }
} as const
