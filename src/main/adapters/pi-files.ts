/**
 * Files 20x writes for Pi: the per-session MCP config, the permission
 * extension, and the cleanup of an entry older releases put in Pi's models file.
 */

import { randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SessionConfig } from './coding-agent-adapter'
import { PI_PERMISSION_EXTENSION_SOURCE, buildPiMcpConfigDocument, sanitizePiSessionName } from './pi-config'

/** Identifies the hosted AI gateway entry older releases wrote to Pi's models file. */
const LEGACY_GATEWAY_PROVIDER_ID = 'peakflo'
const LEGACY_GATEWAY_API_KEY_REF = '$PEAKFLO_AI_GATEWAY_API_KEY'

/** Owner-only file, replaced atomically so Pi never reads a half-written one. */
function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.20x-${process.pid}.tmp`
  writeFileSync(temporaryPath, content, { mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, path)
}

/**
 * Earlier releases wrote a hosted AI gateway provider into Pi's models file.
 * Its key came from 20x at spawn time, so the entry cannot work any more.
 * Remove only that exact entry and leave everything else the user has.
 */
export function removeLegacyGatewayProvider(): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const modelsPath = join(agentDir, 'models.json')
  if (!existsSync(modelsPath)) return
  try {
    const root = JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers?: Record<string, { apiKey?: unknown }> }
    if (root.providers?.[LEGACY_GATEWAY_PROVIDER_ID]?.apiKey !== LEGACY_GATEWAY_API_KEY_REF) return
    const providers = { ...root.providers }
    delete providers[LEGACY_GATEWAY_PROVIDER_ID]
    writePrivateFile(modelsPath, `${JSON.stringify({ ...root, providers }, null, 2)}\n`)
  } catch (error) {
    console.warn('[PiAdapter] Could not remove the legacy gateway provider from Pi models file:', error)
  }
}

/** Writes the session's pi-mcp-adapter config; undefined when it has no MCP servers. */
export function writePiMcpConfig(config: SessionConfig): string | undefined {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return undefined
  const dir = join(homedir(), '.20x', 'pi-mcp')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sanitizePiSessionName(config.taskId)}-${randomUUID()}.json`)
  // Pi forwards MCP tools to the model as <server>_<tool> names, which most
  // providers cap at 64 characters. Sanitize server keys so a long display
  // name (e.g. "[Team] Shared Workspace Tools") cannot overflow the limit.
  const document = buildPiMcpConfigDocument(config.mcpServers, (name, slug) => {
    console.warn(`[PiAdapter] Renamed MCP server "${name}" to "${slug}" to fit the provider 64-char tool name limit`)
  })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function installPiPermissionExtension(): string {
  const dir = join(homedir(), '.20x', 'pi')
  const path = join(dir, 'permissions.ts')
  mkdirSync(dir, { recursive: true })
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (current !== PI_PERMISSION_EXTENSION_SOURCE) writePrivateFile(path, PI_PERMISSION_EXTENSION_SOURCE)
  chmodSync(path, 0o600)
  return path
}
