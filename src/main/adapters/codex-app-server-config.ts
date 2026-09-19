/**
 * Pure builders for the `codex app-server` thread/turn parameters: model,
 * approval policy, sandbox, workspace roots and MCP servers.
 */

import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type { McpServerConfig, SessionConfig } from './coding-agent-adapter'

const DEFAULT_CODEX_APP_SERVER_MODEL = 'gpt-6-astra'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; networkAccess: boolean; writableRoots: string[] }
  | { type: 'dangerFullAccess' }

function normalizeCodexMcpServerName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized || 'mcp_server'
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function resolveSandboxMode(config: SessionConfig): SandboxMode {
  switch (config.sandboxMode) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return config.sandboxMode
    default:
      return 'danger-full-access'
  }
}

/**
 * A git worktree's `.git` is a file pointing at metadata outside the
 * workspace; Codex must be allowed to write there too or commits fail.
 */
function resolveExternalGitRoots(workspaceDir: string): string[] {
  const workspaceRoot = resolve(workspaceDir)
  const dotGitPath = join(workspaceRoot, '.git')
  if (!existsSync(dotGitPath)) return []

  try {
    const dotGitContent = readFileSync(dotGitPath, 'utf8').trim()
    if (!dotGitContent.startsWith('gitdir:')) return []

    const rawGitDir = dotGitContent.slice('gitdir:'.length).trim()
    if (!rawGitDir) return []

    const gitDir = isAbsolute(rawGitDir)
      ? resolve(rawGitDir)
      : resolve(workspaceRoot, rawGitDir)
    const commonDirPath = join(gitDir, 'commondir')
    const rawCommonDir = existsSync(commonDirPath)
      ? readFileSync(commonDirPath, 'utf8').trim()
      : ''
    const commonDir = rawCommonDir
      ? (isAbsolute(rawCommonDir) ? resolve(rawCommonDir) : resolve(gitDir, rawCommonDir))
      : gitDir

    return [commonDir, gitDir].filter((path) => !isSubpath(workspaceRoot, path))
  } catch (error) {
    console.warn('[CodexAppServerAdapter] Failed to resolve external git metadata roots:', error)
    return []
  }
}

function buildRuntimeWorkspaceRoots(workspaceDir: string): string[] {
  const paths = [workspaceDir, ...resolveExternalGitRoots(workspaceDir)]
  return Array.from(new Set(paths.filter(Boolean).map((path) => resolve(path))))
}

function convertMcpServers(servers: Record<string, McpServerConfig>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(servers)) {
    const codexName = normalizeCodexMcpServerName(name)
    if (server.type === 'stdio') {
      result[codexName] = {
        command: server.command,
        args: server.args || [],
        env: server.env || {}
      }
    } else {
      const remoteConfig: Record<string, unknown> = { url: server.url }
      if (server.headers && Object.keys(server.headers).length > 0) {
        remoteConfig.http_headers = server.headers
      }
      result[codexName] = remoteConfig
    }
  }
  return result
}

export function buildConfigOverrides(config: SessionConfig): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  if (config.reasoningEffort && config.reasoningEffort !== 'max') {
    overrides.model_reasoning_effort = config.reasoningEffort
  }
  if (resolveSandboxMode(config) === 'workspace-write') {
    overrides.sandbox_workspace_write = {
      network_access: true,
      writable_roots: buildRuntimeWorkspaceRoots(config.workspaceDir)
    }
  }
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    overrides.mcp_servers = convertMcpServers(config.mcpServers)
  }
  return overrides
}

/** Parameters shared by thread/start, thread/resume and turn/start. */
export function buildThreadParams(config: SessionConfig): Record<string, unknown> {
  return {
    cwd: config.workspaceDir,
    model: config.model || DEFAULT_CODEX_APP_SERVER_MODEL,
    approvalPolicy: config.permissionMode === 'allow' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox: resolveSandboxMode(config),
    runtimeWorkspaceRoots: buildRuntimeWorkspaceRoots(config.workspaceDir),
    config: buildConfigOverrides(config)
  }
}

export function buildSandboxPolicy(config: SessionConfig): CodexSandboxPolicy {
  switch (resolveSandboxMode(config)) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: true }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        networkAccess: true,
        writableRoots: buildRuntimeWorkspaceRoots(config.workspaceDir)
      }
  }
}
