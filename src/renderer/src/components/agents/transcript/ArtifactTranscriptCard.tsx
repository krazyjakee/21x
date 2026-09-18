import { useEffect, useState } from 'react'
import { ChevronRight, FileText, GitPullRequest, Image as ImageIcon, MonitorPlay } from 'lucide-react'
import { artifactApi } from '@/lib/ipc-client'
import { ArtifactContentKind, ArtifactType, type Artifact } from '@shared/artifacts'

export function ArtifactTranscriptCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (artifact: Artifact) => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(artifact.url && artifact.type === ArtifactType.IMAGE ? artifact.url : null)
  useEffect(() => {
    if (artifact.type !== ArtifactType.IMAGE || !artifact.path) return
    let cancelled = false
    void artifactApi.read(artifact.taskId, artifact.path).then((content) => {
      if (!cancelled && content?.kind === ArtifactContentKind.DATA_URL) setThumbnail(content.content)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [artifact.path, artifact.reloadTrigger, artifact.taskId, artifact.type])

  const Icon = artifact.type === ArtifactType.IMAGE ? ImageIcon
    : artifact.type === ArtifactType.HTML ? MonitorPlay
      : artifact.type === ArtifactType.PR ? GitPullRequest
        : FileText
  const noun = artifact.type === ArtifactType.IMAGE ? 'Screenshot'
    : artifact.type === ArtifactType.HTML ? 'Preview'
      : artifact.type === ArtifactType.PR ? 'Pull request'
        : artifact.type === ArtifactType.MARKDOWN ? 'Markdown' : 'File'

  return (
    <button onClick={() => onOpen(artifact)} className="my-1 ml-1 flex w-[min(420px,calc(100%-8px))] items-center gap-3 rounded-lg border border-border/50 bg-card p-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40">
      <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-border/40 bg-muted/40">
        {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : <Icon className="h-4 w-4 text-muted-foreground" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{artifact.title}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{noun} · Click to open</span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  )
}
