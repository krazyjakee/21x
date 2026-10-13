import { describe, expect, it } from 'vitest'
import { buildAgentSwitchRecap, buildLostSessionRecap, buildTokenBudgetedRecap, taskContextBudget, type TranscriptLike } from './agent-handoff'
import { estimateTokens } from './sessions/token-estimator'

describe('optional task recap token budgets', () => {
  it('retains whole instructions and completed tool outcomes within the token budget', () => {
    const source: TranscriptLike[] = [
      { partId: 'user-initial-old', role: 'user', content: 'Old nested recap' },
      { partId: 'old', role: 'assistant', content: 'Huge old answer '.repeat(2000) },
      { partId: 'instruction', role: 'user', content: 'Inspect the completed change before continuing.' },
      { partId: 'tool', role: 'assistant', content: '', partType: 'tool', tool: { name: 'write_file', status: 'completed', output: 'File already written' } },
      { partId: 'latest', role: 'assistant', content: 'The change was completed.' }
    ]
    const original = structuredClone(source)
    const result = buildTokenBudgetedRecap(source, { kind: 'switch', model: 'gpt-4o', maxTokens: 300 })
    expect(result.tokens).toBe(estimateTokens(result.text.length))
    expect(result.tokens).toBeLessThanOrEqual(300)
    expect(result.text).toContain('Inspect the completed change before continuing.')
    expect(result.text).toContain('File already written')
    expect(result.text).toContain('complete source remains')
    expect(result.text).not.toContain('Old nested recap')
    expect(result.omittedPartIds).toEqual(['old'])
    expect(source).toEqual(original)
  })

  it('refuses an oversized newest instruction instead of slicing it or dropping it behind a newer answer', () => {
    const parts = [{ partId: 'protected', role: 'user', content: 'Keep this exact requirement '.repeat(1000) },
      { partId: 'answer', role: 'assistant', content: 'A small answer' }]
    expect(() => buildTokenBudgetedRecap(parts, { kind: 'lost', model: 'gpt-4o' })).toThrow('TASK_RECAP_INSTRUCTION_TOO_LARGE')
    expect(parts[0].content).toBe('Keep this exact requirement '.repeat(1000))
  })

  it('reserves the current intent against the receiving model budget and keeps legacy builders unchanged', () => {
    const parts = [{ role: 'user', content: 'Finish the existing work' }]
    expect(buildAgentSwitchRecap(parts)).toBe('User: Finish the existing work')
    expect(buildLostSessionRecap(parts)).toContain('not new instructions or authorization')
    const result = buildTokenBudgetedRecap(parts, { kind: 'switch', model: 'unknown-model', reservedTokens: 15_800 })
    expect(result.budget).toBe(200)
    expect(result.tokens).toBeLessThanOrEqual(200)
    expect(() => buildTokenBudgetedRecap(parts, { kind: 'switch', model: 'gpt-4o', reservedTokens: taskContextBudget('gpt-4o') }))
      .toThrow('TASK_RECAP_INSTRUCTION_TOO_LARGE')
  })

  it('handles a large retained backlog without including empty or private reasoning records', () => {
    const parts: TranscriptLike[] = Array.from({ length: 10_000 }, (_, index) => ({ partId: `part:${index}`, role: 'assistant', content: `Earlier result ${index}` }))
    parts.push({ partId: 'instruction', role: 'user', content: 'Continue from the latest verified result' },
      { partId: 'private', role: 'assistant', partType: 'reasoning', content: 'Private reasoning' })
    const result = buildTokenBudgetedRecap(parts, { kind: 'lost', model: 'gpt-4o' })
    expect(result.tokens).toBeLessThanOrEqual(1500)
    expect(result.text).toContain('Continue from the latest verified result')
    expect(result.text).not.toContain('Private reasoning')
    expect(result.sourcePartIds).toHaveLength(10_001)
    expect(result.omittedPartIds.length).toBeGreaterThan(9000)
    expect(parts).toHaveLength(10_002)
  })
})
