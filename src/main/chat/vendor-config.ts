import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Vendor endpoint and credentials for `vendor/model` chat models.
 *
 * When a configured agent uses the `vendor/model` shape (e.g.
 * `cerebras/gpt-oss-120b`), that backend (Pi) resolves the HTTP endpoint and
 * API key for the vendor from its own agent directory. The chat runtime must
 * resolve the same values, or it sends a third-party model to the built-in
 * (OpenAI) endpoint with the OpenAI key and the turn fails before the first
 * token.
 *
 * Resolution, first hit wins:
 * - `<agent dir>/models-store.json` → per-model `baseUrl` (Pi's model store)
 * - `<agent dir>/models.json` → provider-level `baseUrl` and `apiKey`
 * - `<agent dir>/settings.json` → `providers.<vendor>.apiKey` (where Pi stores
 *   keys entered interactively)
 * - the `VENDOR_API_KEY` environment variable
 *
 * `baseUrl` falls back to `DEFAULT_VENDOR_BASE_URLS`, mirroring the endpoints
 * of Pi's built-in providers: those are compiled into Pi itself and never
 * written to any file, so a vendor key found via `settings.json` (e.g.
 * `cerebras`) would resolve to nothing on disk and the call would land on the
 * generic OpenAI endpoint.
 *
 * `apiKey` values may be `$ENVIRONMENT_VARIABLE` references; those are
 * resolved against the process environment.
 */

export interface VendorConfig {
  baseUrl?: string
  apiKey?: string
}

interface StoredModel {
  id?: string
  baseUrl?: string
}
interface StoredProvider {
  models?: StoredModel[]
}
interface ModelsStoreFile {
  providers?: Record<string, StoredProvider>
}
interface CustomProvider {
  baseUrl?: string
  apiKey?: string
}
interface ModelsFile {
  providers?: Record<string, CustomProvider>
}
interface SettingsFile {
  providers?: Record<string, { apiKey?: string }>
}

/** Endpoints of Pi's built-in providers, which are stored in no file. */
export const DEFAULT_VENDOR_BASE_URLS: Record<string, string> = {
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com',
  fireworks: 'https://api.fireworks.ai/inference',
  groq: 'https://api.groq.com/openai/v1',
  huggingface: 'https://router.huggingface.co/v1',
  mistral: 'https://api.mistral.ai',
  moonshotai: 'https://api.moonshot.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.ai/v1',
  xai: 'https://api.x.ai/v1'
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function resolveApiKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (!value.startsWith('$')) return value
  return process.env[value.slice(1)] || undefined
}

export function readVendorConfig(vendor: string, modelId?: string): VendorConfig {
  const dir = piAgentDir()
  const config: VendorConfig = {}

  const store = readJson<ModelsStoreFile>(join(dir, 'models-store.json'))
  const storedModel = store?.providers?.[vendor]?.models?.find((model) => model.id === modelId)
  if (storedModel?.baseUrl) config.baseUrl = storedModel.baseUrl

  const models = readJson<ModelsFile>(join(dir, 'models.json'))
  const custom = models?.providers?.[vendor]
  if (!config.baseUrl && custom?.baseUrl) config.baseUrl = custom.baseUrl
  if (!config.apiKey && custom?.apiKey) config.apiKey = resolveApiKey(custom.apiKey)

  if (!config.apiKey) {
    const settings = readJson<SettingsFile>(join(dir, 'settings.json'))
    config.apiKey = resolveApiKey(settings?.providers?.[vendor]?.apiKey)
  }

  if (!config.apiKey) {
    const envName = `${vendor.toUpperCase().replace(/-/g, '_')}_API_KEY`
    config.apiKey = process.env[envName] || undefined
  }

  if (!config.baseUrl) {
    config.baseUrl = DEFAULT_VENDOR_BASE_URLS[vendor]
  }

  return config
}