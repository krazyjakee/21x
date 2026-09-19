import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NavRail } from './NavRail'
import { NAV_ITEMS, navShortcutDigit } from './nav-items'
import { useUIStore } from '@/stores/ui-store'

vi.mock('@/lib/activity/use-activity', () => ({
  useCommanderActivity: () => ({ state: 'idle' })
}))

afterEach(cleanup)
beforeEach(() => {
  useUIStore.setState({ sidebarView: 'dashboard', activeModal: null })
})

describe('NavRail Settings', () => {
  it('renders Settings last in its own bottom group inside the navigation landmark', () => {
    render(<NavRail />)
    const nav = screen.getByRole('navigation')
    const main = within(nav).getByRole('group', { name: 'Main views' })
    const bottom = within(nav).getByRole('group', { name: 'Settings' })
    const settings = within(bottom).getByRole('button', { name: 'Settings' })

    expect(nav.lastElementChild).toBe(bottom)
    expect(within(nav).getAllByRole('button').at(-1)).toBe(settings)
    expect(within(main).queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(main).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    expect(bottom).toHaveClass('mt-auto', 'shrink-0')
  })

  it('opens the Settings workspace and marks only Settings current', () => {
    render(<NavRail />)
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(settings).not.toHaveAttribute('aria-current')
    fireEvent.click(settings)
    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(settings).toHaveAttribute('aria-current', 'page')
    expect(settings).toHaveClass('bg-primary/12', 'text-primary')
    expect(screen.getByRole('button', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('reflects Settings opened elsewhere and returns to a main view', () => {
    useUIStore.getState().openSettings()
    render(<NavRail />)
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(settings).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(useUIStore.getState()).toMatchObject({ sidebarView: 'tasks', activeModal: null })
    expect(settings).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps natural tab order through all main items followed by Settings with visible focus', () => {
    render(<NavRail />)
    const buttons = within(screen.getByRole('navigation')).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      ...NAV_ITEMS.map((item) => item.label), 'Settings'
    ])
    for (const button of buttons) {
      expect(button.tabIndex).toBe(0)
      expect(button).not.toBeDisabled()
      expect(button).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-inset')
      act(() => button.focus())
      expect(button).toHaveFocus()
    }
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus()
    expect(navShortcutDigit('commander')).toBe(5)
  })

  it('shows the same tooltip outside the scroll container on hover and keyboard focus', () => {
    render(<NavRail />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Dashboard' }))
    let tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Dashboard')
    expect(tooltip.parentElement).toBe(document.body)
    fireEvent.scroll(screen.getByRole('group', { name: 'Main views' }))
    expect(screen.queryByRole('tooltip')).toBeNull()

    const settings = screen.getByRole('button', { name: 'Settings' })
    act(() => settings.focus())
    tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Settings')
    expect(tooltip.parentElement).toBe(document.body)
    fireEvent.keyDown(settings, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
