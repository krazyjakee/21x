import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TaskSourceFormDialog } from './TaskSourceFormDialog'
import type { PluginMeta, TaskSource } from '@/types'

afterEach(cleanup)

vi.mock('@/lib/ipc-client', () => ({
  pluginApi: { getDocumentation: vi.fn(() => Promise.resolve(null)) }
}))
vi.mock('@/components/plugins', () => ({ getPluginForm: () => null }))
vi.mock('@/components/plugins/PluginSetupDocumentation', () => ({ PluginSetupDocumentation: () => null }))

const PLUGINS = [
  { id: 'linear', displayName: 'Linear', description: 'Linear issues' },
  { id: 'github-issues', displayName: 'GitHub Issues', description: 'GitHub issues' }
] as unknown as PluginMeta[]

/**
 * Regression for #7 ("New Task Source menu renders but its controls are not
 * clickable"): every control must accept input and the form must submit.
 */
describe('TaskSourceFormDialog interaction', () => {
  it('lets the user pick a plugin, type a name and add the source', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(<TaskSourceFormDialog plugins={PLUGINS} open onClose={onClose} onSubmit={onSubmit} />)

    const plugin = screen.getByLabelText('Plugin') as HTMLSelectElement
    const name = screen.getByLabelText('Name') as HTMLInputElement
    for (const control of [plugin, name]) {
      expect(control.disabled).toBe(false)
      expect(control.closest('[inert]')).toBeNull()
      expect(control.closest('[aria-hidden="true"]')).toBeNull()
    }

    // Add is disabled until the form is valid.
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(plugin, { target: { value: 'github-issues' } })
    expect(plugin.value).toBe('github-issues')
    fireEvent.change(name, { target: { value: 'Work issues' } })
    expect(name.value).toBe('Work issues')

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith({ mcp_server_id: null, name: 'Work issues', plugin_id: 'github-issues', config: {} })
    expect(onClose).toHaveBeenCalled()
  })

  it('reopens an existing source with its values and saves edits', () => {
    const onSubmit = vi.fn()
    const source = { id: 'src-1', name: 'Old name', plugin_id: 'linear', config: { team: 'ENG' } } as unknown as TaskSource
    render(<TaskSourceFormDialog source={source} plugins={PLUGINS} open onClose={vi.fn()} onSubmit={onSubmit} />)

    expect(screen.getByText('Edit Task Source')).toBeDefined()
    const name = screen.getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe('Old name')
    expect((screen.getByLabelText('Plugin') as HTMLSelectElement).value).toBe('linear')

    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({ mcp_server_id: null, name: 'New name', plugin_id: 'linear', config: { team: 'ENG' } })
  })

  it('cancel closes without submitting', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(<TaskSourceFormDialog plugins={PLUGINS} open onClose={onClose} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
