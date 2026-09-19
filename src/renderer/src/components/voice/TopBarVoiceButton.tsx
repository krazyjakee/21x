import { useCallback } from 'react'
import { VoiceMicButton } from './VoiceMicButton'
import { useUIStore } from '@/stores/ui-store'
import { useVoiceStore } from '@/stores/voice-store'
import { CAPTAIN_COMPOSER_KEY } from '@/lib/voice-dictation-target'

export { CAPTAIN_COMPOSER_KEY } from '@/lib/voice-dictation-target'

/**
 * Start talking to Captain from anywhere.
 *
 * The button sits beside the Captain control in the top bar, so it is
 * reachable from every view. It names the Captain composer explicitly: a
 * turn started away from a text box would otherwise write the words nowhere,
 * which is what the global shortcut does on purpose.
 *
 * It opens the drawer first, so the user watches the words arrive in a box they
 * can edit and send, rather than into something hidden.
 *
 * It hides itself when voice is unavailable or switched off, like every other
 * voice control.
 */
export function TopBarVoiceButton(): React.JSX.Element | null {
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const conversational = useVoiceStore((s) => s.conversation)

  const revealComposer = useCallback(() => {
    setShowOrchestrator(true)
  }, [setShowOrchestrator])

  return (
    <VoiceMicButton
      composerKey={CAPTAIN_COMPOSER_KEY}
      onBeforeStart={revealComposer}
      // The loudest control in the bar — by colour, not by size. Speaking is
      // the point here and the written word beside it is the fallback.
      emphasis="strong"
      className="h-8 w-8"
      title={
        conversational
          ? 'Talk to Captain. Each pause sends what you said.'
          : 'Dictate to Captain'
      }
    />
  )
}
