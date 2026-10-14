import { getDesktopHost } from '@/lib/desktop-api'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'
import { ArtifactHtmlFrame } from './ArtifactHtmlFrame'

interface HtmlArtifactViewProps { artifact: Artifact; artifactApi: ArtifactApi; onMessage?: (data: unknown) => void; onLinkClick?: (href: string) => boolean; refreshTrigger?: number }
export function HtmlArtifactView(props: HtmlArtifactViewProps) {
  // The native host requires a separate unprivileged viewer. Until that owner
  // is bound, do not activate a main-window iframe or fetch its content.
  if (getDesktopHost().kind === 'tauri') return <div role="status" className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">HTML previews are unavailable in this desktop build.</div>
  return <AvailableHtmlArtifactView {...props} />
}
function AvailableHtmlArtifactView({ artifact, artifactApi, onMessage, onLinkClick, refreshTrigger = 0 }: HtmlArtifactViewProps) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const html = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  return <ArtifactViewState loading={state.loading} error={state.error} missing={html === null}><ArtifactHtmlFrame key={`${artifact.path}:${artifact.reloadTrigger}`} html={html || ''} title={artifact.title} onLinkClick={onLinkClick} onMessage={onMessage} /></ArtifactViewState>
}
