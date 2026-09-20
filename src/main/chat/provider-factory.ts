import {
  CHAT_SETTING_KEYS,
  chatProviderForAgentModel,
  isChatReasoningEffort,
  type ChatProviderId,
  type ChatReasoningEffort
} from '../../shared/chat'
import type { AgentRecord } from '../database/types'
import { AnthropicChatProvider } from './providers/anthropic'
import { ClaudeCodeSubscriptionChatProvider } from './providers/claude-code-subscription'
import { CodexSubscriptionChatProvider } from './providers/codex-subscription'
import { OpenAICompatibleChatProvider } from './providers/openai-compatible'
import type { ChatProvider, FetchLike } from './providers/types'
import { readVendorConfig } from './vendor-config'

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

export interface ConfiguredChatModel {
  agentId: string
  provider: ChatProviderId
  model: string
  reasoningEffort?: ChatReasoningEffort
}

function providerForAgent(agent: AgentRecord): ChatProviderId | null {
  return chatProviderForAgentModel(agent.config?.coding_agent, agent.config?.model)
}

function configuredReasoningEffort(agent: AgentRecord) {
  const effort = agent.config?.reasoning_effort
  return isChatReasoningEffort(effort) ? effort : undefined
}

/** Only models the user explicitly saved on configured agent records. */
export function configuredChatModels(source: ChatSettingsSource): ConfiguredChatModel[] {
  let agents: AgentRecord[]
  try {
    agents = source.getAgents()
  } catch {
    return []
  }
  return [...agents]
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))
    .flatMap((agent) => {
      const provider = providerForAgent(agent)
      const model = agent.config?.model?.trim()
      return provider && model
        ? [{ agentId: agent.id, provider, model, reasoningEffort: configuredReasoningEffort(agent) }]
        : []
    })
}

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

/** The agent behind a model choice, default agent first like the renderer. */
function agentForSelection(
  source: ChatSettingsSource,
  selection: Pick<ConfiguredChatModel, 'agentId' | 'provider' | 'model'>
): AgentRecord | undefined {
  try {
    const agents = [...source.getAgents()].sort((a, b) => Number(b.is_default) - Number(a.is_default))
    return agents.find((agent) => agent.id === selection.agentId)
      ?? agents.find((agent) => providerForAgent(agent) === selection.provider && agent.config?.model?.trim() === selection.model)
  } catch {
    return undefined
  }
}

/** Mirrors the legacy-auth rule in adapters/shared/codex-auth.ts. */
function codexUsesSubscription(agent: AgentRecord | undefined): boolean {
  if (agent?.config?.coding_agent !== 'codex') return false
  if (agent.config.auth_method === 'api_key') return false
  if (agent.config.auth_method === 'subscription') return true
  return !agent.config.api_keys?.openai
}

function claudeUsesSubscription(agent: AgentRecord | undefined, hasApiKey: boolean): boolean {
  if (agent?.config?.coding_agent !== 'claude-code') return false
  if (agent.config.auth_method === 'api_key') return false
  if (agent.config.auth_method === 'subscription') return true
  return !hasApiKey
}

export function resolveChatApiKey(source: ChatSettingsSource, vendor: 'anthropic' | 'openai'): string | undefined {
  return source.getSetting(`${vendor}_api_key`) || agentApiKey(source, vendor)
}

export function resolveChatProviderId(source: ChatSettingsSource): ChatProviderId {
  const agentId = source.getSetting(CHAT_SETTING_KEYS.agentId)
  const configured = source.getSetting(CHAT_SETTING_KEYS.provider)
  const model = source.getSetting(CHAT_SETTING_KEYS.model)?.trim()
  const available = configuredChatModels(source)
  const selected = available.find((option) => option.agentId === agentId && option.provider === configured && option.model === model)
    ?? available.find((option) => option.provider === configured && option.model === model)
    ?? available[0]
  if (!selected) {
    throw new Error('No compatible Commander model is configured. Save a model on any coding agent first.')
  }
  return selected.provider
}

/**
 * `vendor/model` selections (e.g. `cerebras/gpt-oss-120b`) keep the full
 * string for display and settings, but the API call goes to the vendor's own
 * endpoint, uses the vendor's key, and sends the bare model id.
 */
