import type { ChatToolDefinition } from '../chat/tools'
import type { DatabaseManager } from '../database'
import { createMergeGrantFromUserMessage, mergeGrantSummary, revokeMergeGrant } from '../merge-grants'
import { describeMergeGrant, type MergeGrant, type MergeGrantScopeInput } from '../../shared/merge-grants'
import type { ProjectRecord } from '../../shared/projects'
import { projectLocatorSchema, resolveProject, result, type ProjectToolContext } from './project-tools'

/**
 * The Commander's side of merge grants (#137). Kept apart from
 * project-tools.ts, which only gains the `merge_grant` option of
 * `ask_captain` and a call to {@link grantForRelay}.
 *
 * The Commander may *propose* a grant, but it only exists when the app can
 * bind it to the user's message of this turn: its stored id and verbatim
 * text come from the turn context the app built, never from the model's
 * input. A turn a Captain report started has no user message, so it can
 * create nothing.
 */

const MAX_GRANT_ITEMS = 30

/** The `merge_grant` option of `ask_captain`: only the scope comes from the model. */
export const mergeGrantInputSchema = {
  type: 'object',
  description:
    'Only when the user explicitly told you, in this message, to merge pull requests in this project (they must say "merge"; "ship it" or "land it" do not count). ' +
    '21x binds the grant to the user\'s message and refuses otherwise. One project per grant; it lasts at most 7 days and the user can revoke it.',
  properties: {
    repo: { type: 'string', description: 'owner/name; omit for all of the project\'s GitHub repos.' },
    base_branch: { type: 'string', description: 'Only PRs into this branch.' },
    pr_numbers: { type: 'array', items: { type: 'integer' }, description: 'Only these PRs. When the user named PRs, the grant is limited to those.' },
    expires_in_hours: { type: 'number', description: 'Default and maximum 168 (7 days).' },
    max_merges: { type: 'integer', description: 'At most this many merges.' }
  },
  additionalProperties: false
} as const

function scopeInput(value: unknown): MergeGrantScopeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('merge_grant must be an object')
  const input = value as Record<string, unknown>
  return {
    repo: typeof input.repo === 'string' ? input.repo : undefined,
    base_branch: typeof input.base_branch === 'string' ? input.base_branch : undefined,
    pr_numbers: Array.isArray(input.pr_numbers) ? (input.pr_numbers as number[]) : undefined,
    expires_in_hours: typeof input.expires_in_hours === 'number' ? input.expires_in_hours : undefined,
    max_merges: typeof input.max_merges === 'number' ? input.max_merges : undefined
  }
}

/**
 * Creates the grant an `ask_captain` call proposes, bound to this turn's user
 * message. Throws (so the relay is not sent) when it cannot be created: the
 * Commander must then tell the user why instead of relaying a merge request
 * the Captain could not act on.
 */
export function grantForRelay(db: DatabaseManager, context: ProjectToolContext, project: ProjectRecord, value: unknown): MergeGrant {
  const scope = scopeInput(value)
  if (context.trigger === 'report' || !context.userMessageId || !context.userMessage.trim()) {
    throw new Error('A merge grant needs a message the user typed in this turn. Nothing was sent; ask the user.')
  }
  const created = createMergeGrantFromUserMessage(db, project.id, {
    source: 'commander',
    sessionId: context.sessionId,
    messageId: context.userMessageId,
    text: context.userMessage
  }, scope)
  if (!created.ok) throw new Error(`No merge grant was created and nothing was sent: ${created.error}`)
  return created.grant
}

/** The lines a relay carries for a verified grant. */
export function relayGrantLines(grant: MergeGrant): string[] {
  return [
    `Merge grant ${grant.id}, verified by 21x: the user typed the instruction below. ${describeMergeGrant(grant)}.`,
    `The user's words (verbatim): "${grant.user_text.replace(/\s+/g, ' ').slice(0, 1_000)}"`,
    'Use merge_pull_request for covered PRs; 21x checks the grant, the checks and branch protection itself.'
  ]
}

export interface MergeGrantToolOptions {
  db: DatabaseManager
  context: ProjectToolContext
}

/** `list_merge_grants` and `revoke_merge_grant`. Revoking only ever narrows authority, so it needs no confirmation. */
export function createCommanderMergeGrantTools(options: MergeGrantToolOptions): ChatToolDefinition[] {
  const { db } = options
  return [
    {
      name: 'list_merge_grants',
      description: 'Merge grants the user gave to Captains: what each allows, the user\'s words, uses and expiry. Active ones unless include_inactive.',
      inputSchema: {
        type: 'object',
        properties: { ...projectLocatorSchema, include_inactive: { type: 'boolean' } },
        additionalProperties: false
      },
      handler: async (input) => {
        const project = input.project === undefined ? null : resolveProject(db, input.project)
        const grants = db.listMergeGrants({ projectId: project?.id, activeOnly: input.include_inactive !== true })
        const items = grants.slice(0, MAX_GRANT_ITEMS).map(mergeGrantSummary)
        return result({ grants: items, total: grants.length, truncated: grants.length > items.length })
      }
    },
    {
      name: 'revoke_merge_grant',
      description: 'Revoke a merge grant at once, when the user asks. The Captain can no longer merge under it.',
      inputSchema: {
        type: 'object',
        properties: { grant_id: { type: 'string' } },
        required: ['grant_id'],
        additionalProperties: false
      },
      handler: async (input) => {
        if (typeof input.grant_id !== 'string' || !input.grant_id.trim()) throw new Error('grant_id is required')
        const revoked = revokeMergeGrant(db, input.grant_id.trim(), { by: 'commander' })
        if (!revoked.ok) throw new Error(revoked.error ?? 'Could not revoke the grant')
        return result({ status: 'revoked', grant_id: input.grant_id.trim() })
      }
    }
  ]
}
