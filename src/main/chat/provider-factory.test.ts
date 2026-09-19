import { describe, expect, it } from 'vitest'
import type { AgentRecord } from '../database/types'
import { configuredChatModels, createChatProviderFromSettings, resolveChatApiKey, type ChatSettingsSource } from './provider-factory'

function source(settings: Record<string, string>, agents: Array<Partial<AgentRecord>> = []): ChatSettingsSource {
  return {
    getSetting: (key) => settings[key],
    getAgents: () => agents.map((a, i) => ({
      id: `a${i}`, name: `agent ${i}`, server_url: '', is_default: false, created_at: '', updated_at: '', config: {}, ...a
    }))
  }
}

describe('createChatProviderFromSettings', () => {
  it('defaults to the configured default agent model', () => {
    const provider = createChatProviderFromSettings(source({ anthropic_api_key: 'sk-ant' }, [
      { config: { coding_agent: 'codex', model: 'gpt-other' } },
      { is_default: true, config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'high' } }
    ]))
    expect(provider.id).toBe('anthropic')
    expect(provider.model).toBe('claude-saved')
  })

  it('honours chat_provider, chat_model and chat_base_url', () => {
    const provider = createChatProviderFromSettings(source({
      chat_provider: 'openai-compatible',
      chat_model: 'qwen2.5:7b',
      chat_base_url: 'http://localhost:11434/v1',
      chat_reasoning_effort: 'high'
    }, [{ config: { coding_agent: 'codex', model: 'qwen2.5:7b' } }]))
    expect(provider.id).toBe('openai-compatible')
    expect(provider.model).toBe('qwen2.5:7b')
  })

  it('ignores an unknown reasoning effort', () => {
    expect(() => createChatProviderFromSettings(source({
      anthropic_api_key: 'k',
      chat_reasoning_effort: 'turbo'
    }, [{ config: { coding_agent: 'claude-code', model: 'claude-saved' } }]))).not.toThrow()
  })

  it('exposes every model saved on a configured agent, routing by model name', () => {
    const models = configuredChatModels(source({}, [
      { id: 'open', is_default: true, config: { coding_agent: 'opencode', model: 'anthropic/claude-x' } },
      { id: 'claude', config: { coding_agent: 'claude-code', model: 'claude-saved', reasoning_effort: 'max' } },
      { id: 'empty', config: { coding_agent: 'codex' } },
      { id: 'codex', config: { coding_agent: 'codex', model: 'gpt-saved' } },
      { id: 'pi', config: { coding_agent: 'pi', model: 'cerebras/gpt-oss-120b' } }
    ]))
    expect(models).toEqual([
      { agentId: 'open', provider: 'anthropic', model: 'anthropic/claude-x', reasoningEffort: undefined },
      { agentId: 'claude', provider: 'anthropic', model: 'claude-saved', reasoningEffort: 'max' },
      { agentId: 'codex', provider: 'openai-compatible', model: 'gpt-saved', reasoningEffort: undefined },
      { agentId: 'pi', provider: 'openai-compatible', model: 'cerebras/gpt-oss-120b', reasoningEffort: undefined }
    ])
  })

  it('sends a pi agent model the commander selected through the matching transport', () => {
    const provider = createChatProviderFromSettings(source({
      chat_provider: 'openai-compatible',
      chat_model: 'cerebras/gpt-oss-120b',
      anthropic_api_key: 'k'
    }, [{ config: { coding_agent: 'pi', model: 'cerebras/gpt-oss-120b', api_keys: { openai: 'oai-key' } } }]))
    expect(provider.id).toBe('openai-compatible')
    expect(provider.model).toBe('cerebras/gpt-oss-120b')
  })

  it('falls back to an agent api_keys entry, default agent first', () => {
    const src = source({}, [
      { config: { coding_agent: 'claude-code', model: 'claude-second', api_keys: { anthropic: 'from-second' } } },
      { is_default: true, config: { coding_agent: 'claude-code', model: 'claude-default', api_keys: { anthropic: 'from-default', openai: 'oai-default' } } }
    ])
    expect(resolveChatApiKey(src, 'anthropic')).toBe('from-default')
    expect(resolveChatApiKey(src, 'openai')).toBe('oai-default')
    expect(createChatProviderFromSettings(src).id).toBe('anthropic')
  })

  it('prefers the settings key over agent keys', () => {
    const src = source({ anthropic_api_key: 'settings-key' }, [{ config: { api_keys: { anthropic: 'agent-key' } } }])
    expect(resolveChatApiKey(src, 'anthropic')).toBe('settings-key')
  })

  it('uses Claude Code subscription authentication when no Anthropic key exists', () => {
    const provider = createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'claude-code', model: 'claude-saved', auth_method: 'subscription' } }
    ]))
    expect(provider.id).toBe('claude-code-subscription')
    expect(provider.model).toBe('claude-saved')
  })

  it('keeps a Claude Code subscription on subscription auth when a global API key is saved', () => {
    const provider = createChatProviderFromSettings(source({ anthropic_api_key: 'unrelated-api-key' }, [
      { config: { coding_agent: 'claude-code', model: 'claude-saved', auth_method: 'subscription' } }
    ]))
    expect(provider.id).toBe('claude-code-subscription')
  })

  it('treats an older Claude Code agent with no auth_method as subscription-backed', () => {
    expect(createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'claude-code', model: 'claude-saved' } }
    ])).id).toBe('claude-code-subscription')
  })

  it('fails clearly when an API-key Claude agent has no Anthropic key', () => {
    expect(() => createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'claude-code', model: 'claude-saved', auth_method: 'api_key' } }
    ]))).toThrow(/needs Anthropic authentication/)
  })

  it('uses Codex subscription authentication for Sol instead of requiring an OpenAI API key', () => {
    const provider = createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'codex', model: 'gpt-5.6-sol', auth_method: 'subscription' } }
    ]))
    expect(provider.id).toBe('codex-subscription')
    expect(provider.model).toBe('gpt-5.6-sol')
  })

  it('keeps a Codex subscription on subscription auth when a global API key is saved', () => {
    const provider = createChatProviderFromSettings(source({ openai_api_key: 'unrelated-api-key' }, [
      { config: { coding_agent: 'codex', model: 'gpt-5.6-sol', auth_method: 'subscription' } }
    ]))
    expect(provider.id).toBe('codex-subscription')
  })

  it('treats a legacy Codex agent without an explicit key as subscription-backed', () => {
    expect(createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'codex', model: 'gpt-5.6-sol' } }
    ])).id).toBe('codex-subscription')
  })

  it('uses direct OpenAI auth for an API-key Codex agent', () => {
    expect(createChatProviderFromSettings(source({}, [
      { config: { coding_agent: 'codex', model: 'gpt-5.6-sol', auth_method: 'api_key', api_keys: { openai: 'agent-key' } } }
    ])).id).toBe('openai-compatible')
  })

  it('routes duplicate model names through the specifically selected agent auth', () => {
    const agents: Array<Partial<AgentRecord>> = [
      { id: 'subscription-agent', is_default: true, config: { coding_agent: 'codex', model: 'gpt-5.6-sol', auth_method: 'subscription' } },
      { id: 'api-agent', config: { coding_agent: 'codex', model: 'gpt-5.6-sol', auth_method: 'api_key', api_keys: { openai: 'agent-key' } } }
    ]
    const provider = createChatProviderFromSettings(source({
      chat_agent_id: 'api-agent',
      chat_provider: 'openai-compatible',
      chat_model: 'gpt-5.6-sol'
    }, agents))
    expect(provider.id).toBe('openai-compatible')
  })

  it('ignores a saved provider/model that is not configured', () => {
    const provider = createChatProviderFromSettings(source({
      chat_provider: 'openai-compatible',
      chat_model: 'not-configured',
      anthropic_api_key: 'k'
    }, [{ is_default: true, config: { coding_agent: 'claude-code', model: 'claude-saved' } }]))
    expect(provider.id).toBe('anthropic')
    expect(provider.model).toBe('claude-saved')
  })

  it('fails clearly instead of inventing a model when none is configured', () => {
    expect(() => createChatProviderFromSettings(source({ anthropic_api_key: 'k' })))
      .toThrow(/No compatible Commander model is configured/)
  })
})
