import { describe, expect, it } from 'vitest'
import type { AgentRecord } from '../database/types'
import { createChatProviderFromSettings, resolveChatApiKey, type ChatSettingsSource } from './provider-factory'
import { DEFAULT_ANTHROPIC_CHAT_MODEL } from './providers/anthropic'

function source(settings: Record<string, string>, agents: Array<Partial<AgentRecord>> = []): ChatSettingsSource {
  return {
    getSetting: (key) => settings[key],
    getAgents: () => agents.map((a, i) => ({
      id: `a${i}`, name: `agent ${i}`, server_url: '', is_default: false, created_at: '', updated_at: '', config: {}, ...a
    }))
  }
}

describe('createChatProviderFromSettings', () => {
  it('defaults to Anthropic on a fast model using the saved (decrypted) settings key', () => {
    const provider = createChatProviderFromSettings(source({ anthropic_api_key: 'sk-ant' }))
    expect(provider.id).toBe('anthropic')
    expect(provider.model).toBe(DEFAULT_ANTHROPIC_CHAT_MODEL)
  })

  it('honours chat_provider, chat_model and chat_base_url', () => {
    const provider = createChatProviderFromSettings(source({
      chat_provider: 'openai-compatible',
      chat_model: 'qwen2.5:7b',
      chat_base_url: 'http://localhost:11434/v1'
    }))
    expect(provider.id).toBe('openai-compatible')
    expect(provider.model).toBe('qwen2.5:7b')
  })

  it('falls back to an agent api_keys entry, default agent first', () => {
    const src = source({}, [
      { config: { api_keys: { anthropic: 'from-second' } } },
      { is_default: true, config: { api_keys: { anthropic: 'from-default', openai: 'oai-default' } } }
    ])
    expect(resolveChatApiKey(src, 'anthropic')).toBe('from-default')
    expect(resolveChatApiKey(src, 'openai')).toBe('oai-default')
    expect(createChatProviderFromSettings(src).id).toBe('anthropic')
  })

  it('prefers the settings key over agent keys', () => {
    const src = source({ anthropic_api_key: 'settings-key' }, [{ config: { api_keys: { anthropic: 'agent-key' } } }])
    expect(resolveChatApiKey(src, 'anthropic')).toBe('settings-key')
  })

  it('fails with a clear message when no Anthropic key exists anywhere', () => {
    expect(() => createChatProviderFromSettings(source({}))).toThrow(/No Anthropic API key/)
  })

  it('ignores an unknown chat_provider value', () => {
    expect(createChatProviderFromSettings(source({ chat_provider: 'gemini', anthropic_api_key: 'k' })).id).toBe('anthropic')
  })
})
