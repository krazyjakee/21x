import { describe, expect, it } from 'vitest'
import { buildCommanderRelayMessage } from './project-tools'
import { parseMachineMessage } from '../../shared/transcript/machine-message'
import { relayFixture } from '../../shared/transcript/machine-message-fixtures'
import type { MergeGrant } from '../../shared/merge-grants'

const input = { commanderSessionId: 'session-1', correlationId: 'cmd-1', sentAt: '2026-01-01T00:00:00.000Z', message: 'Investigate the failing check.' }
describe('relay wire format/display contract', () => {
  it('retains the exact current-main wire bytes and supports the ordinary envelope', () => {
    expect(buildCommanderRelayMessage(input)).toBe(relayFixture())
    expect(parseMachineMessage(buildCommanderRelayMessage(input))?.body).toBe(input.message)
  })
  it('tells the Captain to carry out the request instead of asking for it again', () => {
    const raw = buildCommanderRelayMessage(input)
    expect(raw).toContain('carries the same authority as the same words typed into this project chat')
    expect(raw).not.toContain('grants no authority')
  })
  it('never treats an actual grant reference as authenticated renderer evidence', () => {
    const grant = { id: 'g1', user_text: 'Merge #1 after checks', repo: 'krazyjakee/21x', pr_numbers: [1], expires_at: '2026-01-02T00:00:00.000Z', max_uses: 1, uses: 0 } as unknown as MergeGrant
    const raw = buildCommanderRelayMessage({ ...input, grant })
    expect(raw).toContain('authorizes_actions=merge_pr:g1')
    expect(parseMachineMessage(raw)).toBeNull()
  })
})
