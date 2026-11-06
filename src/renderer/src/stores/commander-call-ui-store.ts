import { create } from 'zustand'
import { readCallChoice, rememberCallChoice } from '@/lib/commander-call/call-preferences'
import { useUIStore } from './ui-store'
import { useCommanderCallStore } from './commander-call-store'
import { useCommanderStore } from './commander-store'

export type CaptionSize = 'small' | 'medium' | 'large'
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
const CAPTION_SIZES: readonly CaptionSize[] = ['small', 'medium', 'large']
const PIP_CORNERS: readonly PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

let returnFocus: HTMLElement | null = null
let returnLabel: string | null = null
let cancelFocusRestore: (() => void) | null = null

interface CallUiState {
  captions: boolean
  captionSize: CaptionSize
  pipRequested: boolean
  corner: PipCorner
  panelOpen: boolean
  notice: { id: number; text: string; assertive: boolean } | null
  setCaptionSize: (size: CaptionSize) => void
  toggleCaptions: () => void
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  setCorner: (corner: PipCorner) => void
  showPip: () => void
  expand: () => void
  announce: (text: string, assertive?: boolean) => void
}

export const useCommanderCallUiStore = create<CallUiState>((set, get) => ({
  captions: readCallChoice('captions', ['on', 'off'], 'on') === 'on',
  captionSize: readCallChoice('caption-size', CAPTION_SIZES, 'medium'),
  pipRequested: false,
  corner: readCallChoice('pip-corner', PIP_CORNERS, 'bottom-right'),
  panelOpen: true, notice: null,
  setCaptionSize: captionSize => { rememberCallChoice('caption-size', captionSize); set({ captionSize }) },
  toggleCaptions: () => { const captions = !get().captions; rememberCallChoice('captions', captions ? 'on' : 'off'); set({ captions }) },
  togglePanel: () => set({ panelOpen: !get().panelOpen }),
  setPanelOpen: panelOpen => set({ panelOpen }),
  setCorner: corner => { rememberCallChoice('pip-corner', corner); set({ corner }) },
  showPip: () => {
    cancelFocusRestore?.()
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    returnLabel = returnFocus?.getAttribute('aria-label') ?? null
    set({ pipRequested: true })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="commander-pip-expand"]')?.focus())
  },
  expand: () => {
    cancelFocusRestore?.()
    set({ pipRequested: false })
    useUIStore.getState().setSidebarView('commander')
    const call = useCommanderCallStore.getState()
    const callSession = call.sessionId ?? call.retrySessionId
    if (callSession && callSession !== useCommanderStore.getState().selectedSessionId) {
      void useCommanderStore.getState().selectSession(callSession)
    }
    // The workspace may be lazy-mounted after navigation. Restore a prior
    // control/field when possible; never send focus to the private voice buffer.
    let observer: MutationObserver | null = null
    let unsubscribe: (() => void) | null = null
    const cancel = () => { observer?.disconnect(); unsubscribe?.(); observer = null; unsubscribe = null; cancelFocusRestore = null }
    const restore = () => {
      const workspace = document.querySelector('.commander-workspace')
      if (useUIStore.getState().sidebarView !== 'commander') { cancel(); return }
      if (!workspace) return
      const eligible = (element: HTMLElement) => !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]')
      const previous = returnFocus?.isConnected && eligible(returnFocus) ? returnFocus : null
      const sameLabel = returnLabel ? [...workspace.querySelectorAll<HTMLElement>('[aria-label]')].find(element => element.getAttribute('aria-label') === returnLabel && eligible(element)) : null
      const target = previous ?? sameLabel ?? [...workspace.querySelectorAll<HTMLElement>('[aria-label="Mute microphone"], [aria-label="Unmute microphone"], [aria-label="Turn voice mode on"]')].find(eligible)
      target?.focus()
      cancel()
    }
    cancelFocusRestore = cancel
    observer = new MutationObserver(restore)
    observer.observe(document.body, { childList: true, subtree: true })
    unsubscribe = useUIStore.subscribe(() => { if (useUIStore.getState().sidebarView !== 'commander') cancel() })
    requestAnimationFrame(restore)
  },
  announce: (text, assertive = true) => set(state => ({ notice: { id: (state.notice?.id ?? 0) + 1, text, assertive } }))
}))

export function useCommanderPipVisible(): boolean {
  const active = useCommanderCallStore(s => s.status !== 'off' || s.error !== null)
  const requested = useCommanderCallUiStore(s => s.pipRequested)
  const view = useUIStore(s => s.sidebarView)
  return active && (requested || view !== 'commander')
}

