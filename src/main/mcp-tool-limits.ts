/**
 * Per-agent MCP tool limits.
 *
 * `AgentMcpServerEntry.enabledTools` is set by the agent form, but it used to
 * be read in only one place: `resolveDocumentedMcpServers`, which decides what
 * the tool list in AGENTS.md / CLAUDE.md says. `buildMcpServersForAdapter`,
 * which decides what the session actually receives, dropped it, so an agent
 * limited to two tools was handed all of them and told it had two.
 *
 * Both readers now go through this module so they cannot disagree again.
 */

/** Entry shape stored in `agent.config.mcp_servers`. */
export interface AgentMcpServerEntryLike {
  serverId: string
  /** `undefined` = every tool. An empty array = no tools. */
  enabledTools?: string[]
}

/**
 * The limit for one server. `undefined` means unrestricted; `[]` means no
 * tools at all. The agent form never saves `[]` (removing the last tool
 * unchecks the server), so treating it as "none" fails closed without
 * affecting any configuration the UI can produce.
 */
export type ServerToolLimit = string[] | undefined

/** Keep only non-empty strings, dropping duplicates and preserving order. */
function cleanToolNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry)
  }
  return [...seen]
}

/**
 * Read `{ serverId -> limit }` out of an agent's `config.mcp_servers`.
 *
 * Never throws: the config is untyped JSON written by several app versions.
 * A malformed `enabledTools` value is treated as no tools rather than all
 * tools, so a corrupt entry cannot widen access.
 */
export function readServerToolLimits(
  entries: Array<string | AgentMcpServerEntryLike> | undefined | null
): Map<string, ServerToolLimit> {
  const limits = new Map<string, ServerToolLimit>()
  if (!Array.isArray(entries)) return limits

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.length > 0 && !limits.has(entry)) limits.set(entry, undefined)
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const serverId = (entry as AgentMcpServerEntryLike).serverId
    if (typeof serverId !== 'string' || serverId.length === 0) continue
    const raw = (entry as AgentMcpServerEntryLike).enabledTools
    limits.set(serverId, raw === undefined ? undefined : (cleanToolNames(raw) ?? []))
  }

  return limits
}

/**
 * The tools an agent may use from one server: `server.tools ∩ enabledTools`.
 *
 * The intersection, not the configured list, so a stale name cannot resurrect
 * a tool the server no longer exposes. An absent limit means every tool the
 * server advertises.
 */
export function resolveAllowedToolNames(params: {
  serverTools: Array<{ name: string }> | undefined
  limit: ServerToolLimit
}): string[] {
  const advertised = (params.serverTools ?? []).map((tool) => tool.name).filter(Boolean)
  const { limit } = params
  if (limit === undefined) return advertised
  const allowed = new Set(limit)
  return advertised.filter((name) => allowed.has(name))
}

/**
 * The advertised tools an agent may NOT use from one server. Empty for an
 * unrestricted server.
 */
export function resolveDisallowedToolNames(params: {
  serverTools: Array<{ name: string }> | undefined
  limit: ServerToolLimit
}): string[] {
  if (params.limit === undefined) return []
  const allowed = new Set(resolveAllowedToolNames(params))
  return (params.serverTools ?? [])
    .map((tool) => tool.name)
    .filter((name) => Boolean(name) && !allowed.has(name))
}

/**
 * Claude Code and OpenCode both replace every character outside
 * `[a-zA-Z0-9_-]` with `_` when they build an MCP tool id. A deny rule written
 * with the raw server name ("My Server") would match nothing.
 */
export function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** The prefix of every Claude Code tool id for one MCP server: `mcp__<server>__`. */
export function claudeServerPrefix(serverName: string): string {
  return `mcp__${normalizeMcpName(serverName)}__`
}

/**
 * The ids Claude Code may use for an MCP tool. The server name is always
 * normalized; the tool name is normalized in some Claude Code versions and not
 * in others, so both forms are returned (they are the same for ordinary names).
 */
export function claudeToolIds(serverName: string, toolName: string): string[] {
  const prefix = claudeServerPrefix(serverName)
  return [...new Set([`${prefix}${toolName}`, `${prefix}${normalizeMcpName(toolName)}`])]
}

/** The id OpenCode uses for an MCP tool: `<server>_<tool>`. */
export function opencodeToolId(serverName: string, toolName: string): string {
  return `${normalizeMcpName(serverName)}_${normalizeMcpName(toolName)}`
}

/**
 * The per-tool map OpenCode takes on `session.prompt`, which it turns into
 * session permission rules. Only denied tools are listed, as `false`: an allow
 * map would have to enumerate every built-in tool as well. Returns `undefined`
 * when nothing is restricted so unrestricted agents send exactly what they did
 * before.
 */
export function opencodeDisallowedToolMap(
  servers: Record<string, { enabledTools?: string[]; knownTools?: string[] }> | undefined
): Record<string, boolean> | undefined {
  const map: Record<string, boolean> = {}
  for (const [serverName, config] of Object.entries(servers ?? {})) {
    const denied = resolveDisallowedToolNames({
      serverTools: (config.knownTools ?? []).map((name) => ({ name })),
      limit: config.enabledTools
    })
    for (const tool of denied) {
      map[opencodeToolId(serverName, tool)] = false
    }
  }
  return Object.keys(map).length > 0 ? map : undefined
}
