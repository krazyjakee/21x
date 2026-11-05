import { Fragment, memo, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Loader2, Wrench } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import type { Artifact } from '@shared/artifacts'
import type { AgentMessage } from '@shared/transcript/types'
import { deriveToolCommand, deriveToolSubtitle, sanitizeToolContent } from '@shared/transcript/tool-format'
import { findTranscriptMatches } from '@shared/transcript/transcript-items'
import { ArtifactTranscriptCard } from './ArtifactTranscriptCard'
import { HighlightedText } from './HighlightedText'

const EMPTY_ARTIFACTS: Artifact[] = []

type Tool = NonNullable<AgentMessage['tool']>

const isToolRunning = (tool: Tool): boolean => !tool.status || tool.status === 'in_progress' || tool.status === 'running' || tool.status === 'pending'
const isToolError = (tool: Tool): boolean => tool.status === 'error' || tool.status === 'failed'

function ToolCallMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!
  const isRunning = isToolRunning(tool)
  const isError = isToolError(tool)
  // Both derivations JSON.parse the (potentially large) tool input — memoize so
  // they only run when the tool payload actually changes, not on every render.
  const subtitle = useMemo(() => deriveToolSubtitle(tool), [tool])
  const command = useMemo(() => deriveToolCommand(tool), [tool])

  return (
    <div className="group/tool w-full min-w-0 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex h-6 w-full items-center gap-2 rounded-sm px-1 text-xs font-mono text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
      >
        <ChevronRight className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-foreground/80 shrink-0"><HighlightedText text={tool.name} query={searchQuery} /></span>
        {subtitle && <span className="min-w-0 flex-1 truncate text-muted-foreground"><HighlightedText text={subtitle} query={searchQuery} /></span>}
        {!subtitle && <span className="flex-1" />}
        <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/tool:opacity-100">
          {message.timestamp.toLocaleTimeString()}
        </span>
        {isRunning && <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />}
        {isError && <AlertTriangle className="h-3 w-3 shrink-0 text-red-400" />}
      </button>
      {expanded && (
        <div className="ml-5 border-l border-border/40 pl-3 py-1.5 text-[11px] font-mono space-y-2">
          {command && (
            <div>
              <span className="text-muted-foreground">Command:</span>
              <pre className="mt-0.5 text-muted-foreground whitespace-pre-wrap break-words max-h-40 overflow-y-auto"><HighlightedText text={command} query={searchQuery} /></pre>
            </div>
          )}
          {tool.input && (
            <div>
              <span className="text-muted-foreground">Input:</span>
              <pre className="mt-0.5 text-muted-foreground whitespace-pre-wrap break-words max-h-40 overflow-y-auto"><HighlightedText text={sanitizeToolContent(tool.input)} query={searchQuery} /></pre>
            </div>
          )}
          {tool.output && (
            <div>
              <span className="text-muted-foreground">Output:</span>
              <pre className="mt-0.5 text-muted-foreground whitespace-pre-wrap break-words max-h-40 overflow-y-auto"><HighlightedText text={sanitizeToolContent(tool.output)} query={searchQuery} /></pre>
            </div>
          )}
          {tool.error && (
            <div>
              <span className="text-red-400">Error:</span>
              <pre className="mt-0.5 text-red-300 whitespace-pre-wrap break-words"><HighlightedText text={tool.error} query={searchQuery} /></pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReasoningMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const [expanded, setExpanded] = useState(false)
  const summary = message.content.split('\n').map((line) => line.trim()).find(Boolean) || 'Thinking'

  return (
    <div className="group/tool w-full min-w-0 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex h-6 w-full items-center gap-2 rounded-sm px-1 text-xs font-mono text-teal-700/90 dark:text-teal-300/80 hover:bg-accent hover:text-teal-700 dark:hover:text-teal-200 transition-colors"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 text-teal-600/70 dark:text-teal-300/60 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="shrink-0 text-teal-700 dark:text-teal-300">Thinking</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground"><HighlightedText text={summary} query={searchQuery} /></span>
        <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/tool:opacity-100">
          {message.timestamp.toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <div className="ml-5 border-l border-teal-500/30 pl-3 py-1.5 text-foreground/75">
          <Markdown size="sm" highlightQuery={searchQuery}>{message.content}</Markdown>
        </div>
      )}
    </div>
  )
}

const COMPLETED_TOOL_STATUSES = ['success', 'succeeded', 'complete', 'completed']

// Serializing tool payloads is expensive and rows re-render on every delta;
// message objects are identity-stable per part, so compute once per message.
const artifactHaystackCache = new WeakMap<AgentMessage, string>()

function getArtifactHaystack(message: AgentMessage, tool: NonNullable<AgentMessage['tool']>): string {
  const cached = artifactHaystackCache.get(message)
  if (cached !== undefined) return cached
  let haystack = `${tool.title || ''}\n${message.content || ''}`
  try { haystack += `\n${typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input)}\n${typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output)}` } catch { /* ignore unserializable tool payloads */ }
  artifactHaystackCache.set(message, haystack)
  return haystack
}

function findMessageArtifact(message: AgentMessage, artifacts: Artifact[]): Artifact | undefined {
  const tool = message.tool
  if (!tool || artifacts.length === 0 || !COMPLETED_TOOL_STATUSES.includes(tool.status?.toLowerCase?.() || '')) return undefined
  const haystack = getArtifactHaystack(message, tool)
  return artifacts.find((artifact) => {
    const target = artifact.path || artifact.url
    return !!target && (haystack.includes(target) || haystack.replace(/\\/g, '/').includes(target.replace(/\\/g, '/')))
  })
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** What one row says about a run of activity. */
function summarizeActivity(messages: AgentMessage[]): { label: string; detail: string; failed: number; running: boolean } {
  const counts = new Map<string, number>()
  let thoughts = 0
  let failed = 0
  let running: string | null = null
  for (const { tool } of messages) {
    if (!tool) {
      thoughts += 1
      continue
    }
    // `task-management.get_messages`: the server is noise once it repeats.
    const name = tool.name.slice(tool.name.lastIndexOf('.') + 1)
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (isToolError(tool)) failed += 1
    if (isToolRunning(tool)) running = name
  }
  const tools = messages.length - thoughts
  return {
    label: [tools && plural(tools, 'tool call'), thoughts && plural(thoughts, 'thought')].filter(Boolean).join(', '),
    // While the agent works, what it is doing now matters more than the tally.
    detail: running ?? [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', '),
    failed,
    running: running !== null,
  }
}

/**
 * Groups the user opened, by key. Rows unmount as they scroll out of the virtual
 * window, so local state alone would snap a long group shut on the way back.
 */
const openGroups = new Set<string>()

function CollapsedActivity({ messages, searchQuery, renderRow, renderArtifact }: {
  messages: AgentMessage[]
  searchQuery?: string
  renderRow: (message: AgentMessage) => ReactNode
  renderArtifact: (message: AgentMessage) => ReactNode
}) {
  const key = messages[0].id
  const [open, setOpen] = useState(() => openGroups.has(key))
  const summary = useMemo(() => summarizeActivity(messages), [messages])
  // A match behind a closed row would count in the results and show nothing.
  const hasMatch = useMemo(
    () => !!searchQuery && findTranscriptMatches([{ type: 'activity', key, messages }], searchQuery).length > 0,
    [key, messages, searchQuery]
  )
  const expanded = open || hasMatch

  const toggle = (): void => {
    if (open) openGroups.delete(key)
    else openGroups.add(key)
    setOpen(!open)
  }

  return (
    <>
      <div className="group/tool w-full min-w-0 overflow-hidden">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex h-6 w-full items-center gap-2 rounded-sm px-1 text-xs font-mono text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="text-foreground/80 shrink-0">{summary.label}</span>
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">{summary.detail}</span>
          <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/tool:opacity-100">
            {messages[messages.length - 1].timestamp.toLocaleTimeString()}
          </span>
          {summary.running && <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />}
          {summary.failed > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-red-400">
              <AlertTriangle className="h-3 w-3" />
              {summary.failed} failed
            </span>
          )}
        </button>
      </div>
      {expanded
        ? <div className="ml-2">{messages.map(renderRow)}</div>
        : messages.map(renderArtifact)}
    </>
  )
}

interface ActivityMessageGroupProps {
  messages: AgentMessage[]
  searchQuery?: string
  artifacts?: Artifact[]
  onOpenArtifact?: (artifact: Artifact) => void
}

// Activity groups are the majority of rows while an agent runs. Their
// `messages` array is rebuilt (new identity) whenever the transcript changes,
// so compare element identity instead — message objects are stable per part
// thanks to the store's projection cache, letting untouched groups skip
// re-rendering entirely during streaming.
export const ActivityMessageGroup = memo(
  function ActivityMessageGroup({ messages, searchQuery, artifacts = EMPTY_ARTIFACTS, onOpenArtifact }: ActivityMessageGroupProps) {
    const renderArtifact = (message: AgentMessage): ReactNode => {
      if (message.partType === 'reasoning' || !onOpenArtifact) return null
      const artifact = findMessageArtifact(message, artifacts)
      return artifact ? <ArtifactTranscriptCard key={`artifact-${message.id}`} artifact={artifact} onOpen={onOpenArtifact} /> : null
    }
    const renderRow = (message: AgentMessage): ReactNode => {
      if (message.partType === 'reasoning') {
        return <ReasoningMessage key={message.id} message={message} searchQuery={searchQuery} />
      }
      return (
        <Fragment key={message.id}>
          <ToolCallMessage message={message} searchQuery={searchQuery} />
          {renderArtifact(message)}
        </Fragment>
      )
    }
    return (
      <div className="w-full border-l border-border/30 pl-2 py-0.5">
        {messages.length > 1
          ? <CollapsedActivity messages={messages} searchQuery={searchQuery} renderRow={renderRow} renderArtifact={renderArtifact} />
          : messages.map(renderRow)}
      </div>
    )
  },
  (prev, next) =>
    prev.searchQuery === next.searchQuery &&
    prev.artifacts === next.artifacts &&
    prev.onOpenArtifact === next.onOpenArtifact &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((message, index) => message === next.messages[index])
)
