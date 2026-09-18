import { CHAT_SETTING_KEYS, isChatProviderId, type ChatProviderId } from '../../shared/chat'
import type { AgentRecord } from '../database/types'
import { AnthropicChatProvider } from './providers/anthropic'
import { OpenAICompatibleChatProvider } from './providers/openai-compatible'
import type { ChatProvider, FetchLike } from './providers/types'

/**
 * Builds the provider the settings point at.
 *
 * API keys are never chat settings of their own. They come from the existing
 * `anthropic_api_key` / `openai_api_key` rows, which DatabaseManager stores
 * encrypted and hands back as plaintext only inside the main process, or from
 * an agent's `config.api_keys` as a fallback. The renderer only ever sees the
 * "a key is saved" marker (see ipc/settings.ts).
 */

/** The slice of DatabaseManager the factory reads; tests stub it. */
export interface ChatSettingsSource {
  getSetting(key: string): string | undefined
  getAgents(): AgentRecord[]
}

export interface ChatProviderFactoryOptions {
  fetch?: FetchLike
}

export const DEFAULT_CHAT_PROVIDER: ChatProviderId = 'anthropic'

function agentApiKey(source: ChatSettingsSource, vendor: 'anthropic' | 'openai'): string | undefined {
  let agents: AgentRecord[]
  try {
    agents = source.getAgents()
  } catch {
    return undefined
  }
  // Default agent first, then insertion order: whichever the user set up first wins.
  const ordered = [...agents].sort((a, b) => Number(b.is_default) - Number(a.is_default))
  for (const agent of ordered) {
    const key = agent.config?.api_keys?.[vendor]
    if (key) return key
  }
  return undefined
}

export function resolveChatApiKey(source: ChatSettingsSource, vendor: 'anthropic' | 'openai'): string | undefined {
  return source.getSetting(`${vendor}_api_key`) || agentApiKey(source, vendor)
}

export function resolveChatProviderId(source: ChatSettingsSource): ChatProviderId {
  const configured = source.getSetting(CHAT_SETTING_KEYS.provider)
  return isChatProviderId(configured) ? configured : DEFAULT_CHAT_PROVIDER
}

export function createChatProviderFromSettings(
  source: ChatSettingsSource,
  options: ChatProviderFactoryOptions = {}
): ChatProvider {
  const providerId = resolveChatProviderId(source)
  const model = source.getSetting(CHAT_SETTING_KEYS.model)?.trim() || undefined
  const baseUrl = source.getSetting(CHAT_SETTING_KEYS.baseUrl)?.trim() || undefined

  if (providerId === 'openai-compatible') {
    return new OpenAICompatibleChatProvider({
      model,
      baseUrl,
      apiKey: resolveChatApiKey(source, 'openai'),
      fetch: options.fetch
    })
  }

  const apiKey = resolveChatApiKey(source, 'anthropic')
  if (!apiKey) {
    throw new Error('No Anthropic API key is saved. Add one under Settings → Advanced, or choose another chat provider.')
  }
  return new AnthropicChatProvider({ apiKey, model, baseUrl, fetch: options.fetch })
}
