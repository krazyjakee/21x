import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommanderCallHost } from '../../src/renderer/src/components/commander/CommanderCallHost'
import { CommanderWorkspace } from '../../src/renderer/src/components/commander/CommanderWorkspace'
import { useGlobalShortcuts } from '../../src/renderer/src/components/layout/hooks/use-global-shortcuts'
import { focusComposerInput } from '../../src/renderer/src/lib/keyboard-shortcuts'
import { insertAndSubmit } from '../../src/renderer/src/lib/voice-dictation-target'
import { useAgentStore } from '../../src/renderer/src/stores/agent-store'
import { useCommanderStore } from '../../src/renderer/src/stores/commander-store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice-store'
import { useUIStore } from '../../src/renderer/src/stores/ui-store'
import type { CommanderMessage } from '../../src/shared/commander'
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
  typography: () => {
    const message = (id: string, role: CommanderMessage['role'], content: string): CommanderMessage => ({
      id, session_id: 'session-1', role, content, tool_calls: null, tool_call_id: null,
      tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: 1
    })
    const report = [
      '## Deployment report',
      'The website is ready for review. Customers can now complete their orders and the project has no outstanding blockers.',
      '- The checkout flow works.\n- [Review the release](https://example.com/release) before approving the deployment.\n- The configuration uses `RELEASE_CHANNEL=production`.',
      '```ts\nconst release = "' + 'long-value-'.repeat(40) + '"\n```',
      ...Array.from({ length: 24 }, (_, i) => `Progress update ${i + 1}: The team reviewed the customer journey and confirmed that each important step works as expected.`)
    ].join('\n\n')
    useCommanderStore.setState({
      sessions: [{ id: 'session-1', title: 'Deployment review and customer checkout improvements across projects', created_at: 1, updated_at: 1, archived: false, last_read_at: 0, unread_count: 7 }],
      messages: { 'session-1': [
        message('readable-user', 'user', 'Please review the customer checkout and explain what changed. ' + 'long-unbroken-message-'.repeat(18)),
        message('readable-assistant', 'assistant', 'I asked the project team to review the release. Your next step is to approve the customer checkout changes.'),
        message('readable-report', 'report', report)
      ] },
      streaming: { 'session-1': { turnId: 'typography', text: 'The review is still running. I will explain the result when it finishes.', toolCalls: [{ id: 'readable-call', name: 'ask_captain', input: { project: 'Customer website', message: 'Review the full checkout experience and report any blockers' } }] } },
      turnErrors: { 'session-1': 'The last update could not be sent. Try again after checking your connection.' }
    })
  },
  segment: insertAndSubmit,
  done: () => useCommanderStore.getState().handleEvent({ type: 'turn_event', sessionId: 'session-1', turnId: 'typed-turn', event: { type: 'done', stopReason: 'end_turn' } }),
  activity: () => useCommanderStore.getState().handleEvent({ type: 'turn_started', sessionId: 'session-1', turnId: 'voice-reply' })
})
const actions = new Proxy({ focusComposer: focusComposerInput }, { get: (target, key) => target[key] ?? (() => {}) }) as CommandPaletteActions
function Fixture() {
  const [, setOpen] = useState(false)
  useGlobalShortcuts(actions, setOpen)
  return (
    <div className="h-screen bg-background text-foreground">
      <CommanderCallHost />
      <CommanderWorkspace />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
