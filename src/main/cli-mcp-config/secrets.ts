/**
 * Secret handling for global CLI MCP config.
 *
 * Values that look like secrets are masked before they cross IPC, and never
 * logged. When the user supplies a secret-looking value, 20x writes an
 * environment reference (`${VAR}` in the unified shape; each CLI store
 * translates it) instead of the plaintext, so nothing 20x writes is a secret.
 * Plaintext that was already on disk is left exactly as it was found.
 */

import { MASKED_SECRET } from '../../shared/cli-mcp-config'

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|bearer|cookie|session)/i
const SECRET_HEADER_PATTERN = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)$/i

/** `${VAR}` — the reference syntax of the unified definition. */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

export function isReference(value: string): boolean {
  REFERENCE_PATTERN.lastIndex = 0
  // `{file:path}` is OpenCode's file reference; it names a path, not a value.
  return REFERENCE_PATTERN.test(value) || /^\{file:[^}]+\}$/.test(value)
}

/** The variable names referenced by a value (`Bearer ${A} ${B}` → [A, B]). */
export function referenceNames(value: string): string[] {
  const names: string[] = []
  for (const match of value.matchAll(REFERENCE_PATTERN)) names.push(match[1])
  return names
}

/** Whether the value is exactly one reference and nothing else. */
export function isPureReference(value: string): string | null {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  return match ? match[1] : null
}

/**
 * Whether an env var or header value should be treated as a secret. References
 * are never secrets: they hold a variable name, not a value.
 */
export function looksLikeSecret(kind: 'env' | 'header', key: string, value: string): boolean {
  if (!value || isReference(value)) return false
  if (kind === 'header' && SECRET_HEADER_PATTERN.test(key)) return true
  if (SECRET_KEY_PATTERN.test(key)) return true
  // Long opaque strings with no spaces (API keys, JWTs) even under a bland key.
  if (value.length >= 32 && !/\s/.test(value) && /^[A-Za-z0-9._~+/=-]+$/.test(value)) return true
  return false
}

export interface MaskedRecord {
  values: Record<string, string>
  maskedKeys: string[]
}

export function maskRecord(kind: 'env' | 'header', record: Record<string, string> | undefined): MaskedRecord {
  const values: Record<string, string> = {}
  const maskedKeys: string[] = []
  for (const [key, value] of Object.entries(record ?? {})) {
    if (looksLikeSecret(kind, key, value)) {
      values[key] = MASKED_SECRET
      maskedKeys.push(key)
    } else {
      values[key] = value
    }
  }
  return { values, maskedKeys }
}

/**
 * Merges values the UI sent back with what is on disk: a masked placeholder
 * keeps the on-disk value, and a new plaintext secret becomes a reference.
 * Returns the record to write plus human-readable warnings.
 */
export function reconcileSecretValues(
  kind: 'env' | 'header',
  incoming: Record<string, string> | undefined,
  onDisk: Record<string, string> | undefined,
  referenceVarNameFor: (key: string) => string
): { values: Record<string, string>; warnings: string[]; referenced: Array<{ key: string; variable: string }> } {
  const values: Record<string, string> = {}
  const warnings: string[] = []
  const referenced: Array<{ key: string; variable: string }> = []
  for (const [key, rawValue] of Object.entries(incoming ?? {})) {
    if (!key) continue
    if (rawValue === MASKED_SECRET) {
      const existing = onDisk?.[key]
      if (existing === undefined) {
        warnings.push(`${kind === 'env' ? 'Environment variable' : 'Header'} "${key}" had a masked value but nothing is on disk; it was dropped.`)
        continue
      }
      values[key] = existing
      continue
    }
    if (looksLikeSecret(kind, key, rawValue)) {
      const variable = referenceVarNameFor(key)
      values[key] = `\${${variable}}`
      referenced.push({ key, variable })
      warnings.push(`"${key}" looks like a secret. 21x wrote a reference to the ${variable} environment variable instead of the value; export ${variable} in the shell that starts the CLI.`)
      continue
    }
    values[key] = rawValue
  }
  return { values, warnings, referenced }
}

/** A shell-safe environment variable name for a header or env key. */
export function envVarNameForKey(serverName: string, key: string): string {
  const clean = (text: string): string => text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  if (/^[A-Z_][A-Z0-9_]*$/.test(key)) return key
  return `MCP_${clean(serverName)}_${clean(key)}` || 'MCP_SECRET'
}

/**
 * Resolves `${VAR}` references from an environment for a live probe. Never
 * logs the resolved values. Unresolved names are reported so the UI can say
 * which variable is missing instead of a bare connection error.
 */
export function resolveReferences(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv
): { values: Record<string, string>; unresolved: string[] } {
  const values: Record<string, string> = {}
  const unresolved = new Set<string>()
  for (const [key, value] of Object.entries(record ?? {})) {
    values[key] = value.replace(REFERENCE_PATTERN, (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name]
      if (resolved !== undefined) return resolved
      // `${VAR:-default}` keeps its default when VAR is unset.
      if (fallback !== undefined) return fallback
      unresolved.add(name)
      return ''
    })
  }
  return { values, unresolved: [...unresolved] }
}
