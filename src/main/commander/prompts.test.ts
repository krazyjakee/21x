/**
 * The Commander answers a Captain report with a short plain-language summary
 * rather than relaying it (#107). These pin the wording the model is given.
 */
import { describe, expect, it } from 'vitest'
import { COMMANDER_SYSTEM_PROMPT, REPORT_SUMMARY_RULES, reportRelayNote } from './prompts'

describe('report summary instructions', () => {
  it('asks for the outcome first, then progress, blockers and decisions, briefly', () => {
    expect(REPORT_SUMMARY_RULES).toMatch(/^Lead with the outcome/)
    expect(REPORT_SUMMARY_RULES).toContain('progress, blockers (and who or what they wait on)')
    expect(REPORT_SUMMARY_RULES).toContain('any decision the user must make, with the options')
    expect(REPORT_SUMMARY_RULES).toContain('2 to 5 sentences')
  })

  it('keeps technical detail out unless the user must act on it', () => {
    for (const detail of ['issue and PR numbers', 'branch names', 'commit SHAs', 'file paths', 'batch labels', 'implementation order']) {
      expect(REPORT_SUMMARY_RULES).toContain(detail)
    }
    expect(REPORT_SUMMARY_RULES).toContain('unless the user must act on one')
  })

  it('puts the rules in the system prompt, with details on request', () => {
    expect(COMMANDER_SYSTEM_PROMPT).toContain(REPORT_SUMMARY_RULES)
    expect(COMMANDER_SYSTEM_PROMPT).toContain('never a verbatim relay or quote')
    expect(COMMANDER_SYSTEM_PROMPT).toContain('If the user asks for details, give them from the report.')
  })

  it('tells a report-started turn to summarise, not relay', () => {
    const note = reportRelayNote('"Web"')
    expect(note).toContain(REPORT_SUMMARY_RULES)
    expect(note).not.toContain('Relay it to the user now')
    expect(note).toMatchInlineSnapshot(`"A report from project "Web" has just arrived; it is the last message. Summarise it for the user now in plain language, naming the project; do not quote or relay it verbatim, since the full report is shown in the chat. Lead with the outcome, then give progress, blockers (and who or what they wait on) and any decision the user must make, with the options. Aim for 2 to 5 sentences; use short bullets only when there are several decisions. Leave out issue and PR numbers, branch names, commit SHAs, file paths, batch labels and implementation order, unless the user must act on one (for example "approve PR #12"). Only call ask_captain in response when the report itself asks for something the user already told you in this conversation; otherwise summarise it and stop."`)
  })
})
