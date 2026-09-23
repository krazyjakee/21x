/**
 * The context window of a model, in tokens (managed sessions, #97).
 *
 * The figure comes from, in order:
 *
 * 1. `reported`: the backend said so for this session (Claude Code's
 *    `modelUsage[model].contextWindow`, Codex's `modelContextWindow`);
 * 2. `override`: the user or a caller configured it (local models, proxies);
 * 3. `known`: the static table below;
 * 4. `default`: nothing matched; a conservative guess.
 *
 * The table only needs to be right about the size class of a model, since
 * budgets built on it leave headroom. When a model is missing, add a row
 * instead of special-casing it at the call site.
 */

export type ContextWindowSource = 'reported' | 'override' | 'known' | 'default'

export interface ContextWindow {
  tokens: number
  source: ContextWindowSource
}

/** Used when nothing is known about the model: most current models take at least this much. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

const K = 1_000
const M = 1_000_000

/**
 * Patterns are matched against the normalised model id (lower case, without a
 * `provider/` prefix, a Bedrock/Vertex `anthropic.` prefix or a `[1m]`
 * suffix). The first match wins, so specific rows go before general ones.
 */
const KNOWN_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  // Anthropic. Every model from Opus 4.6 / Sonnet 4.6 on has a 1M window;
  // earlier ones have 200k (1M for some only with the `[1m]` / beta opt-in).
  [/^claude-(fable|mythos)-/, M],
  [/^claude-opus-4-[678]\b/, M],
  [/^claude-opus-[5-9]\b/, M],
  [/^claude-sonnet-4-6\b/, M],
  [/^claude-sonnet-[5-9]\b/, M],
  [/^claude-/, 200 * K],
  // Claude Code model aliases.
  [/^(opus|sonnet|fable)$/, M],
  [/^haiku$/, 200 * K],

  // OpenAI.
  [/^gpt-5/, 400 * K],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128 * K],
  [/^o[134](-|$)/, 200 * K],
  [/^gpt-oss/, 131_072],
  [/^codex-mini/, 200 * K],

  // Google.
  [/^gemini-(2\.5|3)/, 1_048_576],
  [/^gemini-/, M],

  // Common open-weight families served through OpenAI-compatible endpoints.
  [/^deepseek/, 128 * K],
  [/^qwen3?-coder/, 256 * K],
  [/^(kimi|moonshot)/, 256 * K],
  [/^glm-4\.[56]/, 128 * K],
  [/^(grok-4|grok-code)/, 256 * K]
]

/** Lower-cased model id without routing prefixes or the `[1m]` context suffix. */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase()
  id = id.replace(/\[1m\]$/, '')
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  // Bedrock (`anthropic.claude-…`, `us.anthropic.claude-…`) and Vertex (`claude-…@2025…`).
  id = id.replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  id = id.replace(/@.*$/, '')
  return id
}

/** The window the static table gives this model, or null when it has no row. */
export function knownContextWindow(model: string): number | null {
  const raw = model.trim().toLowerCase()
  // Claude Code's `[1m]` suffix asks for the 1M-context variant.
  if (/\[1m\]$/.test(raw)) return M
  const id = normalizeModelId(raw)
  if (!id) return null
  for (const [pattern, tokens] of KNOWN_WINDOWS) {
    if (pattern.test(id)) return tokens
  }
  return null
}

export interface ContextWindowOptions {
  /** A window the backend reported for this session; wins over everything. */
  reported?: number | null
  /** Per-model overrides, keyed by the model id as configured or its normalised form. */
  overrides?: Readonly<Record<string, number>>
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** The context window to budget against, with where the figure came from. */
export function contextWindowFor(model: string | null | undefined, options: ContextWindowOptions = {}): ContextWindow {
  if (positive(options.reported)) return { tokens: Math.floor(options.reported), source: 'reported' }
  const id = model?.trim() ?? ''
  if (id && options.overrides) {
    const override = options.overrides[id] ?? options.overrides[normalizeModelId(id)]
    if (positive(override)) return { tokens: Math.floor(override), source: 'override' }
  }
  const known = id ? knownContextWindow(id) : null
  if (known !== null) return { tokens: known, source: 'known' }
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' }
}
