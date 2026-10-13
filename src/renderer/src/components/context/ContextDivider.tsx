import { AlertTriangle, Archive, Layers } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'

export interface ContextDividerProps {
  kind: 'compaction' | 'rollover' | 'recovery'
  title: string
  summary?: string
  source?: 'model' | 'fallback' | null
}
export function readContextDivider(content: string, kind: ContextDividerProps['kind']): ContextDividerProps {
  const fallbackTitle = kind === 'compaction' ? 'Context compacted' : kind === 'rollover' ? 'Session continued in a new generation' : 'Session recovered'
  try {
    const value: unknown = JSON.parse(content)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      return {
        kind: record.kind === 'compaction' || record.kind === 'rollover' || record.kind === 'recovery' ? record.kind : kind,
        title: typeof record.title === 'string' && record.title.trim() ? record.title : fallbackTitle,
        ...(typeof record.summary === 'string' && record.summary.trim() ? { summary: record.summary } : {}),
        source: record.source === 'model' || record.source === 'fallback' ? record.source : null
      }
    }
  } catch { /* Historical plain-text lifecycle evidence remains readable. */ }
  return { kind, title: fallbackTitle, ...(content.trim() ? { summary: content } : {}) }
}

export function ContextDivider({ kind, title, summary, source }: ContextDividerProps) {
  const Icon = kind === 'compaction' ? Archive : kind === 'recovery' ? AlertTriangle : Layers
  return <section className="ui-scale my-3 min-w-0 border-y border-border py-3" data-testid={`context-${kind}-divider`}>
    <div role="separator" aria-label={kind === 'compaction' ? 'Conversation context compacted' : kind === 'rollover' ? 'Conversation generation changed' : 'Conversation recovered'} className="flex items-center gap-2 text-sm font-medium text-foreground"><Icon className="size-icon-sm shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{title}</span></div>
    {source === 'fallback' && <p className="mt-1 text-sm text-muted-foreground">Fallback summary</p>}
    {summary && <details className="mt-2 min-w-0"><summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Read {kind === 'compaction' ? 'compaction' : kind === 'rollover' ? 'handoff' : 'recovery'} summary{source === 'model' ? ' · Model summary' : ''}</summary><div className="mt-2 max-h-64 overflow-y-auto text-base leading-relaxed"><Markdown size="base">{summary}</Markdown></div></details>}
  </section>
}
