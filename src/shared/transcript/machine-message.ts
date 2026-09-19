import { COMMANDER_RELAY_BEGIN, COMMANDER_RELAY_END, COMMANDER_RELAY_MARKER } from '../commander-relay'
import { FINDINGS_BEGIN, FINDINGS_END, SYSTEM_MESSAGE_MARKER } from '../system-authority'

/**
 * Display side of a machine-authored prompt (`shared/system-authority.ts`,
 * `shared/commander-relay.ts`).
 *
 * Those prompts are written for the agent that reads them: a provenance
 * header, a fence, and a standing authority notice, repeated on every single
 * message. A human scrolling the transcript only wants the part that changes —
 * the request or the finding. This parser splits the two so the transcript can
 * show the payload and keep the scaffolding one click away. It never rewrites
 * what the agent was sent; the raw text stays available.
 */

interface Shape {
  kind: MachineMessageKind
  marker: string
  begin: string
  end: string
  label: string
}

export type MachineMessageKind = 'commander-relay' | 'system'

const SHAPES: Shape[] = [
  {
    kind: 'commander-relay',
    marker: COMMANDER_RELAY_MARKER,
    begin: COMMANDER_RELAY_BEGIN,
    end: COMMANDER_RELAY_END,
    label: 'From the Commander'
  },
  {
    kind: 'system',
    marker: SYSTEM_MESSAGE_MARKER,
    begin: FINDINGS_BEGIN,
    end: FINDINGS_END,
    label: 'Automated message'
  }
]

export interface MachineMessageView {
  kind: MachineMessageKind
  /** Short human label for the chip, e.g. "From the Commander". */
  label: string
  /** `origin=` from the provenance line, when it carries one. */
  origin: string | null
  /** The part worth reading: the lead-in line, if any, plus the fenced payload. */
  body: string
  /** `authorizes_actions=` when it is something other than `false`. */
  authorizes: string | null
}

function provenanceField(provenance: string, key: string): string | null {
  const match = new RegExp(`\\b${key}=(\\S+)`).exec(provenance)
  return match ? match[1] : null
}

/**
 * Returns what a reader should see, or null when `content` is not a
 * machine-authored prompt (or is one whose fence is empty — then the raw text
 * is all there is, so the caller shows it unchanged).
 */
export function parseMachineMessage(content: string): MachineMessageView | null {
  if (!content) return null
  const text = content.trim()
  const shape = SHAPES.find((candidate) => text.startsWith(candidate.marker))
  if (!shape) return null

  const begin = text.indexOf(shape.begin)
  const end = text.indexOf(shape.end, begin + shape.begin.length)
  if (begin === -1 || end === -1) return null

  // Everything before the fence, minus the marker line: a lead-in sentence on
  // a system message ("A start in your project was queued"), nothing on a relay.
  const head = text.slice(0, begin).split('\n').slice(1)
  const provenance = head.find((line) => line.startsWith('provenance:')) ?? ''
  const lead = head.filter((line) => !line.startsWith('provenance:')).join('\n').trim()
  const fenced = text.slice(begin + shape.begin.length, end).trim()
  const body = [lead, fenced].filter(Boolean).join('\n\n')
  if (!body) return null

  const authorizes = provenanceField(provenance, 'authorizes_actions')
  return {
    kind: shape.kind,
    label: shape.label,
    origin: provenanceField(provenance, 'origin'),
    body,
    authorizes: authorizes && authorizes !== 'false' ? authorizes : null
  }
}
