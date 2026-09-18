/**
 * Validation of unified MCP server definitions before they are written, and
 * of entries as found on disk (so a broken external entry is flagged rather
 * than silently shown as healthy).
 */

import type { CliId, McpServerDefinition } from '../../shared/cli-mcp-config'

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const CODEX_NAME = /^[A-Za-z0-9_-]+$/

export function validateServerName(cli: CliId, name: string): string[] {
  const issues: string[] = []
  if (!name.trim()) issues.push('Server name is required.')
  if (/[\r\n]/.test(name)) issues.push('Server name cannot contain line breaks.')
  if (cli === 'codex' && name && !CODEX_NAME.test(name)) {
    issues.push('Codex server names may only contain letters, digits, "_" and "-".')
  }
  return issues
}

export function validateDefinition(definition: McpServerDefinition): string[] {
  const issues: string[] = []
  if (definition.transport === 'stdio') {
    if (!definition.command?.trim()) issues.push('A command is required for a stdio server.')
    if (definition.args && !definition.args.every((arg) => typeof arg === 'string')) issues.push('Arguments must be strings.')
  } else if (definition.transport === 'http' || definition.transport === 'sse') {
    if (!definition.url?.trim()) {
      issues.push('A URL is required for a remote server.')
    } else {
      try {
        const parsed = new URL(definition.url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') issues.push('The URL must use http or https.')
      } catch {
        issues.push(`"${definition.url}" is not a valid URL.`)
      }
    }
  } else {
    issues.push(`Unknown transport "${String(definition.transport)}".`)
  }
  for (const key of Object.keys(definition.env ?? {})) {
    if (!ENV_KEY.test(key)) issues.push(`"${key}" is not a valid environment variable name.`)
  }
  for (const key of Object.keys(definition.headers ?? {})) {
    if (!key.trim() || /[\r\n:]/.test(key)) issues.push(`"${key}" is not a valid header name.`)
  }
  return issues
}
