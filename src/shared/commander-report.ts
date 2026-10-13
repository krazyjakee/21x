/** Plain-language report fields; technical evidence stays in the persisted report. */
export interface CommanderReportContext {
  title?: string
  description?: string
  impact?: string
  outcome?: string
  nextStep?: string
  userAction?: string
  references?: string[]
}

export const COMMANDER_TECHNICAL_DETAILS = '\n\n<!-- commander-technical-details -->\n'

/** A bounded excerpt of source prose, not an inferred benefit or model result. */
export function commanderSourceContext(source: string | null | undefined): { description?: string; impact?: string } {
  if (!source?.trim()) return {}
  const sections = source.replace(/```[^]*?```|~~~[^]*?~~~/g, '').split(/(?=^#{1,6}\s)/m)
  const clean = (text: string): string | undefined => {
    const prose = text.split('\n').filter((line) => !/^\s*#{1,6}\s|tell_commander|policy[:/]|correlation[_ -]id|exact-head|guarded-squash|\bCLEAN\b|head_sha/i.test(line))
      .join(' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`[^`]*`|https?:\/\/\S+|\b(?:commit(?:\s+(?:hash|sha))?|(?:head[_ ]?)?sha)\s*[:=]?\s*[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b(?:PR|issue)\s*#\s*\d+\b|\b[a-z]+(?:_[a-z]+)+\b/gi, '')
      .replace(/(?:^|\s)[-*+]\s+/g, ' ')
      .replace(/\s+/g, ' ').trim()
    return prose ? (prose.length > 900 ? prose.slice(0, 897).trimEnd() + '…' : prose) : undefined
  }
  const description = sections.find((section) => /^#{1,6}\s+(?:summary|description|what changed|changes)\b/i.test(section))
  const impact = sections.find((section) => /^#{1,6}\s+(?:impact|benefits?|why (?:it|this) matters|user impact)\b/i.test(section))
  return {
    description: clean(description ?? sections.find((section) => section.trim() && !/^#{1,6}\s+(?:impact|benefits?|test|validation|technical|check)/i.test(section)) ?? ''),
    impact: impact ? clean(impact) : undefined
  }
}

/** Keep missing context explicit rather than inferring a benefit or a release. */
export function formatCommanderReport(context: CommanderReportContext, technicalDetails?: string): string {
  const lines = [
    context.title?.trim() || 'Project work update',
    '',
    context.description?.trim() || 'The report does not yet describe what this work changes.',
    '',
    `Why it matters: ${context.impact?.trim() || 'The effect on the project or its users has not been reported.'}`,
    `Current outcome: ${context.outcome?.trim() || 'The current outcome has not been confirmed.'}`,
    `Next step: ${context.nextStep?.trim() || 'The Captain needs to confirm the next step and who owns it.'}`,
    `Your action: ${context.userAction?.trim() || 'The report does not specify whether you need to act.'}`
  ]
  const evidence = [technicalDetails?.trim(), ...(context.references ?? [])].filter(Boolean).join('\n')
  return lines.join('\n') + (evidence ? COMMANDER_TECHNICAL_DETAILS + evidence : '')
}

/** Shared by visible report cards and speech; the original content remains auditable. */
export function splitCommanderReport(report: string): { content: string; technicalDetails: string | null } {
  const boundary = report.indexOf(COMMANDER_TECHNICAL_DETAILS)
  if (boundary >= 0) {
    return { content: report.slice(0, boundary), technicalDetails: report.slice(boundary + COMMANDER_TECHNICAL_DETAILS.length).trim() || null }
  }
  // Old persisted notices sometimes contain only implementation evidence. Do
  // not invent a description from those identifiers or speak them as progress.
  if (/\b(?:tell_commander|policy\/[a-z_]+|correlation_id|head_sha|exact-head|guarded-squash|merge_pull_request)\b|\b(?:commit(?:\s+(?:hash|sha))?|(?:head[_ ]?)?sha)\s*[:=]?\s*[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|^(?:Captain action: )?Merged https?:\/\/|^PR\s*#\s*\d+/i.test(report)) {
    return {
      content: 'A project update arrived, but its plain-language explanation is missing. Ask the Captain to confirm what changed, its impact, the current outcome, the next step and whether you need to act.',
      technicalDetails: report
    }
  }
  return { content: report, technicalDetails: null }
}
