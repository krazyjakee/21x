import { describe, expect, it } from 'vitest'
import { commanderSourceContext, formatCommanderReport, splitCommanderReport } from './commander-report'

describe('Commander report presentation', () => {
  it('preserves ordinary large numbers and compact dates while filtering actual hash references', () => {
    const prose = 'Revenue reached 1000000 on 20261013.'
    expect(splitCommanderReport(prose)).toEqual({ content: prose, technicalDetails: null })
    const source = commanderSourceContext(`## Summary\n${prose} Reference 1a2b3c4 and ${'a'.repeat(40)}. Commit SHA 1234567.`)
    expect(source.description).toContain(prose)
    expect(source.description).not.toMatch(/1a2b3c4|a{40}|1234567/)
    for (const evidence of ['Commit SHA 1234567', 'Reference 1a2b3c4', 'Reference ' + 'a'.repeat(40)]) {
      expect(splitCommanderReport(evidence).technicalDetails).toBe(evidence)
    }
  })

  it('retains supplied change meaning and impact while removing audit identifiers from source excerpts', () => {
    const source = commanderSourceContext('## Summary\nRecently updated tasks stay visible. See [change details](https://github.com/acme/app/pull/153).\n\n## Impact\nYou can find active work more easily.\n\n## Technical details\nPR #153 merged ' + 'a'.repeat(40) + '\npolicy/tell_commander\n```sh\nmerge_pull_request\n```')
    expect(source.description).toContain('Recently updated tasks stay visible')
    expect(source.impact).toBe('You can find active work more easily.')
    expect(source.description).not.toContain('/pull/153')
    expect(source.description).not.toContain('tell_commander')
  })
  it('keeps the full explanation primary and technical evidence available separately', () => {
    const evidence = 'merge_pull_request PR #153 head_sha ' + 'a'.repeat(40)
    const report = formatCommanderReport({
      title: 'Board activity sorting',
      description: 'Recently updated tasks now stay visible at the top of the board.',
      impact: 'You can find active work more easily.',
      outcome: 'Integrated after review.',
      nextStep: 'The Captain is arranging scrollbar accessibility work.',
      userAction: 'No action is needed from you.',
      references: ['https://github.com/acme/app/pull/153']
    }, evidence)
    const presentation = splitCommanderReport(report)
    expect(presentation.content).toContain('Recently updated tasks now stay visible')
    expect(presentation.content).toContain('You can find active work more easily')
    expect(presentation.content).toContain('Integrated after review')
    expect(presentation.content).toContain('Captain is arranging scrollbar accessibility')
    expect(presentation.content).toContain('No action is needed')
    expect(presentation.technicalDetails).toContain(evidence)
    expect(presentation.technicalDetails).toContain('/pull/153')
  })

  it('makes missing meaning explicit instead of deriving benefits from identifiers', () => {
    const report = formatCommanderReport({}, 'PR #151 merged as ' + 'b'.repeat(40))
    const { content, technicalDetails } = splitCommanderReport(report)
    expect(content).toContain('does not yet describe what this work changes')
    expect(content).toContain('effect on the project or its users has not been reported')
    expect(content).toContain('next step and who owns it')
    expect(content).toContain('does not specify whether you need to act')
    expect(technicalDetails).toContain('PR #151')
  })

  it('demotes older policy and merge notices without changing ordinary prose', () => {
    const legacy = 'Captain action: Merged https://github.com/acme/app/pull/1; policy/tell_commander'
    expect(splitCommanderReport(legacy)).toEqual({ content: expect.stringContaining('plain-language explanation is missing'), technicalDetails: legacy })
    expect(splitCommanderReport('The login fix is under review.')).toEqual({ content: 'The login fix is under review.', technicalDetails: null })
  })
})
