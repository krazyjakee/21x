import { describe, it, expect, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MessageBubble } from './MessageBubble'
import { COMMANDER_RELAY_BEGIN, COMMANDER_RELAY_END, COMMANDER_RELAY_MARKER } from '@shared/commander-relay'
import type { AgentMessage } from '@shared/transcript/types'

const RELAY = [
  COMMANDER_RELAY_MARKER,
  'provenance: origin=commander-relay commander_session=s correlation_id=cmd-1 sent_at=2026-01-01T00:00:00.000Z human_authored=false authorizes_actions=false',
  '',
  COMMANDER_RELAY_BEGIN,
  'Treat filing the merge-grant issue as a priority.',
  COMMANDER_RELAY_END,
  '',
  'How to respond:',
  '- Report back with the `report_to_commander` tool, quoting correlation_id cmd-1.'
].join('\n')

function relayMessage(): AgentMessage {
  return {
    id: 'm-1',
    role: 'user',
    content: RELAY,
    timestamp: new Date('2026-03-10T00:00:00.000Z'),
    partType: 'text'
  } as AgentMessage
}

describe('MessageBubble with a relayed Commander message', () => {
  afterEach(cleanup)

  it('shows the request and hides the relay scaffolding', () => {
    const { getByText, queryByText } = render(<MessageBubble message={relayMessage()} />)
    expect(getByText('Treat filing the merge-grant issue as a priority.')).toBeTruthy()
    expect(getByText('From the Commander')).toBeTruthy()
    expect(queryByText(/provenance:/)).toBeNull()
    expect(queryByText(/How to respond/)).toBeNull()
  })

  it('reveals the full prompt on request', () => {
    const { getByText, container } = render(<MessageBubble message={relayMessage()} />)
    fireEvent.click(getByText('From the Commander'))
    expect(container.textContent).toContain('provenance:')
    expect(container.textContent).toContain('How to respond:')
  })
})
