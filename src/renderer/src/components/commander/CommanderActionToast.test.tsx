import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { CommanderMessage } from '@shared/commander'
import { activityNow } from '@/lib/activity/activity-clock'
import { useCommanderStore } from '@/stores/commander-store'
import { __resetCommanderCall, useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useUIStore } from '@/stores/ui-store'
import { CommanderActionToast } from './CommanderActionToast'

const call = { id: 'archive-1', name: 'archive_project', input: {} }
type Change = { field: string; before: unknown; after: unknown }
function result(changes: Change[]): CommanderMessage {
  return { id: 'live:t1:archive-1', session_id: 's1', role: 'tool', content: JSON.stringify({ status: 'ok', target: { kind: 'project', id: 'web', name: 'Web' }, changes, undoId: 'undo-1' }),
    tool_calls: null, tool_call_id: 'archive-1', tool_name: 'archive_project', is_error: false, project_id: null, correlation_id: null, created_at: 1 }
}
const showToast = (changes: Change[] = [{ field: 'archived', before: false, after: true }]) =>
  useCommanderStore.setState({ selectedSessionId: 's1', recentAction: { call, result: result(changes), observedAt: activityNow() } })

beforeEach(() => {
  __resetCommanderCall()
  useCommanderCallUiStore.setState({ corner: 'bottom-right', pipRequested: false })
  useUIStore.setState({ sidebarView: 'commander' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useCommanderStore.setState({ recentAction: null, selectedSessionId: null })
})

describe('the action toast', () => {
  it('says what Undo reverses, and sends a long list to Actions', () => {
    showToast([0, 1, 2, 3, 4].map(index => ({ field: `field-${index}`, before: 'old', after: 'new' })))
    render(<CommanderActionToast />)
    expect(screen.getByText(/Web/)).toBeTruthy()
    expect(screen.getByText('field-2:')).toBeTruthy()
    expect(screen.queryByText('field-3:')).toBeNull()
    expect(screen.getByText('2 more in Actions')).toBeTruthy()
  })
  it('sits clear of the floating call, however tall the tile has grown', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect)
    useCommanderCallStore.setState({ status: 'live', sessionId: 's1' })
    useUIStore.setState({ sidebarView: 'tasks' })
    showToast()
    render(<><section data-testid="commander-pip" /><CommanderActionToast /></>)
    expect(screen.getByTestId('commander-action-toast').style.getPropertyValue('--commander-toast-offset')).toBe('144px')
  })
  it('keeps the default place in the full view, where there is no tile', () => {
    showToast()
    render(<CommanderActionToast />)
    expect(screen.getByTestId('commander-action-toast').style.getPropertyValue('--commander-toast-offset')).toBe('')
  })
})
