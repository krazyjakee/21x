import { useState } from 'react'
import { AlertCircle, Cloud, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { useVoiceStore } from '@/stores/voice-store'
import {
  VOICE_TTS_ELEVENLABS_DEFAULT_MODEL,
  VOICE_TTS_ELEVENLABS_DISCLOSURE,
  VOICE_TTS_ELEVENLABS_PRIVACY_URL,
  VOICE_TTS_ELEVENLABS_TERMS_URL,
  type VoiceTtsElevenLabsErrorKind,
  type VoiceTtsSnapshot
} from '@shared/voice-tts'

/** What the user can do about each kind of failure. */
const ERROR_HINTS: Record<VoiceTtsElevenLabsErrorKind, string> = {
  auth: 'Replace the key below.',
  permission: 'Enable Voices Read and Text to Speech for this key in ElevenLabs, then press Reload.',
  quota: 'Add credits to the ElevenLabs account, or switch back to a voice on this computer.',
  rate_limit: 'Wait a moment, then press Reload.',
  unsupported_model: 'Choose another model below.',
  network: 'Check the connection, then press Reload.',
  unknown: 'Press Reload to try again.'
}

/**
 * The ElevenLabs engine (#64): the disclosure, the bring-your-own key, and the
 * model choice.
 *
 * The key field is write-only. It is sent to main once and cleared; the page
 * only ever learns whether a key is saved. Written replies never depend on
 * anything here — a failure is shown and speech stays quiet.
 */
export function ElevenLabsSettings({ tts }: { tts: VoiceTtsSnapshot }) {
  const state = tts.elevenlabs
  const setElevenLabsKey = useVoiceStore((s) => s.setElevenLabsKey)
  const clearElevenLabsKey = useVoiceStore((s) => s.clearElevenLabsKey)
  const acceptElevenLabsDisclosure = useVoiceStore((s) => s.acceptElevenLabsDisclosure)
  const refreshElevenLabs = useVoiceStore((s) => s.refreshElevenLabs)
  const setElevenLabsModel = useVoiceStore((s) => s.setElevenLabsModel)
  const setTtsEngine = useVoiceStore((s) => s.setTtsEngine)

  const [agreed, setAgreed] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const saveKey = (): void => {
    const key = draftKey.trim()
    if (!key) return
    // Cleared at once: the key must not sit in the page's state.
    setDraftKey('')
    void run(() => setElevenLabsKey(key))
  }

  const selected = tts.engine === 'elevenlabs'
  const modelChoices = state.models.length > 0
    ? state.models
    : [{ id: state.modelId || VOICE_TTS_ELEVENLABS_DEFAULT_MODEL, name: state.modelId || VOICE_TTS_ELEVENLABS_DEFAULT_MODEL, description: '', languages: [] }]

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="tts-elevenlabs">
      <div className="flex items-start gap-2">
        <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-0.5">
          <Label>ElevenLabs (online)</Label>
          <p className="text-xs text-muted-foreground">
            A hosted voice with your own ElevenLabs API key. Never the default, and never used unless you choose it here.
          </p>
        </div>
      </div>

      {!state.disclosureAccepted ? (
        <div className="space-y-2 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3" data-testid="tts-elevenlabs-disclosure">
          <p className="text-sm font-medium text-foreground">Before you use ElevenLabs</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {VOICE_TTS_ELEVENLABS_DISCLOSURE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Read the ElevenLabs{' '}
            <a href={VOICE_TTS_ELEVENLABS_TERMS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              terms
            </a>{' '}
            and{' '}
            <a href={VOICE_TTS_ELEVENLABS_PRIVACY_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              privacy policy
            </a>
            .
          </p>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} data-testid="tts-elevenlabs-agree" />
            I understand that reply text leaves this computer and may use paid credits.
          </label>
          <Button
            size="sm"
            disabled={!agreed || busy}
            onClick={() => void run(acceptElevenLabsDisclosure)}
            data-testid="tts-elevenlabs-accept"
          >
            Continue
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="tts-elevenlabs-key" className="flex items-center gap-1.5 text-xs">
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              API key {state.keySet && <span className="text-muted-foreground">— saved</span>}
            </Label>
            <div className="flex gap-2">
              <Input
                id="tts-elevenlabs-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draftKey}
                placeholder={state.keySet ? 'Paste a new key to replace it' : 'Paste your ElevenLabs API key'}
                onChange={(e) => setDraftKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveKey()
                }}
                data-testid="tts-elevenlabs-key"
              />
              <Button size="sm" disabled={!draftKey.trim() || busy} onClick={saveKey} data-testid="tts-elevenlabs-save-key">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state.keySet ? 'Replace' : 'Save'}
              </Button>
              {state.keySet && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(clearElevenLabsKey)}
                  aria-label="Remove the ElevenLabs key"
                  data-testid="tts-elevenlabs-remove-key"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Stored encrypted with the system keychain when it is available. It is never shown again.
            </p>
          </div>

          {state.error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="tts-elevenlabs-error">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {state.error.message} {ERROR_HINTS[state.error.kind]}
              </span>
            </div>
          )}

          {state.keySet && (
            <>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="tts-elevenlabs-model" className="text-xs">Model</Label>
                <div className="flex items-center gap-2">
                  <select
                    id="tts-elevenlabs-model"
                    className="rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground"
                    value={state.modelId}
                    onChange={(e) => void setElevenLabsModel(e.target.value)}
                    data-testid="tts-elevenlabs-model"
                  >
                    {modelChoices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.id === VOICE_TTS_ELEVENLABS_DEFAULT_MODEL ? ' (fastest, default)' : ''}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(refreshElevenLabs)} data-testid="tts-elevenlabs-refresh">
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Reload
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {state.voices.length} voice{state.voices.length === 1 ? '' : 's'} on the account
                {state.usage && state.usage.limit > 0
                  ? ` · ${state.usage.used.toLocaleString()} of ${state.usage.limit.toLocaleString()} characters used this period`
                  : ''}
                . Only models that support streaming are listed.
              </p>
            </>
          )}

          {!selected && (
            <Button
              size="sm"
              disabled={!state.keySet || busy}
              onClick={() => void setTtsEngine('elevenlabs')}
              data-testid="tts-engine-elevenlabs"
            >
              Use ElevenLabs
            </Button>
          )}
        </>
      )}
    </div>
  )
}
