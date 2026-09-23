import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommanderWorkspace } from '../../src/renderer/src/components/commander/CommanderWorkspace'
import { useGlobalShortcuts } from '../../src/renderer/src/components/layout/hooks/use-global-shortcuts'
import { focusComposerInput } from '../../src/renderer/src/lib/keyboard-shortcuts'
import { insertAndSubmit } from '../../src/renderer/src/lib/voice-dictation-target'
import { useAgentStore } from '../../src/renderer/src/stores/agent-store'
import { useCommanderStore } from '../../src/renderer/src/stores/commander-store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice-store'
import { useUIStore } from '../../src/renderer/src/stores/ui-store'
import type { CommandPaletteActions } from '../../src/renderer/src/components/layout/CommandPalette'
import './fixture.css'

useAgentStore.setState({ agents: [{ id: 'agent', name: 'Test', config: { coding_agent: 'claude-code', model: 'claude-test' } }], isLoading: false })
useCommanderStore.setState({ selectedSessionId: 'session-1' })
useUIStore.setState({ sidebarView: 'commander', activeModal: null })
useVoiceStore.setState({
  available: true, enabled: true, runtime: { installed: true }, engine: { state: 'ready' }, permission: 'granted',
  tts: { enabled: true, status: { state: 'ready' } },
  initializeTts: async () => {},
  startTurn: async () => { useVoiceStore.setState({ turnId: 'voice-turn', state: 'listening' }) },
  cancel: async () => { useVoiceStore.setState({ turnId: null, state: 'idle' }) },
  stopPlaybackNow: () => {}
})
Object.assign(window.fixture, {
  segment: insertAndSubmit,
  done: () => useCommanderStore.getState().handleEvent({ type: 'turn_event', sessionId: 'session-1', turnId: 'typed-turn', event: { type: 'done', stopReason: 'end_turn' } }),
  activity: () => useCommanderStore.getState().handleEvent({ type: 'turn_started', sessionId: 'session-1', turnId: 'voice-reply' })
})
const actions = new Proxy({ focusComposer: focusComposerInput }, { get: (target, key) => target[key] ?? (() => {}) }) as CommandPaletteActions
function Fixture() {
  const [, setOpen] = useState(false)
  useGlobalShortcuts(actions, setOpen)
  return <div className="h-screen bg-background text-foreground"><CommanderWorkspace /></div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
