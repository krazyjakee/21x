import { mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { SessionConfig } from '../coding-agent-adapter'

/**
 * Decides how Codex authenticates for a session and mutates `env` to match.
 * Shared by the Codex ACP and Codex app-server adapters.
 *
 * The user's explicit choice (config.authMethod) is the source of truth:
 *   - 'subscription' -> use the Codex CLI login (~/.codex), exactly like running
 *     `codex` in a terminal. Any ambient OPENAI_API_KEY/CODEX_API_KEY inherited
 *     from the user's shell is STRIPPED so it cannot hijack auth into API-key
 *     mode (which bills a separate, often-exhausted quota and made 20x show
 *     "out of rate limits" even though the terminal subscription worked fine).
 *   - 'api_key' -> use an API key (the per-agent config key if set, otherwise the
 *     ambient one) in an isolated temp CODEX_HOME so keys can differ per session.
 *
 * When authMethod is unset (legacy agents), only an explicitly-configured
 * per-agent API key implies API-key mode; otherwise the subscription path is used.
 *
 * Must run AFTER secret env vars are merged into `env`: a user secret named
 * OPENAI_API_KEY / CODEX_API_KEY would otherwise be re-added after subscription
 * mode stripped it, re-hijacking Codex into API-key auth.
 */
export function applyCodexAuthEnv(
  env: Record<string, string | undefined>,
  config: Pick<SessionConfig, 'authMethod' | 'apiKeys'>
): { usesApiKey: boolean; summary: string } {
  const authMethod = config.authMethod ?? 'legacy'
  const explicitApiKey = config.apiKeys?.openai
  const usesApiKey =
    config.authMethod === 'api_key' ? true
    : config.authMethod === 'subscription' ? false
    : !!explicitApiKey

  if (usesApiKey) {
    const key = explicitApiKey || env.OPENAI_API_KEY || env.CODEX_API_KEY
    if (key) {
      env.OPENAI_API_KEY = key
      env.CODEX_API_KEY = key
    }
    env.NO_BROWSER = '1'
    env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-session-'))
    return { usesApiKey, summary: `API key (authMethod=${authMethod}, isolated CODEX_HOME)` }
  }

  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  // Pin CODEX_HOME to the directory the `codex` CLI uses in a terminal so the
  // existing subscription login is read. A custom CODEX_HOME inherited from the
  // user's shell is preserved.
  if (!env.CODEX_HOME) {
    env.CODEX_HOME = join(homedir(), '.codex')
  }
  return { usesApiKey, summary: `subscription (authMethod=${authMethod}, CODEX_HOME=${env.CODEX_HOME})` }
}
