import { Fragment, memo, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2, Wrench } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import type { Artifact } from '@shared/artifacts'
import type { AgentMessage } from '@shared/transcript/types'
import { deriveToolCommand, deriveToolSubtitle, sanitizeToolContent } from '@shared/transcript/tool-format'
import { ArtifactTranscriptCard } from './ArtifactTranscriptCard'
import { HighlightedText } from './HighlightedText'

const EMPTY_ARTIFACTS: Artifact[] = []

function ToolCallMessage({ message, searchQuery }: { message: AgentMessage; searchQuery?: string }) {
  const [expanded, setExpanded] = useState(false)
  const tool = message.tool!
  const isRunning = !tool.status || tool.status === 'in_progress' || tool.status === 'running' || tool.status === 'pending'
  const isError = tool.status === 'error' || tool.status === 'failed'
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
    return (
      <div className="w-full border-l border-border/30 pl-2 py-0.5">
        {messages.map((message) => {
          if (message.partType === 'reasoning') {
            return <ReasoningMessage key={message.id} message={message} searchQuery={searchQuery} />
          }
          const artifact = onOpenArtifact ? findMessageArtifact(message, artifacts) : undefined
          return (
            <Fragment key={message.id}>
              <ToolCallMessage message={message} searchQuery={searchQuery} />
              {artifact && onOpenArtifact && <ArtifactTranscriptCard artifact={artifact} onOpen={onOpenArtifact} />}
            </Fragment>
          )
        })}
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
