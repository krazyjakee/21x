import { describe, expect, it } from 'vitest'
import { chatProviderForAgentModel } from './chat'

describe('chatProviderForAgentModel', () => {
  it('routes Claude Code agents to Anthropic', () => {
    expect(chatProviderForAgentModel('claude-code', 'claude-opus-5')).toBe('anthropic')
  })

  it('routes claude-named models from any backend to Anthropic', () => {
    expect(chatProviderForAgentModel('pi', 'claude-sonnet-4-20250514')).toBe('anthropic')
    expect(chatProviderForAgentModel('opencode', 'anthropic/claude-x')).toBe('anthropic')
  })

  it('routes every other model to an OpenAI-compatible endpoint', () => {
    expect(chatProviderForAgentModel('codex', 'gpt-6-astra')).toBe('openai-compatible')
    expect(chatProviderForAgentModel('pi', 'cerebras/gpt-oss-120b')).toBe('openai-compatible')
    expect(chatProviderForAgentModel('cursor', 'gemini-2.5-pro')).toBe('openai-compatible')
  })

  it('accepts no model', () => {
    expect(chatProviderForAgentModel('claude-code', undefined)).toBeNull()
    expect(chatProviderForAgentModel('claude-code', '  ')).toBeNull()
  })
})