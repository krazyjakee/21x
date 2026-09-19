import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Radio, Send, Square } from 'lucide-react'
import type { CommanderMessage } from '@shared/commander'
import {
  CHAT_SETTING_KEYS,
  chatProviderForAgentModel,
  isChatReasoningEffort,
  type ChatProviderId,
  type ChatReasoningEffort
} from '@shared/chat'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Markdown } from '@/components/ui/Markdown'
import { settingsApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import { useCommanderStore } from '@/stores/commander-store'
import type { Agent } from '@/types'
import { CommanderMessageItem, ToolChip } from './CommanderMessageItem'
import { UNTITLED_SESSION } from './CommanderSessionList'

const EMPTY: CommanderMessage[] = []

interface ConfiguredModelOption {
  agentId: string
  agentName: string
  provider: ChatProviderId
  model: string
  reasoningEffort: ChatReasoningEffort | ''
}

function configuredModelOptions(agents: Agent[]): ConfiguredModelOption[] {
  return [...agents]
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))
    .flatMap((agent) => {
      const model = agent.config.model?.trim()
      const provider = chatProviderForAgentModel(agent.config.coding_agent, model)
      // model is non-empty here, so provider always resolves
      if (!model || !provider) return []
      return [{
        agentId: agent.id,
        agentName: agent.name,
        provider,
        model,
        reasoningEffort: isChatReasoningEffort(agent.config.reasoning_effort)
          ? agent.config.reasoning_effort
          : ''
      }]
    })
}

function thinkingOptions(provider: ChatProviderId): ChatReasoningEffort[] {
  return provider === 'anthropic'
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['minimal', 'low', 'medium', 'high', 'xhigh']
}

