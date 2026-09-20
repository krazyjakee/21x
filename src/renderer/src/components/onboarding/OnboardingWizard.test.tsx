import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  OnboardingWizard,
  shouldShowOnboarding,
  isForceOnboarding,
  pickFreeModel,
  getAvailableBackends,
  resolveDefaultBackend,
  FALLBACK_BACKEND
} from './OnboardingWizard'
import { CodingAgentType } from '@/types'
import type { ToolStatus } from '@/types/electron'

// Access mock electronAPI from test/setup-renderer.ts
const mockAgentInstaller = window.electronAPI.agentInstaller as unknown as {
  detect: Mock
  install: Mock
  onProgress: Mock
}

const mockAgents = window.electronAPI.agents as unknown as {
  getAll: Mock
  create: Mock
  update: Mock
}

const mockSettings = window.electronAPI.settings as unknown as {
  get: Mock
  set: Mock
  getAll: Mock
}

const mockAgentConfig = window.electronAPI.agentConfig as unknown as {
  getProviders: Mock
}

const NOT_INSTALLED: ToolStatus = { installed: false, version: null }

/** Detection snapshot with only the named backends installed. */
function detection(installed: Record<string, ToolStatus> = {}): Record<string, ToolStatus> {
  return {
    nodejs: { installed: true, version: '20.0.0' },
    npm: { installed: true, version: '10.0.0' },
    git: { installed: true, version: '2.40.0' },
    rtk: { installed: false, version: null, configured: false },
    claudeCode: NOT_INSTALLED,
    opencode: NOT_INSTALLED,
    codex: NOT_INSTALLED,
    cursor: NOT_INSTALLED,
    pi: { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' },
    ...installed
  }
}

/** Radix Dialog may render duplicate nodes — read the last card for a backend. */
function backendCard(type: CodingAgentType): HTMLElement {
  const cards = screen.getAllByTestId(`backend-card-${type}`)
  return cards[cards.length - 1]
}

describe('pickFreeModel', () => {
  it.each([
    ['array model ID', [{ id: 'kimi-k2.5-free', name: 'Kimi K2.5' }], 'opencode/kimi-k2.5-free'],
    ['object-map key', { 'kimi-k2.5-free': { name: 'Kimi K2.5' } }, 'opencode/kimi-k2.5-free'],
    ['explicit object-map ID', { alias: { id: 'model-free' } }, 'opencode/model-free'],
    ['display name', [{ id: 'model-1', name: 'Community Free Model' }], 'opencode/model-1']
  ])('detects a free model from its %s', (_, models, expected) => {
    expect(pickFreeModel('opencode', models)).toBe(expected)
  })

  it('returns null when no free model exists', () => {
    expect(pickFreeModel('opencode', { 'paid-model': { name: 'Paid Model' } })).toBeNull()
  })
})

describe('backend discovery helpers', () => {
  it('lists every detected backend, in card order, with no single-selection limit', () => {
    const status = detection({
      claudeCode: { installed: true, version: '1.0.0' },
      codex: { installed: true, version: '0.4.0' },
      opencode: { installed: true, version: '0.6.0' },
      pi: { installed: true, version: '0.79.0', supported: false, reason: 'too old' }
    })
    expect(getAvailableBackends(status)).toEqual([
      CodingAgentType.CLAUDE_CODE,
      CodingAgentType.OPENCODE,
      CodingAgentType.CODEX
    ])
    expect(getAvailableBackends(null)).toEqual([])
  })

  it('derives the default backend from what is installed, else OpenCode', () => {
    expect(resolveDefaultBackend(detection({ codex: { installed: true, version: '0.4.0' } }), null))
      .toBe(CodingAgentType.CODEX)
    expect(resolveDefaultBackend(detection(), null)).toBe(FALLBACK_BACKEND)
    expect(resolveDefaultBackend(null, null)).toBe(CodingAgentType.OPENCODE)
  })

  it('honours an explicit default choice over detection order', () => {
    const status = detection({
      claudeCode: { installed: true, version: '1.0.0' },
      codex: { installed: true, version: '0.4.0' }
    })
    expect(resolveDefaultBackend(status, CodingAgentType.CODEX)).toBe(CodingAgentType.CODEX)
  })
})

describe('shouldShowOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('should return true when no completed version exists', () => {
    expect(shouldShowOnboarding(null, '1.0.0')).toBe(true)
    expect(shouldShowOnboarding(undefined, '1.0.0')).toBe(true)
  })

  it('should return false when major.minor matches', () => {
    expect(shouldShowOnboarding('1.2.0', '1.2.5')).toBe(false)
  })

  it('should return true when major version changes', () => {
    expect(shouldShowOnboarding('1.2.0', '2.2.0')).toBe(true)
  })

  it('should return true when minor version changes', () => {
    expect(shouldShowOnboarding('1.2.0', '1.3.0')).toBe(true)
  })

  it('should return true when force-onboarding flag is set', () => {
    localStorage.setItem('force-onboarding', 'true')
    expect(shouldShowOnboarding('1.2.0', '1.2.0')).toBe(true)
  })

  it('should return true when debug:onboarding flag is set', () => {
    localStorage.setItem('debug:onboarding', 'true')
    expect(shouldShowOnboarding('1.2.0', '1.2.0')).toBe(true)
  })
})

