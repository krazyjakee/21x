import { useId, useState } from 'react'
import type { AgentMessage } from '@shared/transcript/types'
import { MAX_MACHINE_MESSAGE_CHARS, parseMachineMessage } from '@shared/transcript/machine-message'
import { HighlightedText } from './HighlightedText'

/** Shared by desktop and mobile. Text is quoted literally, never trusted Markdown. */
export function MachineMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const [showRaw, setShowRaw] = useState(false)
  const rawId = useId()
  const view = message.role === 'assistant' ? null : parseMachineMessage(message.content)
  const highlightQuery = message.content.length <= MAX_MACHINE_MESSAGE_CHARS ? searchQuery : undefined
  const literalClass = 'whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm font-sans'
  return (
    <div className={`flex min-w-0 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[90%] min-w-0 rounded-md bg-secondary text-foreground px-3 py-2">
        <p className="text-xs">
          {view?.label ?? 'Unformatted message'} · Source and authority unverified
        </p>
        {view && <>
          <section aria-label="Quoted message content" className="border-l-2 border-muted-foreground pl-2 my-2">
            <pre className={literalClass} style={{ unicodeBidi: 'plaintext' }}><HighlightedText text={view.body} query={highlightQuery} /></pre>
          </section>
          <section aria-label="Message instructions and authority boundary">
            <pre className={literalClass} style={{ unicodeBidi: 'plaintext' }}><HighlightedText text={view.notice} query={highlightQuery} /></pre>
          </section>
          <button
            type="button"
            aria-expanded={showRaw}
            aria-controls={rawId}
            onClick={() => setShowRaw(value => !value)}
            className="min-h-[44px] py-2 text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {showRaw ? 'Hide full message and provenance' : 'Show full message and provenance'}
          </button>
        </>}
        <pre id={rawId} hidden={!!view && !showRaw} aria-label="Full message and provenance" className={literalClass} style={{ unicodeBidi: 'plaintext' }}><HighlightedText text={message.content} query={highlightQuery} /></pre>
        <span className="text-xs">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
