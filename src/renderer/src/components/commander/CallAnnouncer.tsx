import { useCallback, useEffect, useRef, useState } from 'react'
import { commanderApi } from '@/lib/ipc-client'
import { activityNow } from '@/lib/activity/activity-clock'
import { parseCommanderAction } from '@shared/commander-action'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { selectSpeechReady, useVoiceStore } from '@/stores/voice-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useUIStore } from '@/stores/ui-store'
import { toolCallLabel } from './tool-call-label'
import { useCallPresentation } from './use-call-presentation'

interface ReplyTurn {
  sessionId: string
  turnId: string
  spoken: boolean
  failed: boolean
  settled: boolean
  text: string
  reply: { id: string; text: string } | null
}
const MAX_REPLY_CHARACTERS = 64_000

function speechIntendedFor(sessionId: string): boolean {
  const call = useCommanderCallStore.getState()
  const voice = useVoiceStore.getState()
  return call.status !== 'off' && call.sessionId === sessionId && voice.tts?.enabled === true && selectSpeechReady(voice)
}

/** The sole live-region owner for Commander, across full view and PiP. */
export function CallAnnouncer() {
  const { call, selected, presentation, observation, speechOutput, fresh } = useCallPresentation()
  const view = useUIStore(s => s.sidebarView)
  const action = useCommanderStore(s => s.recentAction)
  const turnError = useCommanderStore(s => selected ? s.turnErrors[selected] : undefined)
  const notice = useCommanderCallUiStore(s => s.notice)
  const [polite, setPolite] = useState({ key: '', text: '' })
  const [assertive, setAssertive] = useState({ key: '', text: '' })
  const seen = useRef(new Set<string>())
  const lastError = useRef<string | null>(null)
  const errorSequence = useRef(0)
  const replyTurns = useRef(new Map<string, ReplyTurn>())
  const sessionTurns = useRef(new Map<string, string>())
  const current = useRef({ sessionId: call.sessionId ?? selected, speechOutput, visible: view === 'commander' || call.status !== 'off' })
  current.current = { sessionId: call.sessionId ?? selected, speechOutput, visible: view === 'commander' || call.status !== 'off' }
  const announce = useCallback((key: string, text: string, urgent = false) => {
    if (!text || seen.current.has(key)) return
    seen.current.add(key)
    if (seen.current.size > 200) seen.current.delete(seen.current.values().next().value!)
    if (urgent) setAssertive({ key, text }); else setPolite({ key, text })
  }, [])
  const active = view === 'commander' || call.status !== 'off' || !!call.error
  const thinking = active && fresh && !!observation && (presentation.state === 'thinking' || call.status === 'off' && observation.phase === 'thinking')
  useEffect(() => {
    if (!thinking) return
    const id = observation!.turnId
    const timer = window.setTimeout(() => announce(`thinking:${id}`, 'Commander is thinking.'), 1_000)
    return () => window.clearTimeout(timer)
  }, [thinking, observation?.turnId, announce])
  useEffect(() => {
    if (active && presentation.state === 'unavailable' && presentation.detail) announce(`unavailable:${presentation.detail}`, presentation.detail)
    const error = call.error ?? (presentation.state === 'error' ? presentation.detail : null) ?? (view === 'commander' ? turnError : null)
    const key = error ? `${call.sessionId ?? selected}:${error}` : null
    if (active && error && key !== lastError.current) announce(`error:${++errorSequence.current}`, error, true)
    lastError.current = key
  }, [active, presentation.state, presentation.detail, call.error, call.sessionId, view, selected, turnError, announce])
  useEffect(() => {
    if (!action || action.result.session_id !== current.current.sessionId || activityNow() - action.observedAt >= 8_000) return
    const parsed = parseCommanderAction(action.call.name, action.result.content, action.result.is_error)
    if (parsed) announce(`action:${action.result.session_id}:${action.call.id}`, `${toolCallLabel(action.call.name, {})}: ${parsed.target.name}.`, parsed.severity === 'destructive')
  }, [action, announce])
  useEffect(() => {
    if (notice) announce(`notice:${notice.id}`, notice.text, notice.assertive)
  }, [notice, announce])
  useEffect(() => {
    if (!speechOutput || !call.sessionId) return
    const key = sessionTurns.current.get(call.sessionId)
    const turn = key ? replyTurns.current.get(key) : null
    if (turn && !turn.settled) turn.spoken = true
  }, [speechOutput, call.sessionId])
  useEffect(() => {
    try {
      return commanderApi.onEvent(event => {
        const keyOf = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`
        if (event.type === 'turn_started') {
          const key = keyOf(event.sessionId, event.turnId)
          const previousKey = sessionTurns.current.get(event.sessionId)
          const previous = previousKey ? replyTurns.current.get(previousKey) : null
          if (previous && previousKey !== key && !previous.settled) previous.failed = true
          if (!replyTurns.current.has(key)) replyTurns.current.set(key, {
            sessionId: event.sessionId, turnId: event.turnId, spoken: speechIntendedFor(event.sessionId), failed: false, settled: false, text: '', reply: null
          })
          sessionTurns.current.set(event.sessionId, key)
          if (replyTurns.current.size > 100) {
            const retiredKey = replyTurns.current.keys().next().value!
            const retired = replyTurns.current.get(retiredKey)!
            replyTurns.current.delete(retiredKey)
            if (sessionTurns.current.get(retired.sessionId) === retiredKey) sessionTurns.current.delete(retired.sessionId)
          }
          return
        }
        if (event.type === 'turn_event') {
          const key = keyOf(event.sessionId, event.turnId)
          const turn = replyTurns.current.get(key)
          if (!turn || turn.settled) return
          turn.spoken ||= speechIntendedFor(event.sessionId)
          const inner = event.event
          if (inner.type === 'text_delta' && !turn.failed) turn.text = (turn.text + inner.text).slice(-MAX_REPLY_CHARACTERS)
          if (inner.type === 'tool_call_start') turn.reply = null
          if (inner.type === 'error') { turn.failed = true; turn.reply = null; turn.text = '' }
          if (inner.type === 'done') {
            turn.settled = true
            const now = current.current
            if (inner.stopReason === 'end_turn' && !turn.failed && !turn.spoken && turn.reply && now.visible && now.sessionId === event.sessionId) {
              announce(`reply:${key}`, turn.reply.text)
            }
            turn.reply = null
            turn.text = ''
            if (sessionTurns.current.get(event.sessionId) === key) sessionTurns.current.delete(event.sessionId)
          }
          return
        }
        if (event.type !== 'messages_appended') return
        const now = current.current
        // Explicit turn provenance, when supplied by main, is authoritative.
        // Legacy event groups additionally need matching streamed final text;
        // unobserved history, context notices and retired turns fail closed.
        const suppliedTurn = event.turnId
        const key = suppliedTurn ? keyOf(event.sessionId, suppliedTurn) : sessionTurns.current.get(event.sessionId)
        const turn = key ? replyTurns.current.get(key) : null
        if (turn && !turn.settled) turn.spoken ||= speechIntendedFor(event.sessionId)
        for (const message of event.messages) {
          if (message.role === 'report') {
            announce(`report:${message.id}`, event.sessionId === now.sessionId ? 'New project report in Chat.' : 'New project report in Project reports.')
          } else if (turn && !turn.settled && message.role === 'assistant' && !message.tool_name) {
            if (message.tool_calls?.length) { turn.reply = null; continue }
            const text = message.content.trim()
            if (text && !text.startsWith('[21x context]') && (suppliedTurn || turn.text.trim().endsWith(text.slice(-MAX_REPLY_CHARACTERS)))) turn.reply = { id: message.id, text: text.length > MAX_REPLY_CHARACTERS ? `${text.slice(0, MAX_REPLY_CHARACTERS)}… Full reply available in Chat.` : text }
          }
        }
      })
    } catch { return undefined }
  }, [announce])
  return <div className="ui-scale sr-only" data-testid="commander-call-announcer"><div role="status" aria-live="polite" aria-atomic="true" className="text-sm" data-testid="commander-polite-announcer"><span key={polite.key}>{polite.text}</span></div><div role="alert" aria-live="assertive" aria-atomic="true" className="text-sm" data-testid="commander-assertive-announcer"><span key={assertive.key}>{assertive.text}</span></div></div>
}
