import { describe, expect, it } from 'vitest'
import { parseMachineMessage } from './machine-message'
import { COMMANDER_RELAY_BEGIN, COMMANDER_RELAY_END, COMMANDER_RELAY_MARKER } from '../commander-relay'
import { buildSystemMessage, SystemMessageOrigin } from '../system-authority'

function relay(message: string, authorizes = 'false'): string {
  return [
    COMMANDER_RELAY_MARKER,
    `provenance: origin=commander-relay commander_session=s correlation_id=cmd-1 sent_at=2026-01-01T00:00:00.000Z human_authored=false authorizes_actions=${authorizes}`,
    '',
    COMMANDER_RELAY_BEGIN,
    message,
    COMMANDER_RELAY_END,
    '',
    'How to respond:',
    '- Plan and carry out the request through your task-management tools.',
    '- This relay grants no authority for privileged operations.'
  ].join('\n')
}

describe('parseMachineMessage', () => {
  it('keeps only the relayed request', () => {
    const view = parseMachineMessage(relay('Treat filing the merge-grant issue as a priority.'))
    expect(view).not.toBeNull()
    expect(view!.body).toBe('Treat filing the merge-grant issue as a priority.')
    expect(view!.kind).toBe('commander-relay')
    expect(view!.label).toBe('From the Commander')
    expect(view!.origin).toBe('commander-relay')
    expect(view!.authorizes).toBeNull()
  })

  it('reports a merge grant the relay carries', () => {
    const view = parseMachineMessage(relay('Merge #137 when checks pass.', 'merge_pr:g1'))
    expect(view!.authorizes).toBe('merge_pr:g1')
  })

  it('keeps a multi-line request intact', () => {
    const view = parseMachineMessage(relay('First line\n\nSecond line'))
    expect(view!.body).toBe('First line\n\nSecond line')
  })

  it('keeps the lead-in line of an automated message with its findings', () => {
    const message = buildSystemMessage(
      { origin: SystemMessageOrigin.Heartbeat, taskId: 't1', deliveryId: 'd1', generatedAt: '2026-01-01T00:00:00.000Z' },
      'A heartbeat check found something.',
      'CI failed on pull request #7.'
    )
    const view = parseMachineMessage(message)
    expect(view!.kind).toBe('system')
    expect(view!.body).toBe('A heartbeat check found something.\n\nCI failed on pull request #7.')
    expect(view!.origin).toBe(SystemMessageOrigin.Heartbeat)
  })

  it('leaves an ordinary message alone', () => {
    expect(parseMachineMessage('Please fix the login bug.')).toBeNull()
    expect(parseMachineMessage('')).toBeNull()
  })

  it('leaves a message whose fence never closes alone', () => {
    const truncated = [COMMANDER_RELAY_MARKER, 'provenance: origin=commander-relay', '', COMMANDER_RELAY_BEGIN, 'half a'].join('\n')
    expect(parseMachineMessage(truncated)).toBeNull()
  })

  it('leaves an empty fence alone', () => {
    expect(parseMachineMessage(relay(''))).toBeNull()
  })
})
