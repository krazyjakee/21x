import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { commanderVoiceKey } from '@shared/commander-call'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useCoordinatorStore } from '@/stores/coordinator-store'
import { useUIStore } from '@/stores/ui-store'
import { getCurrentProjectId } from '@/stores/project-store'
import { isAutomaticSpeech, speechInFocus } from './voice-speech-focus'

function transcript(taskId: string, width = 400): HTMLElement {
  const panel = document.createElement('div')
  panel.dataset.transcriptTask = taskId
  panel.getBoundingClientRect = () => ({ width, height: 300 }) as DOMRect
  document.body.append(panel)
  return panel
}

describe('speechInFocus', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useUIStore.setState({ sidebarView: 'tasks', showOrchestrator: false } as never)
    useCommanderCallUiStore.setState({ pipRequested: false })
    useCommanderCallStore.setState({ sessionId: null })
    useCommanderStore.setState({ selectedSessionId: null })
    useCoordinatorStore.setState({ captainTaskIds: {} })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('stays silent for an unnamed passage', () => {
    expect(speechInFocus(undefined)).toBe(false)
  })

  describe('a task or Captain transcript', () => {
    it('may speak while it is on screen', () => {
      transcript('t1')
      expect(speechInFocus('t1')).toBe(true)
    })

    it('may not speak when another transcript is showing', () => {
      transcript('t2')
      expect(speechInFocus('t1')).toBe(false)
    })

    it('may not speak from a panel that is mounted but has no size', () => {
      transcript('t1', 0)
      expect(speechInFocus('t1')).toBe(false)
    })

    it('may not speak when the window has lost focus', () => {
      transcript('t1')
      vi.mocked(document.hasFocus).mockReturnValue(false)
      expect(speechInFocus('t1')).toBe(false)
    })
  })

  describe('the Captain', () => {
    const captain = 'cap'
    beforeEach(() => {
      useCoordinatorStore.setState({ captainTaskIds: { [getCurrentProjectId() as string]: captain } })
    })

    it('may speak while its drawer is open', () => {
      useUIStore.setState({ showOrchestrator: true })
      expect(speechInFocus(captain)).toBe(true)
    })

    it('may speak on the dashboard, where its command box is', () => {
      useUIStore.setState({ sidebarView: 'dashboard' })
      expect(speechInFocus(captain)).toBe(true)
    })

    it('may not speak with the drawer closed on another screen', () => {
      expect(speechInFocus(captain)).toBe(false)
    })

    it('does not lend the open drawer to any other task', () => {
      useUIStore.setState({ showOrchestrator: true })
      expect(speechInFocus('another-task')).toBe(false)
    })
  })

  describe('a Commander call', () => {
    const key = commanderVoiceKey('s1')
    beforeEach(() => {
      useCommanderCallStore.setState({ sessionId: 's1' })
      useUIStore.setState({ sidebarView: 'commander' })
    })

    it('may speak while its session is showing', () => {
      useCommanderStore.setState({ selectedSessionId: 's1' })
      expect(speechInFocus(key)).toBe(true)
    })

    it('may not speak while another session is showing', () => {
      useCommanderStore.setState({ selectedSessionId: 's2' })
      expect(speechInFocus(key)).toBe(false)
    })

    it('may speak from the floating call after leaving Commander', () => {
      useCommanderStore.setState({ selectedSessionId: 's2' })
      useUIStore.setState({ sidebarView: 'tasks' })
      expect(speechInFocus(key)).toBe(true)
    })

    it('may speak from the floating call opened by hand', () => {
      useCommanderStore.setState({ selectedSessionId: 's2' })
      useCommanderCallUiStore.setState({ pipRequested: true })
      expect(speechInFocus(key)).toBe(true)
    })

    it('may not speak when the window has lost focus, even floating', () => {
      useUIStore.setState({ sidebarView: 'tasks' })
      vi.mocked(document.hasFocus).mockReturnValue(false)
      expect(speechInFocus(key)).toBe(false)
    })

    it('may not speak for a session that is not the call', () => {
      expect(speechInFocus(commanderVoiceKey('other'))).toBe(false)
    })
  })
})

describe('isAutomaticSpeech', () => {
  it('covers replies, not anything the user pressed', () => {
    expect(isAutomaticSpeech('agent_answer')).toBe(true)
    expect(isAutomaticSpeech('conversation')).toBe(true)
    expect(isAutomaticSpeech('manual')).toBe(false)
    expect(isAutomaticSpeech('preview')).toBe(false)
    expect(isAutomaticSpeech('read_last_answer')).toBe(false)
    expect(isAutomaticSpeech('action_result')).toBe(false)
  })
})
