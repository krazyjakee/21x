import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import type { CallPresentation } from '@/lib/commander-call/derive-call-state'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/Dialog'
import { commanderCallMedia } from './CommanderCallHost'

export function useCommanderCaption(presentation: CallPresentation) {
  const call = useCommanderCallStore()
  const sessionId = useCommanderStore(s => call.sessionId ?? s.selectedSessionId)
  const streaming = useCommanderStore(s => sessionId ? s.streaming[sessionId] : undefined)
  // Caption snapshots are sentence/word updates, never audio-level frames.
  const partial = useVoiceStore(s => s.partial)
  const final = useVoiceStore(s => s.final)
  const speechText = useVoiceStore(s => s.speechText)
  void partial; void final; void speechText
  const user = commanderCallMedia.userCaption
  const assistant = commanderCallMedia.assistantCaption
  const words = user.partial.trim() || user.final.trim() || call.userCaption
  const spoken = presentation.state === 'speaking' && assistant.speaking
  const textReply = presentation.textOnly && !user.partial.trim() ? streaming?.text : ''
  const text = spoken ? assistant.text : textReply || (presentation.state === 'interrupted' ? '(interrupted)' : words || (call.status === 'starting' ? 'Starting voice conversation…' : call.status === 'live' ? call.micMode === 'push-to-talk' && !call.turnId ? 'Hold Space to talk' : presentation.label : ''))
  return { text, speaker: spoken || textReply ? 'Commander' : words ? 'You' : 'Voice', partial: !!user.partial, spoken }
}

export type CommanderCaption = ReturnType<typeof useCommanderCaption>

export function CommanderCaptions({ caption, compact = false }: { caption: CommanderCaption; compact?: boolean }) {
  const enabled = useCommanderCallUiStore(s => s.captions)
  const size = useCommanderCallUiStore(s => s.captionSize)
  if (!enabled || !caption.text) return null
  return <div className={`commander-caption-strip commander-captions-${size} ${compact ? 'commander-pip-captions' : ''}`} data-testid="commander-voice-status">
    <Dialog><div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{caption.speaker}</p>
      <p className={`commander-caption-text leading-relaxed ${caption.partial ? 'italic' : ''}`}>
        {caption.spoken ? <mark className="rounded bg-primary/10 text-foreground">{caption.text}</mark> : caption.text}
      </p></div>
      <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label="Read full captions">CC</Button></DialogTrigger>
      <DialogContent className={`ui-scale commander-captions-${size}`} aria-describedby="commander-caption-description"><DialogHeader><DialogTitle>Captions</DialogTitle><DialogDescription id="commander-caption-description">The current sentence is shown in full. Completed messages remain in Chat.</DialogDescription></DialogHeader>
        <label className="mx-6 flex items-center gap-2 text-sm">Caption size<select aria-label="Caption size" value={size} onChange={event => useCommanderCallUiStore.getState().setCaptionSize(event.target.value as typeof size)}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
        <p className="commander-caption-full whitespace-pre-wrap break-words p-6 leading-relaxed">{caption.text}</p>
      </DialogContent>
    </Dialog>
  </div>
}

