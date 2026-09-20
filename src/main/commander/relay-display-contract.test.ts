import { describe, expect, it } from 'vitest'
import { buildCommanderRelayMessage } from './project-tools'
import { parseMachineMessage } from '../../shared/transcript/machine-message'
import { relayFixture } from '../../shared/transcript/machine-message-fixtures'
import type { MergeGrant } from '../../shared/merge-grants'
import type { AuthorizationEvidence } from '../authorization'

const input = { commanderSessionId: 'session-1', correlationId: 'cmd-1', sentAt: '2026-01-01T00:00:00.000Z', message: 'Investigate the failing check.' }
describe('relay wire format/display contract', () => {
  it('retains the exact current-main wire bytes and supports the ordinary envelope', () => {
    expect(buildCommanderRelayMessage(input)).toBe(relayFixture())
    expect(parseMachineMessage(buildCommanderRelayMessage(input))?.body).toBe(input.message)
  })
  it('shows the whole current-main authorization chain instead of claiming to verify it', () => {
    const authorization = { status: 'active', nodeId: 'node-1', effectivePermissions: ['issue.create'], origin: { messageId: 'm1', text: 'Create an issue', textHash: 'hash' }, scope: {} } as unknown as AuthorizationEvidence
    const raw = buildCommanderRelayMessage({ ...input, authorization })
    expect(raw).toContain('authorization_chain:node-1')
    expect(raw).toContain('The relay is an interpretation.')
    expect(parseMachineMessage(raw)).toBeNull()
  })
  it('never treats an actual grant reference as authenticated renderer evidence', () => {
    const grant = { id: 'g1', user_text: 'Merge #1 after checks', repo: 'krazyjakee/21x', pr_numbers: [1], expires_at: '2026-01-02T00:00:00.000Z', max_uses: 1, uses: 0 } as unknown as MergeGrant
    const raw = buildCommanderRelayMessage({ ...input, grant })
    expect(raw).toContain('authorizes_actions=merge_pr:g1')
    expect(parseMachineMessage(raw)).toBeNull()
  })
})
