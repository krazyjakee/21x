import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RtkSetting } from './RtkSetting'

const mockSettings = window.electronAPI.settings as unknown as { get: Mock; set: Mock }
const mockInstaller = window.electronAPI.agentInstaller as unknown as { detect: Mock; install: Mock }

const installed = { installed: true, version: '1.0.0' }
const missing = { installed: false, version: null }

function detection(rtk: Record<string, unknown>, backends: Record<string, unknown> = {}) {
  return { rtk: { version: '0.49.0', ...rtk }, claudeCode: installed, codex: installed, opencode: missing, cursor: missing, pi: missing, ...backends }
}

function storedPreference(value: string | null) {
  mockSettings.get.mockImplementation(async (key: string) => key === 'rtk_enabled' ? value : null)
}

async function renderLoaded(setupOpen = false) {
  render(<RtkSetting setupOpen={setupOpen} />)
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeDisabled())
}

describe('RtkSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storedPreference(null)
    mockSettings.set.mockResolvedValue(undefined)
    mockInstaller.detect.mockResolvedValue(detection({ installed: true }))
  })

  afterEach(cleanup)

  it('is on by default and says what each backend really gets', async () => {
    await renderLoaded()

    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByTestId('rtk-effective-state')).toHaveTextContent('On')
    const coverage = screen.getByTestId('rtk-coverage')
    expect(coverage).toHaveTextContent('Claude Code: Commands RTK can filter are rewritten')
    expect(coverage).toHaveTextContent('Codex: Instructions only, not enforced')
    expect(coverage).not.toHaveTextContent('OpenCode')
  })

  it('says that agents with secrets run without RTK', async () => {
    await renderLoaded()

    expect(screen.getByTestId('rtk-setting')).toHaveTextContent('Agents with secrets or their own API keys always run without RTK')
  })

  it('does not report On for an RTK that cannot rewrite', async () => {
    mockInstaller.detect.mockResolvedValue(detection({ installed: true, version: '0.20.0' }))
    await renderLoaded()

    expect(screen.getByTestId('rtk-effective-state')).toHaveTextContent('Unsupported version')
    expect(screen.getByTestId('rtk-unsupported')).toHaveTextContent('commands run unchanged')
    expect(screen.queryByTestId('rtk-coverage')).toBeNull()
  })

  it('saves the opt-out and shows it', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(mockSettings.set).toHaveBeenCalledWith('rtk_enabled', 'false'))
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    expect(screen.getByTestId('rtk-effective-state')).toHaveTextContent('Off')
    expect(screen.queryByTestId('rtk-coverage')).toBeNull()
  })

  it('restores a saved opt-out', async () => {
    storedPreference('false')
    await renderLoaded()

    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.getByTestId('rtk-effective-state')).toHaveTextContent('Off')
  })

  it('can be turned back on', async () => {
    storedPreference('false')
    await renderLoaded()

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(mockSettings.set).toHaveBeenCalledWith('rtk_enabled', 'true'))
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
  })

  it('keeps the switch honest when saving fails', async () => {
    mockSettings.set.mockRejectedValue(new Error('offline'))
    await renderLoaded()

    fireEvent.click(screen.getByRole('switch'))

    expect(await screen.findByText('The RTK preference could not be saved.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('does not let an unread preference be overwritten', async () => {
    mockSettings.get.mockRejectedValue(new Error('offline'))
    render(<RtkSetting setupOpen={false} />)

    expect(await screen.findByText('The RTK preference could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.queryByTestId('rtk-effective-state')).toBeNull()
  })

  it('offers to install RTK when it is missing, and reports that commands run unchanged', async () => {
    mockInstaller.detect.mockResolvedValue(detection({ installed: false, version: null }))
    mockInstaller.install.mockResolvedValue({ success: true, error: null, newStatus: detection({ installed: true }) })
    await renderLoaded()

    expect(await screen.findByTestId('rtk-effective-state')).toHaveTextContent('Not installed')
    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByTestId('rtk-setting')).toHaveTextContent('commands run unchanged')

    fireEvent.click(screen.getByRole('button', { name: /install/i }))

    await waitFor(() => expect(mockInstaller.install).toHaveBeenCalledWith('rtk'))
    await waitFor(() => expect(screen.getByTestId('rtk-effective-state')).toHaveTextContent('On'))
  })

  it('shows why an install failed', async () => {
    mockInstaller.detect.mockResolvedValue(detection({ installed: false, version: null }))
    mockInstaller.install.mockResolvedValue({ success: false, error: 'No release for this platform', newStatus: detection({ installed: false }) })
    await renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: /install/i }))

    expect(await screen.findByText('No release for this platform')).toBeInTheDocument()
  })

  it('warns when a global hook outlives the opt-out', async () => {
    storedPreference('false')
    mockInstaller.detect.mockResolvedValue(detection({ installed: true, integrations: { claudeCode: true } }))
    await renderLoaded()

    expect(screen.getByTestId('rtk-global-hooks')).toHaveTextContent('Claude Code')
    expect(screen.getByTestId('rtk-global-hooks')).toHaveTextContent('rtk init -g --uninstall')
  })

  it('does not warn when RTK is on', async () => {
    mockInstaller.detect.mockResolvedValue(detection({ installed: true, integrations: { claudeCode: true } }))
    await renderLoaded()

    expect(screen.queryByTestId('rtk-global-hooks')).toBeNull()
  })

  it('still offers the preference when detection fails', async () => {
    mockInstaller.detect.mockRejectedValue(new Error('offline'))
    await renderLoaded()

    expect(screen.getByText('Could not check whether RTK is installed.')).toBeInTheDocument()
    expect(screen.queryByTestId('rtk-effective-state')).toBeNull()
  })

  it('reloads after the setup dialog closes, because RTK can be installed there', async () => {
    const { rerender } = render(<RtkSetting setupOpen={false} />)
    await waitFor(() => expect(mockInstaller.detect).toHaveBeenCalledTimes(1))

    rerender(<RtkSetting setupOpen={true} />)
    rerender(<RtkSetting setupOpen={false} />)

    await waitFor(() => expect(mockInstaller.detect).toHaveBeenCalledTimes(2))
  })
})