describe('isForceOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('should return false by default', () => {
    expect(isForceOnboarding()).toBe(false)
  })

  it('should return true when force-onboarding is set', () => {
    localStorage.setItem('force-onboarding', 'true')
    expect(isForceOnboarding()).toBe(true)
  })

  it('should return true when debug:onboarding is set', () => {
    localStorage.setItem('debug:onboarding', 'true')
    expect(isForceOnboarding()).toBe(true)
  })
})

describe('OnboardingWizard', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    mockAgentInstaller.detect.mockResolvedValue(detection({
      claudeCode: { installed: true, version: '1.0.0' },
      codex: { installed: true, version: '0.4.0' }
    }))
    mockAgentInstaller.install.mockResolvedValue({
      success: true,
      error: null,
      newStatus: detection({
        claudeCode: { installed: true, version: '1.0.0' },
        codex: { installed: true, version: '0.4.0' },
        pi: { installed: true, version: '0.84.3', supported: true, reason: null }
      })
    })
    mockAgentInstaller.onProgress.mockImplementation(() => vi.fn())
    mockAgents.getAll.mockResolvedValue([])
    mockAgents.create.mockResolvedValue({ id: 'a1' })
    mockAgentConfig.getProviders.mockResolvedValue(null)
    mockSettings.getAll.mockResolvedValue({})
  })

  it('should not render when open is false', () => {
    render(<OnboardingWizard open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByText('Welcome to 21x')).not.toBeInTheDocument()
  })

  it('should render welcome title when open', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    // Radix Dialog may render duplicate nodes
    expect(screen.getAllByText('Welcome to 21x').length).toBeGreaterThan(0)
  })

  it('offers only local agents, with no hosted-service option', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    expect(screen.queryByText('Peakflo')).not.toBeInTheDocument()
    expect(screen.queryByText(/Managed agents/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Sign up|Log in|Cloud/i)).not.toBeInTheDocument()
  })

  it('should display every supported backend, including Cursor', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    for (const type of Object.values(CodingAgentType)) {
      expect(screen.getAllByTestId(`backend-card-${type}`).length).toBeGreaterThan(0)
    }
  })

  it('should detect tools on mount', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mockAgentInstaller.detect).toHaveBeenCalled()
    })
  })

  it('marks every detected backend as available without any selection', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(backendCard(CodingAgentType.CLAUDE_CODE)).toHaveAttribute('data-available', 'true')
      expect(backendCard(CodingAgentType.CODEX)).toHaveAttribute('data-available', 'true')
    })
    expect(backendCard(CodingAgentType.OPENCODE)).toHaveAttribute('data-available', 'false')
    expect(backendCard(CodingAgentType.CURSOR)).toHaveAttribute('data-available', 'false')
    expect(backendCard(CodingAgentType.PI)).toHaveAttribute('data-available', 'false')

    const summaries = screen.getAllByTestId('backend-summary')
    expect(summaries[summaries.length - 1]).toHaveTextContent('Claude Code, Codex')

    // No radio group / single-agent selection gate
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('keeps per-backend health details visible without gating', async () => {
    mockAgentInstaller.detect.mockResolvedValue(detection({
      pi: { installed: true, version: '0.79.0', supported: false, reason: 'Pi 0.79.0 is unsupported.' }
    }))
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(backendCard(CodingAgentType.PI)).toHaveTextContent('Update required')
    })
    expect(backendCard(CodingAgentType.PI).querySelector('[title="Pi 0.79.0 is unsupported."]')).not.toBeNull()
    expect(backendCard(CodingAgentType.CURSOR)).toHaveTextContent('Install from cursor.com')
    // Still allowed to continue
    const btns = screen.getAllByRole('button', { name: /get started/i })
    expect(btns.every((b) => !b.hasAttribute('disabled'))).toBe(true)
  })

  it('enables Get Started with no selection and uses the first detected backend as default', async () => {
    const onOpenChange = vi.fn()
    render(<OnboardingWizard open={true} onOpenChange={onOpenChange} />)
    await waitFor(() => expect(backendCard(CodingAgentType.CLAUDE_CODE)).toHaveAttribute('data-available', 'true'))

    const btns = screen.getAllByRole('button', { name: /get started/i })
    expect(btns[0].hasAttribute('disabled')).toBe(false)
    fireEvent.click(btns[0])

    await waitFor(() => {
      expect(mockAgents.create).toHaveBeenCalledWith(expect.objectContaining({
        is_default: true,
        config: expect.objectContaining({
          coding_agent: CodingAgentType.CLAUDE_CODE,
          model: 'claude-fable-5-1'
        })
      }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(mockAgentInstaller.install).not.toHaveBeenCalled()
  })

  it('completes onboarding with no backend installed and explains installing later', async () => {
    mockAgentInstaller.detect.mockResolvedValue(detection())
    const onOpenChange = vi.fn()
    render(<OnboardingWizard open={true} onOpenChange={onOpenChange} />)

    const notices = await screen.findAllByTestId('no-backend-notice')
    expect(notices[notices.length - 1]).toHaveTextContent(/install one later/i)

    fireEvent.click(screen.getAllByRole('button', { name: /get started/i })[0])

    await waitFor(() => {
      expect(mockAgents.create).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ coding_agent: FALLBACK_BACKEND })
      }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    // An absent backend is never asked for its model list
    expect(mockAgentConfig.getProviders).not.toHaveBeenCalled()
    expect(mockAgentInstaller.install).not.toHaveBeenCalled()
  })

  it('lets the default backend be chosen separately from discovery', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => expect(backendCard(CodingAgentType.CODEX)).toHaveAttribute('data-available', 'true'))

    const groups = screen.getAllByRole('group', { name: /default backend/i })
    const group = groups[groups.length - 1]
    const codexChip = Array.from(group.querySelectorAll('button')).find((b) => b.textContent?.includes('Codex'))!
    fireEvent.click(codexChip)
    expect(codexChip).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getAllByRole('button', { name: /get started/i })[0])
    await waitFor(() => {
      expect(mockAgents.create).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ coding_agent: CodingAgentType.CODEX })
      }))
    })
  })

  it('installs a backend from its own card without gating Get Started', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => expect(backendCard(CodingAgentType.PI)).toHaveTextContent('Not installed'))

    fireEvent.click(screen.getAllByRole('button', { name: /install pi/i })[0])

    await waitFor(() => {
      expect(mockAgentInstaller.install).toHaveBeenCalledWith('pi')
      expect(backendCard(CodingAgentType.PI)).toHaveAttribute('data-available', 'true')
    })
    expect(mockAgents.create).not.toHaveBeenCalled()
  })

  it('offers optional RTK installation and backend configuration', async () => {
    mockAgentInstaller.install.mockResolvedValueOnce({
      success: true,
      error: null,
      newStatus: detection({
        claudeCode: { installed: true, version: '1.0.0' },
        rtk: { installed: true, version: '0.49.0', configured: true }
      })
    })
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)

    const rows = await screen.findAllByTestId('rtk-setup')
    expect(rows[rows.length - 1]).toHaveTextContent('RTK output compression')
    fireEvent.click(screen.getAllByRole('button', { name: /set up rtk/i })[0])

    await waitFor(() => {
      expect(mockAgentInstaller.install).toHaveBeenCalledWith('rtk')
      expect(screen.getAllByTestId('rtk-setup').at(-1)).toHaveTextContent('Configured')
    })
  })

  it('re-running detection reflects newly installed and removed backends', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => expect(backendCard(CodingAgentType.CLAUDE_CODE)).toHaveAttribute('data-available', 'true'))
    expect(backendCard(CodingAgentType.OPENCODE)).toHaveAttribute('data-available', 'false')

    // Claude Code removed, OpenCode installed since the first run
    mockAgentInstaller.detect.mockResolvedValue(detection({
      codex: { installed: true, version: '0.4.0' },
      opencode: { installed: true, version: '0.6.0' }
    }))
    fireEvent.click(screen.getAllByRole('button', { name: /re-check installed agents/i })[0])

    await waitFor(() => {
      expect(mockAgentInstaller.detect).toHaveBeenCalledTimes(2)
      expect(backendCard(CodingAgentType.OPENCODE)).toHaveAttribute('data-available', 'true')
      expect(backendCard(CodingAgentType.CLAUDE_CODE)).toHaveAttribute('data-available', 'false')
    })
  })

  it('should call onOpenChange(false) when Skip is clicked', () => {
    const onOpenChange = vi.fn()
    render(<OnboardingWizard open={true} onOpenChange={onOpenChange} />)
    const skipBtns = screen.getAllByRole('button', { name: /skip/i })
    fireEvent.click(skipBtns[0])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('should always show git provider options', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getAllByText(/Where are your repos/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0)
      expect(screen.getAllByText('GitLab').length).toBeGreaterThan(0)
    })
  })

  it('should show agent taglines', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Open-source, free models').length).toBeGreaterThan(0)
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0)
  })
})
