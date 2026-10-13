import { COMMANDER_ADMIN_TOOLS } from '../../../shared/commander-tools'
import type { ChatToolDefinition } from '../../chat/tools'
import { guardReportAsks } from '../../commander/report-tools'

/** Model-written report text cannot gain project/skill administration. The
 * quiet inbox does not start report turns; this remains a defensive boundary
 * for any explicit integration that prepares one. User tools remain direct. */
export function commanderRoleTools(tools: ChatToolDefinition[], context: {
  trigger: 'user' | 'report'
  remainingReportAsks: () => number
  consumeReportAsk: () => void
}): ChatToolDefinition[] {
  if (context.trigger === 'user') return tools
  return guardReportAsks(tools.filter((tool) => !COMMANDER_ADMIN_TOOLS.has(tool.name)), {
    remaining: context.remainingReportAsks, consume: context.consumeReportAsk
  })
}
