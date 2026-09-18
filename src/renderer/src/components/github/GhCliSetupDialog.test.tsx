import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { Mock } from 'vitest'
import { GhCliSetupDialog } from './GhCliSetupDialog'
import { useSettingsStore } from '@/stores/settings-store'

const checkCli = window.electronAPI.github.checkCli as unknown as Mock

describe('GhCliSetupDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ ghCliStatus: null })
  })

  it('shows install and login commands when gh is missing', async () => {
    checkCli.mockResolvedValue({ installed: false, authenticated: false })
    render(<GhCliSetupDialog open onOpenChange={vi.fn()} onComplete={vi.fn()} />)

    expect(await screen.findByText('gh auth login')).toBeInTheDocument()
    expect(screen.getByText(/Install it, sign in from your terminal/)).toBeInTheDocument()
    expect(screen.queryByText('Continue')).not.toBeInTheDocument()
  })

  it('shows only the login command when gh is installed but unauthenticated', async () => {
    checkCli.mockResolvedValue({ installed: true, authenticated: false })
    render(<GhCliSetupDialog open onOpenChange={vi.fn()} onComplete={vi.fn()} />)

    expect(await screen.findByText(/installed but not signed in/)).toBeInTheDocument()
    expect(screen.getByText('gh auth login')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /authenticate/i })).not.toBeInTheDocument()
  })

  it('re-checks status and continues once gh is authenticated', async () => {
    checkCli.mockResolvedValue({ installed: true, authenticated: false })
    const onComplete = vi.fn()
    render(<GhCliSetupDialog open onOpenChange={vi.fn()} onComplete={onComplete} />)

    await screen.findByText('gh auth login')
    checkCli.mockResolvedValue({ installed: true, authenticated: true, username: 'octocat' })
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))

    await waitFor(() => expect(screen.getByText('Using gh CLI as octocat')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onComplete).toHaveBeenCalled()
  })
})
