import type { TranscriptPartRecord } from './database'
import { measureIpcMessage } from './ipc-message-size'

// Estimated cost above which a single record is shown as a preview. Normal
// records (including large file reads/writes) stay well below this; it only
// bounds pathological records so one of them cannot fill an IPC message.
export const TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024
const PREVIEW_CHARS = 8000
const TOOL_VALUE_BYTES = 16 * 1024
const NOTICE = '\n\n[Large record: only a preview is displayed. The full record is still saved.]'

function clip(value: string): string {
  return value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) + NOTICE : value
}

/** Keep the tool card (name, status, ...) but clip long string fields. */
function previewTool(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return undefined
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tool)) {
    if (typeof value === 'string') preview[key] = clip(value)
    else if (!measureIpcMessage(value, TOOL_VALUE_BYTES).reason) preview[key] = value
  }
  return preview
}

/** Presentation only. Never write these previews back to the database. */
export function transcriptDisplayPart(part: TranscriptPartRecord): TranscriptPartRecord {
  if (!measureIpcMessage(part, TRANSCRIPT_RECORD_BYTES).reason) return part
  const content = typeof part.content === 'string' ? part.content : ''
  const preview: TranscriptPartRecord = {
    taskId: part.taskId, partId: part.partId, seq: part.seq,
    role: part.role, createdAt: part.createdAt, updatedAt: part.updatedAt, rev: part.rev,
    partType: part.partType,
    content: content.length > PREVIEW_CHARS ? clip(content) : content + (part.tool ? '' : NOTICE),
    tool: previewTool(part.tool)
  }
  if (!measureIpcMessage(preview, TRANSCRIPT_RECORD_BYTES).reason) return preview
  // Fall back to a plain text notice; identity and revision are preserved.
  const minimal: TranscriptPartRecord = { ...preview, partType: 'text', tool: undefined, content: clip(content) || NOTICE.trim() }
  // An invalid identity must not silently corrupt the renderer projection.
  if (measureIpcMessage(minimal, TRANSCRIPT_RECORD_BYTES).reason) {
    throw new Error('Transcript record metadata is too large to display')
  }
  return minimal
}