export function splitModelSelection(model: string): { vendor: string | undefined; modelId: string } {
  const slash = model.indexOf('/')
  if (slash > 0 && slash < model.length - 1) {
    return { vendor: model.slice(0, slash), modelId: model.slice(slash + 1) }
  }
  return { vendor: undefined, modelId: model }
}

export function createChatProviderFromSettings(
  source: ChatSettingsSource,
  options: ChatProviderFactoryOptions = {}
): ChatProvider {
  const configuredAgentId = source.getSetting(CHAT_SETTING_KEYS.agentId)
  const configuredProvider = source.getSetting(CHAT_SETTING_KEYS.provider)
  const configuredModel = source.getSetting(CHAT_SETTING_KEYS.model)?.trim()
  const available = configuredChatModels(source)
  const savedSelection = available.find((option) =>
    option.agentId === configuredAgentId && option.provider === configuredProvider && option.model === configuredModel
  ) ?? available.find((option) => option.provider === configuredProvider && option.model === configuredModel)
  const selected = savedSelection ?? available[0]
  if (!selected) {
    throw new Error('No compatible Commander model is configured. Save a model on any coding agent first.')
  }
  const providerId = selected.provider
  const model = selected.model
  const selectedAgent = agentForSelection(source, selected)
  const baseUrlSetting = source.getSetting(CHAT_SETTING_KEYS.baseUrl)?.trim() || undefined
  const configuredEffort = source.getSetting(CHAT_SETTING_KEYS.reasoningEffort)
  const reasoningEffort = savedSelection && isChatReasoningEffort(configuredEffort)
    ? configuredEffort
    : selected.reasoningEffort

  if (providerId === 'openai-compatible') {
    const { vendor, modelId } = splitModelSelection(model)
    // OpenAI's HTTP API cannot consume a Codex/ChatGPT subscription. Run the
    // selected model through the authenticated Codex CLI, just as a normal
    // Codex agent session does. An explicit API-key agent keeps the direct
    // HTTP transport below.
    if (!vendor && !baseUrlSetting && codexUsesSubscription(selectedAgent)) {
      return new CodexSubscriptionChatProvider({ model, reasoningEffort })
    }
    let baseUrl = baseUrlSetting
    // A vendor-qualified model owns its credentials. In particular, never
    // forward a saved OpenAI key to a local provider such as llama.cpp.
    let apiKey = vendor ? undefined : resolveChatApiKey(source, 'openai')
    if (vendor) {
      // The model's own provider owns the endpoint and the credentials (see
      // vendor-config); the OpenAI defaults and key do not apply to it.
      const vendorConfig = readVendorConfig(vendor, modelId)
      if (!baseUrl && vendorConfig.baseUrl) baseUrl = vendorConfig.baseUrl
      apiKey = vendorConfig.apiKey
      if (!apiKey && !baseUrl) {
        throw new Error(`No API key found for the "${vendor}" provider. Save one for that provider or set the ${vendor.toUpperCase().replace(/-/g, '_')}_API_KEY environment variable.`)
      }
    }
    return new OpenAICompatibleChatProvider({
      model,
      modelId,
      baseUrl,
      apiKey,
      reasoningEffort,
      fetch: options.fetch
    })
  }

  const apiKey = resolveChatApiKey(source, 'anthropic')
  // An explicit subscription choice is authoritative. Legacy agents retain
  // the old API-key behavior when a key is already configured, and otherwise
  // use the Claude Code login.
  if (claudeUsesSubscription(selectedAgent, !!apiKey)) {
    return new ClaudeCodeSubscriptionChatProvider({
      model,
      reasoningEffort: reasoningEffort === 'minimal' ? undefined : reasoningEffort
    })
  }

  if (!apiKey) {
    throw new Error('This Commander model needs Anthropic authentication. Use a Claude Code subscription agent, save an Anthropic API key, or choose another model.')
  }
  return new AnthropicChatProvider({
    apiKey,
    model,
    modelId: splitModelSelection(model).modelId,
    baseUrl: baseUrlSetting,
    reasoningEffort: reasoningEffort === 'minimal' ? undefined : reasoningEffort,
    fetch: options.fetch
  })
}
