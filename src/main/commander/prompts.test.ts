import { describe, expect, it } from 'vitest'
import { COMMANDER_SYSTEM_PROMPT, COMMANDER_SUMMARY_PROMPT, REPORT_SUMMARY_RULES, reportRelayNote } from './prompts'

describe('report summary instructions', () => {
  it('keeps reports as background context until the user asks or they directly answer the current question', () => {
    expect(COMMANDER_SYSTEM_PROMPT).toContain('Its arrival never starts a reply')
    expect(COMMANDER_SYSTEM_PROMPT).toContain('do not interrupt an unrelated exchange with a report announcement')
    expect(COMMANDER_SYSTEM_PROMPT).toContain('Do not delegate on a report alone')
    expect(reportRelayNote('Web')).toContain('The user asked for an explanation')
  })

  it('keeps a single explanation after the last tool result, without narration between calls (#114)', () => {
    expect(COMMANDER_SYSTEM_PROMPT).toContain('Do not write any text before or between tool calls')
    expect(COMMANDER_SYSTEM_PROMPT).toContain('Call the tools silently and write one reply after the last tool result')
  })

  it('covers meaning, impact, outcome, next owner and user action for every work state', () => {
    for (const phrase of ['completed, in-progress, blocked or proposed work', 'human-readable task or change title', 'plain-language description', 'visible benefit, fixed problem or project impact', 'next meaningful step and who owns it', 'required user action', 'no sentence limit']) {
      expect(REPORT_SUMMARY_RULES).toContain(phrase)
    }
    expect(COMMANDER_SYSTEM_PROMPT).toContain('Every reply, Captain report relay and status/history explanation')
  })

  it('keeps technical evidence secondary and available on explicit request', () => {
    for (const detail of ['commit hashes', 'tell_commander', 'tool names', 'correlation IDs', 'raw check names', 'review machinery']) {
      expect(REPORT_SUMMARY_RULES).toContain(detail)
    }
    expect(REPORT_SUMMARY_RULES).toContain('unless the user explicitly asks for technical details')
    expect(REPORT_SUMMARY_RULES).toContain('secondary concise link after naming and describing the change')
  })

  it('puts the rules in the system prompt, with details on request', () => {
    expect(COMMANDER_SYSTEM_PROMPT).toContain(REPORT_SUMMARY_RULES)
    expect(COMMANDER_SYSTEM_PROMPT).toContain('never a verbatim relay or quote')
    expect(COMMANDER_SYSTEM_PROMPT).toContain('If the user asks for technical details, give them from the report.')
  })

  it('tells a report-started turn to summarise, not relay', () => {
    const note = reportRelayNote('"Web"')
    expect(note).toContain(REPORT_SUMMARY_RULES)
    expect(note).not.toContain('Relay it to the user now')
    expect(note).toContain('consider the pending reports together')
    expect(note).toContain('project "Web"')
    expect(note).toContain('do not quote or relay it verbatim')
  })

  it('requires coherent synthesis, honest missing context and the same spoken contract', () => {
    expect(REPORT_SUMMARY_RULES).toContain('Synthesise multiple related updates into one coherent progress explanation')
    expect(REPORT_SUMMARY_RULES).toContain('Never invent impact or meaning')
    expect(REPORT_SUMMARY_RULES).toContain('read the associated project summary or history')
    expect(REPORT_SUMMARY_RULES).toContain('state plainly what is unknown')
    expect(REPORT_SUMMARY_RULES).toContain('Spoken replies follow the same contract')
    expect(REPORT_SUMMARY_RULES).toContain('Integrated work is not necessarily released')
    expect(COMMANDER_SUMMARY_PROMPT).toContain('human-readable change titles and descriptions, reported impact, current outcomes, next steps and their owners, required user actions, unknown context')
  })
})
