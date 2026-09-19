/**
 * Claude Agent SDK query options derived from the session config: MCP servers,
 * MCP tool limits, secret injection and the process environment.
 */

import type { SessionConfig } from './coding-agent-adapter'
import { claudeServerPrefix, claudeToolIds, resolveDisallowedToolNames } from '../mcp-tool-limits'
import { buildShellExports } from './shared/shell-exports'

type Options = import('@anthropic-ai/claude-agent-sdk').Options
type McpServerConfig = import('@anthropic-ai/claude-agent-sdk').McpServerConfig
type HookCallback = import('@anthropic-ai/claude-agent-sdk').HookCallback
type HookCallbackMatcher = import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher

type HookMap = Partial<Record<string, HookCallbackMatcher[]>>

/** Combine hook maps, keeping every matcher from each event. */
export function mergeHooks(...maps: Array<HookMap | undefined>): HookMap | undefined {
  const merged: HookMap = {}
  for (const map of maps) {
    if (!map) continue
    for (const [event, matchers] of Object.entries(map)) {
      if (!matchers) continue
      merged[event] = [...(merged[event] || []), ...matchers]
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * The MCP servers handed to the SDK, without the 21x-only `enabledTools` /
 * `knownTools` fields. The limit is enforced through `disallowedTools` and a
 * PreToolUse hook instead.
 */
export function buildClaudeMcpServers(config: SessionConfig): Record<string, McpServerConfig> | undefined {
  if (!config.mcpServers) return undefined
  const cleaned: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const rest: Record<string, unknown> = { ...server }
    delete rest.enabledTools
    delete rest.knownTools
    cleaned[name] = rest
  }
  return cleaned as Record<string, McpServerConfig>
}

/**
 * MCP isolation and per-agent tool limits.
 *
 * `strictMcpConfig` makes the SDK use only the servers 21x passes in, instead
 * of also loading project `.mcp.json`, user MCP settings, plugins and agent
 * frontmatter. Without it the agent's MCP server selection, and the tool
 * limits below, could be widened by a file in the repository being worked on.
 *
 * `disallowedTools` removes each tool the agent may not use from the model's
 * context. It can only name tools the server advertised when its tool list
 * was last refreshed, so the PreToolUse hook from buildMcpToolLimitHooks
 * also rejects any other tool on a restricted server. The key is omitted
 * when nothing is restricted.
 */
export function buildIsolationOptions(config: SessionConfig): Partial<Options> {
  const disallowedTools: string[] = []
  for (const [name, server] of Object.entries(config.mcpServers || {})) {
    for (const tool of resolveDisallowedToolNames({
      serverTools: (server.knownTools || []).map(toolName => ({ name: toolName })),
      limit: server.enabledTools
    })) {
      disallowedTools.push(...claudeToolIds(name, tool))
    }
  }
  return {
    strictMcpConfig: true,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {})
  }
}

/**
 * PreToolUse hook that denies any tool on a restricted MCP server that is not
 * in the agent's allowlist. Hooks run in every permission mode, including
 * bypassPermissions, so this holds even for tools added to the server after
 * the limit was saved.
 */
export function buildMcpToolLimitHooks(config: SessionConfig): HookMap | undefined {
  const allowedByPrefix = new Map<string, Set<string>>()
  for (const [name, server] of Object.entries(config.mcpServers || {})) {
    if (server.enabledTools === undefined) continue
    const prefix = claudeServerPrefix(name)
    const allowed = allowedByPrefix.get(prefix) ?? new Set<string>()
    for (const tool of server.enabledTools) {
      for (const id of claudeToolIds(name, tool)) allowed.add(id)
    }
    allowedByPrefix.set(prefix, allowed)
  }
  if (allowedByPrefix.size === 0) return undefined

  const hook: HookCallback = async (input) => {
    const toolName = 'tool_name' in input ? String(input.tool_name) : ''
    for (const [prefix, allowed] of allowedByPrefix) {
      if (toolName.startsWith(prefix) && !allowed.has(toolName)) {
        console.warn(`[ClaudeCodeAdapter] Blocked MCP tool outside this agent's tool limit: ${toolName}`)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `${toolName} is not enabled for this agent.`
          }
        }
      }
    }
    return {}
  }

  return { PreToolUse: [{ matcher: 'mcp__.*', hooks: [hook] }] }
}

/**
 * PreToolUse hook that prepends `export KEY='value'` lines to each Bash
 * command. The model never sees the modified command — only the original tool
 * call and the output appear in the conversation.
 */
export function buildSecretHooks(config: SessionConfig): HookMap | undefined {
  const secretEnvVars = config.secretEnvVars
  if (!secretEnvVars || Object.keys(secretEnvVars).length === 0) {
    return undefined
  }

  const exportLines = buildShellExports(secretEnvVars)
  console.log(`[ClaudeCodeAdapter] Registering PreToolUse hook for secrets: [${Object.keys(secretEnvVars).join(', ')}]`)

  const hook: HookCallback = async (input) => {
    const toolInput = ('tool_input' in input ? input.tool_input : undefined) as Record<string, unknown> | undefined
    if (!toolInput?.command) {
      return {}
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        updatedInput: { ...toolInput, command: exportLines + '\n' + (toolInput.command as string) }
      }
    }
  }

  return { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] }
}

/** CLAUDECODE is removed so the CLI does not refuse to start as a nested session. */
export function buildClaudeEnvironment(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  delete env.CLAUDECODE
  return env
}
