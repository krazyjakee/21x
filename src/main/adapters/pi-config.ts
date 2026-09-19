/**
 * Configuration helpers for the Pi adapter: provider-safe names, the
 * pi-mcp-adapter config document, the generated permission extension, and
 * the Pi process command line and environment.
 */

import type { SessionConfig } from './coding-agent-adapter'
import { nodeWorkerRuntime } from '../node-worker-runtime'

export const PI_PERMISSION_MODE_ENV = 'TWENTYX_PI_PERMISSION_MODE'

/**
 * Most model providers cap function/tool `name` at 64 characters. Pi forwards
 * MCP tools as `<server>_<tool>`-style names, so a long MCP server name (e.g.
 * "[Team] Shared Workspace Tools") plus a long tool name overflows the
 * limit and the whole turn fails with "name must be at most 64 characters".
 * Keep server slugs short to leave room for the tool suffix.
 */
const MAX_PI_NAME_LENGTH = 64
const MAX_PI_MCP_SERVER_SLUG_LENGTH = 24

function slugifyPiName(value: string, maxLength: number): string {
  return (value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '') || 'mcp')
}

/**
 * Generic rule for bracket-prefixed servers ("[Team] My tasks" →
 * "team-my-tasks"). Returns null when the name has no bracket prefix so
 * the caller falls back to plain slugification.
 */
function slugifyBracketPrefix(name: string): string | null {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(name)
  if (!match) return null
  const combined = `${match[1]}-${match[2]}`.trim()
  if (!combined.replace(/-/g, '')) return null
  return slugifyPiName(combined, MAX_PI_MCP_SERVER_SLUG_LENGTH)
}

export function sanitizePiSessionName(taskId: string): string {
  const slug = taskId
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_PI_NAME_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'pi-session'
}

export function sanitizePiMcpServerName(name: string, used: Set<string>): string {
  const base = slugifyBracketPrefix(name) ?? slugifyPiName(name, MAX_PI_MCP_SERVER_SLUG_LENGTH)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let index = 2; index < 1000; index++) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, MAX_PI_MCP_SERVER_SLUG_LENGTH - suffix.length)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  const fallback = `mcp-${used.size + 1}`
  used.add(fallback)
  return fallback
}

/**
 * Slugs for a session's MCP server names, in map-insertion order.
 *
 * Shared by {@link buildPiMcpConfigDocument} (what the adapter registers) and
 * workspace-docs.ts (what AGENTS.md tells the model to call), so the documented
 * tool names and the registered ones can't drift.
 */
export function slugPiMcpServers(names: string[]): Map<string, string> {
  const used = new Set<string>()
  return new Map(names.map((name) => [name, sanitizePiMcpServerName(name, used)]))
}

export function withProviderNameLimitHint(error: string): string {
  if (!/name must be at most 64/i.test(error)) return error
  return `${error}\n\nHint: a tool name exceeded the provider 64-character limit. 21x now keeps MCP tools behind short namespace proxies. Stop and start the agent to rebuild its tool list.`
}

/**
 * Build the pi-mcp-adapter document used by 20x sessions.
 *
 * Keep MCP servers behind namespace proxy tools (`mcp__<server>`). Direct MCP
 * tools concatenate the server and tool names; a 24-character server slug and
 * a 50-character generated workflow tool already produce a 76-character name.
 * Providers commonly reject the entire request when any tool exceeds 64
 * characters, before the model can call a tool.
 */
export function buildPiMcpConfigDocument(
  servers: NonNullable<SessionConfig['mcpServers']>,
  onRename?: (name: string, slug: string) => void,
): Record<string, unknown> {
  const slugs = slugPiMcpServers(Object.keys(servers))
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const slug = slugs.get(name) ?? name
    if (slug !== name) onRename?.(name, slug)
    if (server.type === 'stdio') {
      return [slug, {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
      }]
    }
    return [slug, {
      url: server.url,
      headers: server.headers ?? {},
    }]
  }))

  return {
    settings: {
      // This must be explicit because MCP_DIRECT_TOOLS and user-level Pi
      // settings can otherwise expose every `<server>_<tool>` directly.
      directTools: false,
    },
    mcpServers,
  }
}

export const PI_PERMISSION_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function inputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return String(input).slice(0, 4000);
  }
}

export default function permissions(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.${PI_PERMISSION_MODE_ENV} === "allow" || READ_ONLY_TOOLS.has(event.toolName)) return;
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      inputSummary(event.input),
    );
    if (!approved) return { block: true, reason: \`\${event.toolName} was declined in 20x.\` };
  });
}
`

/** `provider/model` → Pi's set_model fields; a bare name is a model id. */
export function splitPiModel(model?: string): { provider?: string; modelId?: string } {
  if (!model) return {}
  const separator = model.indexOf('/')
  if (separator < 0) return { modelId: model }
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
}

export function piProcessEnv(config: SessionConfig): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...(config.secretEnvVars ?? {}),
    [PI_PERMISSION_MODE_ENV]: config.permissionMode ?? 'ask',
  } as NodeJS.ProcessEnv
  delete env.AI_AGENT
  delete env.PI_CODING_AGENT
  // A parent shell may set this globally. pi-mcp-adapter gives the variable
  // precedence over its config, which would undo `directTools: false` and
  // recreate overlong provider-facing names.
  delete env.MCP_DIRECT_TOOLS
  return env
}

/**
 * Windows npm launchers need a shell; other platforms run the JS entry point.
 * On macOS, Pi requires installed Node >=22.19 on PATH.
 */
export function piInvocation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv; shell: boolean } {
  if (process.platform === 'win32') {
    return { command: executable, args, env, shell: true }
  }
  const runtime = nodeWorkerRuntime(process.platform, process.execPath, env)
  return { command: runtime.execPath, args: [executable, ...args], env: runtime.env, shell: false }
}
