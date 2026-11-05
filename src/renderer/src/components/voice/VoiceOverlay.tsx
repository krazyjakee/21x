import { useEffect } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import type { VoiceCandidate } from '@shared/voice'

const RESULT_VISIBLE_MS = 6000

/**
 * The in-app voice surface (design §5.3 and §5.5): an explicit confirmation card
 * for every action that needs one, and the outcome of a voice action.
 *
 * Listening draws nothing here. The microphone button lights up and stops the
 * turn, and the one in the top bar does that for every turn, so a bubble only
 * covered the controls under it.
 *
 * Confirmation is always visual. A spoken "yes" never approves anything, so a
 * mis-heard word cannot start or approve work on its own.
 *
 * Reading aloud shows nothing. The user hears the answer, so a bubble that says
 * so tells them what they already know and covers the screen while it does it.
 * Escape still stops the reading, and so does speaking.
 */
export function VoiceOverlay() {
  // Hidden until the optional runtime is installed and voice is switched on.
  const ready = useVoiceStore(selectVoiceReady)
  const state = useVoiceStore((s) => s.state)
  const confirmation = useVoiceStore((s) => s.confirmation)
  const result = useVoiceStore((s) => s.result)
  const confirm = useVoiceStore((s) => s.confirm)
  const dismiss = useVoiceStore((s) => s.dismiss)
  const cancel = useVoiceStore((s) => s.cancel)
  const clearResult = useVoiceStore((s) => s.clearResult)
  // Nothing is drawn while an answer is read, but Escape must still stop it.
  const speaking = useVoiceStore((s) => s.speaking)
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking)
  const commanderCallLive = useCommanderCallStore((s) => s.status !== 'off')
  const commanderTurnId = useCommanderCallStore(s => s.turnId)
  const voiceTurnId = useVoiceStore(s => s.turnId)
  const commanderOwnsVoice = commanderCallLive && (!voiceTurnId || voiceTurnId === commanderTurnId)

  // Escape cancels the current turn or the open confirmation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // The app-level Commander host owns Escape for a live call. Letting this
      // generic overlay cancel the same microphone turns a normal Stop into a
      // false media-loss error. A confirmation is never the call's: the host
      // leaves it alone, so Escape has to dismiss it here.
      if (commanderOwnsVoice && !confirmation) return
      if (confirmation) void dismiss()
      else if (state === 'listening') void cancel()
      // Escape also stops speech. It is the one key a user reaches for when
      // the app is talking and they want it to stop.
      else if (speaking) void stopSpeaking()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commanderOwnsVoice, confirmation, state, dismiss, cancel, speaking, stopSpeaking])

  useEffect(() => {
    if (!result) return undefined
    const timer = setTimeout(clearResult, RESULT_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [result, clearResult])

  if (!ready) return null

  if (!confirmation && !result) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
      data-testid="voice-overlay"
    >
      {confirmation && (
        <div
          className="pointer-events-auto w-full max-w-xl rounded-2xl border border-yellow-500/40 bg-card/98 p-4 shadow-xl backdrop-blur"
          role="alertdialog"
          aria-label="Confirm the voice command"
          data-testid="voice-confirmation"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{confirmation.proposal.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Heard: “{confirmation.proposal.transcript}” · {reasonText(confirmation.reason)}
              </p>

              {confirmation.candidates && confirmation.candidates.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {confirmation.candidates.map((candidate: VoiceCandidate) => (
                    <Button
                      key={`${candidate.kind}-${candidate.id}`}
                      size="sm"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() =>
                        void confirm(
                          candidate.kind === 'task'
                            ? { taskId: candidate.id }
                            : { agentName: candidate.label }
                        )
                      }
                    >
                      {candidate.label}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" className="w-full" onClick={() => void dismiss()}>
                    None of these
                  </Button>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" onClick={() => void confirm()} data-testid="voice-confirm-yes">
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Confirm
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void dismiss()}>
                    <X className="mr-1.5 h-3.5 w-3.5" />
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`pointer-events-auto max-w-xl rounded-xl border px-4 py-2 text-sm shadow-lg backdrop-blur ${
            result.kind === 'ok'
              ? 'border-border bg-card/95 text-foreground'
              : 'border-red-500/40 bg-card/95 text-red-400'
          }`}
          role="status"
          data-testid="voice-result"
        >
          {result.message}
        </div>
      )}
    </div>
  )
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'destructive':
      return 'this answers the agent, so it needs a second confirmation'
    case 'ambiguous_task':
      return 'more than one task matches'
    case 'ambiguous_agent':
      return 'more than one agent matches'
    case 'low_confidence':
      return 'the words were not clear'
    default:
      return 'confirm to continue'
  }
}
