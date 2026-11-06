import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onWorkspaceCleanupProgress } from '@/lib/ipc-client'
import { WorkspaceCleanupSection } from './WorkspaceCleanupSection'

vi.mock('@/lib/ipc-client', () => ({
  settingsApi: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
  worktreeApi: { runCleanupNow: vi.fn() },
  onWorkspaceCleanupProgress: vi.fn(() => () => {})
}))

type Progress = Parameters<NonNullable<Parameters<typeof onWorkspaceCleanupProgress>[0]>>[0]
const finish = (event: Partial<Progress>): void => {
  const listener = vi.mocked(onWorkspaceCleanupProgress).mock.calls.at(-1)![0]
  act(() => listener({ phase: 'done', current: 0, total: 0, errors: [], ...event }))
}

describe('the Run cleanup result', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    render(<WorkspaceCleanupSection />)
    await act(async () => {})
  })

  it('says workspaces were kept, and why', () => {
    finish({ workspacesKept: 3 })
    expect(screen.getByText(/Kept 3 workspaces: the Tauri version of 21x shares this folder/)).toBeTruthy()
  })
  it('keeps the rest of the outcome beside it', () => {
    finish({ cleaned: 1, nodeModulesCleaned: 2, workspacesKept: 1 })
    expect(screen.getByText(/Cleaned 1 workspace, pruned 2 idle node_modules\. Kept 1 workspace:/)).toBeTruthy()
  })
  it('reads as it always did when nothing was kept', () => {
    finish({})
    expect(screen.getByText('No workspaces to clean')).toBeTruthy()
  })
})