export const COMMANDER_EMPTY_DESCRIPTION =
  'The Commander is a fast chat that coordinates your projects. It hands work to each project’s Captain and relays their reports back here — it never does the work itself.'

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
  // Read agents from the shared store so the dropdown tracks agent edits made
  // elsewhere in the app (e.g. Agents settings) — never a stale one-time fetch.
  const agents = useAgentStore((s) => s.agents)
  const agentsLoading = useAgentStore((s) => s.isLoading)
  const [settings, setSettings] = useState<Record<string, string> | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ChatReasoningEffort | ''>('')
  const [configLoaded, setConfigLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const configWrite = useRef<Promise<void>>(Promise.resolve())
  const fetchAttempted = useRef(false)

  const queueConfigWrite = (writes: Array<[string, string]>) => {
    configWrite.current = configWrite.current
      .catch(() => undefined)
      .then(async () => {
        for (const [key, value] of writes) await settingsApi.set(key, value)
      })
  }

  useEffect(() => {
    let cancelled = false
    settingsApi.getAll().then((s) => { if (!cancelled) setSettings(s) }).catch(() => { if (!cancelled) setSettings({}) })
    return () => { cancelled = true }
  }, [])

  // Make sure the agent store is populated before we resolve the initial model.
  useEffect(() => {
    if (agentsLoading) return
    if (agents.length > 0) return
    if (fetchAttempted.current) return
    fetchAttempted.current = true
    void useAgentStore.getState().fetchAgents()
  }, [agents, agentsLoading])

  const configuredModels = useMemo(() => configuredModelOptions(agents), [agents])

  // One-time initial sync of the persisted chat settings against the configured
  // models. Later agent edits update `configuredModels` without resetting the
  // user's current selection.
  useEffect(() => {
    if (configLoaded || !settings || agentsLoading) return
    if (agents.length === 0 && !fetchAttempted.current) return
    const savedEffort = settings[CHAT_SETTING_KEYS.reasoningEffort]
    const matchingModels = configuredModels.filter((option) =>
      option.provider === settings[CHAT_SETTING_KEYS.provider] &&
      option.model === settings[CHAT_SETTING_KEYS.model]
    )
    const selected = matchingModels.find((option) => option.reasoningEffort === savedEffort)
      ?? matchingModels[0]
      ?? configuredModels[0]
    const effort = selected
      ? (isChatReasoningEffort(savedEffort) && matchingModels.includes(selected)
          ? savedEffort
          : selected.reasoningEffort)
      : ''
    setSelectedAgentId(selected?.agentId ?? '')
    setReasoningEffort(effort)
    if (selected && (
      settings[CHAT_SETTING_KEYS.provider] !== selected.provider ||
      settings[CHAT_SETTING_KEYS.model] !== selected.model ||
      settings[CHAT_SETTING_KEYS.reasoningEffort] !== effort
    )) {
      queueConfigWrite([
        [CHAT_SETTING_KEYS.provider, selected.provider],
        [CHAT_SETTING_KEYS.model, selected.model],
        [CHAT_SETTING_KEYS.reasoningEffort, effort]
      ])
    }
    setConfigLoaded(true)
  }, [settings, agents, agentsLoading, configuredModels, configLoaded])

  const selectedModel = configuredModels.find((option) => option.agentId === selectedAgentId)

  // Keep the selection valid if the currently selected agent is removed or
  // otherwise no longer offered (e.g. model cleared in the agent settings).
  useEffect(() => {
    if (!configLoaded) return
    if (configuredModels.some((option) => option.agentId === selectedAgentId)) return
    const next = configuredModels[0]
    const nextEffort = next ? next.reasoningEffort : ''
    setSelectedAgentId(next?.agentId ?? '')
    setReasoningEffort(nextEffort)
    if (next) {
      queueConfigWrite([
        [CHAT_SETTING_KEYS.provider, next.provider],
        [CHAT_SETTING_KEYS.model, next.model],
        [CHAT_SETTING_KEYS.reasoningEffort, nextEffort]
      ])
    }
  }, [configuredModels, configLoaded, selectedAgentId])

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
    if (!text || busy || !selectedModel) return
    await configWrite.current.catch(() => undefined)
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
        <div className="rounded-xl border border-input bg-card shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <div className="flex items-end gap-2 px-3 py-2">
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
              <Button size="icon" aria-label="Send" disabled={!draft.trim() || !selectedModel} onClick={() => void submit()}>
                <Send className="size-3.5" aria-hidden="true" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border/70 px-3 py-1.5">
            <select
              aria-label="Commander model"
              title="Model used by the Commander"
              disabled={!configLoaded || busy}
              value={selectedAgentId}
              onChange={(event) => {
                const next = configuredModels.find((option) => option.agentId === event.target.value)
                if (!next) return
                const nextEffort = next.reasoningEffort
                setSelectedAgentId(next.agentId)
                setReasoningEffort(nextEffort)
                queueConfigWrite([
                  [CHAT_SETTING_KEYS.provider, next.provider],
                  [CHAT_SETTING_KEYS.model, next.model],
                  [CHAT_SETTING_KEYS.reasoningEffort, nextEffort]
                ])
              }}
              className="max-w-[15rem] cursor-pointer bg-transparent text-xs text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {configuredModels.length === 0 && <option value="">No configured Commander model</option>}
              {configuredModels.map((option) => (
                <option key={option.agentId} value={option.agentId}>{option.model} · {option.agentName}</option>
              ))}
            </select>
            <span className="text-border" aria-hidden="true">·</span>
            <select
              aria-label="Thinking level"
              title="How much reasoning the Commander should use"
              disabled={!configLoaded || busy || !selectedModel}
              value={reasoningEffort}
              onChange={(event) => {
                const next = isChatReasoningEffort(event.target.value) ? event.target.value : ''
                setReasoningEffort(next)
                queueConfigWrite([[CHAT_SETTING_KEYS.reasoningEffort, next]])
              }}
              className="cursor-pointer bg-transparent text-xs capitalize text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Default thinking</option>
              {(selectedModel ? thinkingOptions(selectedModel.provider) : []).map((effort) => (
                <option key={effort} value={effort}>{effort} thinking</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </section>
  )
}
