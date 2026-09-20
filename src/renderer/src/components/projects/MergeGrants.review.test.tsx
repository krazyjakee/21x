import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HeldActionsNotice } from './HeldActionsNotice'
import { MergeGrantsSection } from './MergeGrantsSection'
import { mergeGrantsApi, escalationApi } from '@/lib/ipc-client'
import type { MergeGrant } from '@shared/merge-grants'

vi.mock('@/lib/ipc-client', () => ({
  mergeGrantsApi: { listActive: vi.fn(), audit: vi.fn(), revoke: vi.fn(), onChanged: vi.fn(() => () => {}) },
  escalationApi: { listHeld: vi.fn(), onHeldChanged: vi.fn(() => () => {}) }
}))
vi.mock('@/stores/project-store', () => ({ useProjectStore: (select: (s: unknown) => unknown) => select({ projects: [{ id: 'p', name: 'App' }] }) }))

const grant: MergeGrant = {
  id: 'g', project_id: 'p', action: 'merge_pr', condition: 'checks_green_and_protection_satisfied',
  repo: 'acme/app', base_branch: 'main', pr_numbers: [12], source: 'project_chat', source_session_id: 'captain', source_message_id: 'pc-1',
  user_text: 'merge PR #12', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
  max_uses: 1, uses: 0, last_used_at: null, revoked_at: null, revoked_by: null
}

beforeEach(() => {
  vi.mocked(mergeGrantsApi.listActive).mockResolvedValue([grant])
  vi.mocked(mergeGrantsApi.audit).mockResolvedValue([{ grant, status: 'active', uses: [] }])
  vi.mocked(escalationApi.listHeld).mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('merge-grant controls', () => {
  it('focuses the approvals dialog, returns focus on Escape, and retains grants when revoke fails', async () => {
    vi.mocked(mergeGrantsApi.revoke).mockResolvedValue({ ok: false, error: 'Database unavailable' })
    render(<HeldActionsNotice />)
    const trigger = await screen.findByRole('button', { name: '1 active merge grant' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Captain approvals and merge grants' })
    expect(dialog).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /^Revoke merge grant/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable')
    expect(screen.getByRole('button', { name: /^Revoke merge grant/ })).toBeEnabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('revokes in one click after a successful response', async () => {
    vi.mocked(mergeGrantsApi.revoke).mockResolvedValue({ ok: true })
    render(<HeldActionsNotice />)
    fireEvent.click(await screen.findByRole('button', { name: '1 active merge grant' }))
    fireEvent.click(screen.getByRole('button', { name: /^Revoke merge grant/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mergeGrantsApi.revoke).toHaveBeenCalledExactlyOnceWith('g')
  })

  it('labels the project switch and reports a failed revoke without hiding its audit entry', async () => {
    vi.mocked(mergeGrantsApi.revoke).mockRejectedValue(new Error('Disconnected'))
    const onEnabledChange = vi.fn()
    render(<MergeGrantsSection projectId="p" settings={{ merge_grants: { enabled: true } }} onEnabledChange={onEnabledChange} />)
    const toggle = screen.getByRole('checkbox', { name: 'Allow merge grants for this project' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(onEnabledChange).toHaveBeenCalledWith(false)
    fireEvent.click(await screen.findByRole('button', { name: /^Revoke merge grant/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected')
    expect(screen.getByRole('list', { name: 'Merge grant audit log' })).toHaveTextContent('merge PR #12')
  })
})
