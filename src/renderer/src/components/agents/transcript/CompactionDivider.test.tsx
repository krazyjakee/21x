import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MessageBubble } from './MessageBubble'

afterEach(cleanup)
describe('compaction transcript divider', () => {
  it('shows the scoped observation as a divider without actions, approvals or speech', () => {
    const { getByRole, getByText, queryByRole } = render(<MessageBubble message={{
      id: 'compaction:native', role: 'system', partType: 'compaction', timestamp: new Date(10),
      content: 'The agent condensed earlier conversation. It is continuing in the same session.'
    }} />)
    expect(getByRole('separator', { name: 'Conversation context compacted' })).toBeTruthy()
    expect(getByText('Context compacted')).toBeTruthy()
    expect(getByText(/continuing in the same session/)).toBeTruthy()
    expect(queryByRole('button')).toBeNull()
  })
})
