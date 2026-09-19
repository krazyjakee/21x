/**
 * Maps `codex app-server` approval requests (command, file change, permission,
 * MCP elicitation, user input) to 20x's pending-approval shape and back.
 */

import type { JsonRpcRequest } from './shared/json-rpc'
import { asString, isObject } from './codex-app-server-items'

type ApprovalResponseKind = 'execCommand' | 'commandExecution' | 'fileChange' | 'permissions' | 'elicitation' | 'userInput' | 'generic'

export interface PendingApproval {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
  responseKind: ApprovalResponseKind
}

function summarizeApproval(params: Record<string, unknown>, fallback: string): string {
  const command = asString(params.command)
  const reason = asString(params.reason)
  const itemId = asString(params.itemId) || asString(params.callId)
  return [command || fallback, reason, itemId ? `id: ${itemId}` : ''].filter(Boolean).join('\n')
}

function normalizeDecisionName(decision: unknown): string {
  if (typeof decision === 'string') return decision
  if (isObject(decision)) {
    return Object.keys(decision)[0] || 'accept'
  }
  return 'accept'
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case 'accept':
    case 'approved':
      return 'Allow'
    case 'acceptForSession':
    case 'approved_for_session':
      return 'Allow for Session'
    case 'decline':
    case 'denied':
      return 'Deny'
    case 'cancel':
    case 'abort':
      return 'Deny and Stop'
    default:
      return decision
  }
}

function getApprovalResponseKind(method: string): ApprovalResponseKind {
  if (method === 'execCommandApproval') return 'execCommand'
  if (method.includes('commandExecution')) return 'commandExecution'
  if (method.includes('fileChange')) return 'fileChange'
  if (method.includes('permissions')) return 'permissions'
  if (method === 'mcpServer/elicitation/request') return 'elicitation'
  if (method === 'item/tool/requestUserInput') return 'userInput'
  return 'generic'
}

function buildApprovalResponse(responseKind: ApprovalResponseKind, selected: string, approved: boolean): unknown {
  switch (responseKind) {
    case 'execCommand':
      return { decision: approved ? (selected === 'approved_for_session' ? 'approved_for_session' : 'approved') : (selected === 'denied' ? 'denied' : 'abort') }
    case 'commandExecution':
    case 'fileChange':
    case 'permissions':
      return { decision: selected }
    case 'elicitation':
      return approved
        ? { action: 'accept', content: {} }
        : { action: 'decline' }
    case 'userInput':
      return approved
        ? { response: selected }
        : { response: null }
    default:
      return { decision: approved ? selected : 'cancel' }
  }
}

/** The response that approves `method` without asking (permission mode `allow`). */
export function autoApprovalResponse(method: string): unknown {
  const responseKind = getApprovalResponseKind(method)
  return buildApprovalResponse(responseKind, responseKind === 'execCommand' ? 'approved' : 'accept', true)
}

export function buildPendingApproval(request: JsonRpcRequest, params: Record<string, unknown>): PendingApproval {
  const rawDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
  const options = rawDecisions.length > 0
    ? rawDecisions.map((decision) => {
        const optionId = normalizeDecisionName(decision)
        return {
          optionId,
          name: decisionLabel(optionId),
          kind: optionId.includes('accept') || optionId === 'approved' ? 'allow' : 'reject'
        }
      })
    : [
        { optionId: 'accept', name: 'Allow', kind: 'allow' },
        { optionId: 'cancel', name: 'Deny', kind: 'reject' }
      ]

  return {
    requestId: request.id,
    toolCallId: asString(params.approvalId) || asString(params.itemId) || asString(params.callId) || String(request.id),
    question: summarizeApproval(params, request.method),
    options,
    responseKind: getApprovalResponseKind(request.method)
  }
}

/** The wire response for the user's decision on `approval`. */
export function approvalDecisionResponse(approval: PendingApproval, approved: boolean, optionId?: string): unknown {
  const selected = optionId || approval.options.find((option) =>
    approved
      ? ['acceptForSession', 'accept', 'approved_for_session', 'approved'].includes(option.optionId)
      : ['cancel', 'abort', 'decline', 'denied'].includes(option.optionId)
  )?.optionId || (approved ? 'accept' : 'cancel')
  return buildApprovalResponse(approval.responseKind, selected, approved)
}
