import { describe, expect, it } from 'vitest'
import { buildCommanderRelayMessage } from './project-tools'
import { parseMachineMessage } from '../../shared/transcript/machine-message'
import { relayFixture } from '../../shared/transcript/machine-message-fixtures'

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
  it('never carries a grant reference', () => {
    expect(buildCommanderRelayMessage(input)).toContain('authorizes_actions=false')
    expect(buildCommanderRelayMessage(input)).not.toMatch(/merge grant/i)
  })
})
