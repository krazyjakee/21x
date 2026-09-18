import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Radio, Send, Square } from 'lucide-react'
import type { CommanderMessage } from '@shared/commander'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Markdown } from '@/components/ui/Markdown'
import { useCommanderStore } from '@/stores/commander-store'
import { CommanderMessageItem, ToolChip } from './CommanderMessageItem'
import { UNTITLED_SESSION } from './CommanderSessionList'

const EMPTY: CommanderMessage[] = []

export const COMMANDER_EMPTY_DESCRIPTION =
  'The Commander is a fast chat that coordinates your projects. It hands work to each project’s Mastermind and relays their reports back here — it never does the work itself.'

/** The open session: history, the streaming turn, and the composer. */
export function CommanderChatPane() {
  const sessionId = useCommanderStore((s) => s.selectedSessionId)
  const session = useCommanderStore((s) => s.sessions.find((x) => x.id === s.selectedSessionId))
  const messages = useCommanderStore((s) => (s.selectedSessionId ? s.messages[s.selectedSessionId] : undefined)) ?? EMPTY
  const streaming = useCommanderStore((s) => (s.selectedSessionId ? s.streaming[s.selectedSessionId] : undefined))
  const turnError = useCommanderStore((s) => (s.selectedSessionId ? s.turnErrors[s.selectedSessionId] : undefined))
  const send = useCommanderStore((s) => s.send)
  const cancel = useCommanderStore((s) => s.cancel)
  const createSession = useCommanderStore((s) => s.createSession)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const toolResults = useMemo(() => {
    const map = new Map<string, CommanderMessage>()
    for (const m of messages) if (m.role === 'tool' && m.tool_call_id) map.set(m.tool_call_id, m)
    return map
  }, [messages])

  const visible = useMemo(() => messages.filter((m) => m.role !== 'tool' && m.role !== 'summary'), [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visible.length, streaming?.text, streaming?.toolCalls.length])

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={Radio}
          title="Talk to the Commander"
          description={COMMANDER_EMPTY_DESCRIPTION}
          action={<Button size="sm" onClick={() => void createSession()}>New session</Button>}
        />
      </div>
    )
  }

  const busy = !!streaming
  const submit = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    const ok = await send(text)
    if (!ok) setDraft(text)
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Commander chat">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <h2 className="truncate text-sm font-medium">{session?.title || UNTITLED_SESSION}</h2>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="commander-messages">
        {visible.length === 0 && !streaming && (
          <p className="mx-auto max-w-md pt-10 text-center text-xs leading-relaxed text-muted-foreground/70">{COMMANDER_EMPTY_DESCRIPTION}</p>
        )}
        {visible.map((m) => (
          <CommanderMessageItem key={m.id} message={m} toolResults={toolResults} />
        ))}
        {streaming && (
          <div className="flex flex-col gap-1.5" data-testid="commander-streaming">
            {streaming.text ? (
              <div className="max-w-[88%] text-sm text-foreground">
                <Markdown size="sm">{streaming.text}</Markdown>
              </div>
            ) : streaming.toolCalls.length === 0 ? (
              <div className="flex gap-1 py-1" aria-label="Commander is thinking">
                <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
                <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
              </div>
            ) : null}
            {streaming.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {streaming.toolCalls.map((c) => (
                  <ToolChip key={c.id} name={c.name} input={c.input} result={c.result} isError={c.isError} />
                ))}
              </div>
            )}
          </div>
        )}
        {turnError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{turnError}</span>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-input bg-card px-3 py-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <textarea
            aria-label="Message the Commander"
            rows={1}
            value={draft}
            placeholder="Ask the Commander…"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {busy ? (
            <Button size="icon" variant="secondary" aria-label="Stop" onClick={() => void cancel()}>
              <Square className="size-3.5" aria-hidden="true" />
            </Button>
          ) : (
            <Button size="icon" aria-label="Send" disabled={!draft.trim()} onClick={() => void submit()}>
              <Send className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
