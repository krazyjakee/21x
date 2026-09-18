import type { CodingAgentAdapter } from '../adapters/coding-agent-adapter'

export type RunningTool = Awaited<ReturnType<NonNullable<CodingAgentAdapter['getRunningTools']>>>[number]

/** Maximum time a session can stay BUSY with no new data before it is aborted.
 *  Prevents sessions from being stuck indefinitely when a tool call hangs inside
 *  the agent process (20x is just a spectator on the HTTP prompt call). */
export const STUCK_SESSION_TIMEOUT_MS = 5 * 60 * 1000

/** Fast inactivity deadline for known local read operations. These should
 *  complete quickly; a blocked cross-workspace read should recover without
 *  waiting for the longer active-tool deadline. */
const STUCK_TOOL_TIMEOUT_MS = 90 * 1000

/** Long-running tools can legitimately remain quiet while an external
 *  command works, so they get a separate, much longer inactivity deadline. */
const ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

/** Tools that delegate work to subagents or block on subtask progress. These
 *  are long-running BY DESIGN (a coordinator waiting on child agents can
 *  legitimately produce no output for many minutes), so they are exempt from
 *  the stuck-tool and stuck-session watchdogs. Aborting a session mid-delegation
 *  cascades into the child work (server-side aborts kill child sessions;
 *  in-process subagents die with the parent query), which is never what the
 *  user wants when the children are still making progress. */
const DELEGATION_TOOL_NAMES = new Set(['task', 'agent', 'subagent'])
const DELEGATION_TOOL_SUBSTRINGS = ['wait_for_subtasks', 'start_task']

// Tool-call markup some models hallucinate as plain text.
const GARBLED_OUTPUT_PATTERNS = ['<｜DSML｜', '<│DSML│', 'DSML｜tool_calls', 'DSML｜invoke']

export function isDelegationTool(toolName?: string): boolean {
  if (!toolName) return false
  const name = toolName.toLowerCase()
  if (DELEGATION_TOOL_NAMES.has(name)) return true
  return DELEGATION_TOOL_SUBSTRINGS.some((s) => name.includes(s))
}

export function hasGarbledOutput(parts: Array<{ content?: string; text?: string }>): boolean {
  return parts.some((part) => {
    const text = part.content || part.text || ''
    return text.length > 50 && GARBLED_OUTPUT_PATTERNS.some(p => text.includes(p))
  })
}

/**
 * Describes the first non-delegation tool past its inactivity deadline, or
 * returns null. Known fast reads get STUCK_TOOL_TIMEOUT_MS; everything else
 * gets ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS. Total runtime alone is not a hang
 * signal: test and CI watchers can legitimately stream output for minutes.
 */
export function findStuckTool(runningTools: RunningTool[], workspaceDir?: string): string | null {
  const now = Date.now()
  const monotonicNow = performance.now()
  for (const tool of runningTools) {
    if (!tool.startTime) continue
    if (isDelegationTool(tool.toolName)) continue
    const elapsed = now - tool.startTime
    const inactiveFor = tool.lastActivityMonotonicTime !== undefined
      ? monotonicNow - tool.lastActivityMonotonicTime
      : now - (tool.lastActivityTime ?? tool.startTime)
    const normalizedToolName = tool.toolName.toLowerCase().replace(/[^a-z]/g, '')
    const timeout = normalizedToolName === 'read' || normalizedToolName === 'readfile'
      ? STUCK_TOOL_TIMEOUT_MS
      : ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS
    if (inactiveFor <= timeout) continue

    const filePath = tool.input?.filePath as string | undefined
    if (filePath && workspaceDir && !filePath.startsWith(workspaceDir)) {
      return `Tool "${tool.toolName}" stuck trying to access file outside workspace: ${filePath}`
    }
    return `Tool "${tool.toolName}" has been running for ${Math.round(elapsed / 1000)}s with no activity for ${Math.round(inactiveFor / 1000)}s`
  }
  return null
}

/**
 * True when a BUSY session is really waiting for the user: OpenCode's
 * question.list() check can fail silently, so getStatus() reports BUSY instead
 * of WAITING_APPROVAL. Signals: the previous status, a question/permission tool
 * in this batch, or a pending approval held by the adapter.
 */
export function isWaitingForUserInput(
  previousStatus: string,
  batchMessages: Array<{ tool?: unknown }>,
  adapter: CodingAgentAdapter,
  sessionId: string
): boolean {
  if (previousStatus === 'waiting_approval') return true
  const hasQuestion = batchMessages.some((msg) => {
    const tool = msg.tool as { name?: string } | undefined
    return tool?.name === 'question' || tool?.name === 'permission'
  })
  if (hasQuestion) return true
  const approvals = adapter as unknown as { getPendingApproval?: (sid: string) => unknown }
  return typeof approvals.getPendingApproval === 'function' && !!approvals.getPendingApproval(sessionId)
}
