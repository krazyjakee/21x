import React from 'react'
import { createRoot } from 'react-dom/client'
import { TaskBoard } from '../../src/renderer/src/components/dashboard/TaskBoard'
import { HeroSection } from '../../src/renderer/src/components/dashboard/HeroSection'
import { CanvasPanel } from '../../src/renderer/src/components/canvas/CanvasPanel'
import { NavRail } from '../../src/renderer/src/components/layout/NavRail'
import { StatusBar } from '../../src/renderer/src/components/layout/StatusBar'
import { TopBar } from '../../src/renderer/src/components/layout/TopBar'
import { CommanderWorkspace } from '../../src/renderer/src/components/commander/CommanderWorkspace'
import { CommanderCallHost } from '../../src/renderer/src/components/commander/CommanderCallHost'
import { CommanderCallSurfaces } from '../../src/renderer/src/components/commander/CommanderCallSurfaces'
import { ActivityBadge } from '../../src/renderer/src/components/activity/ActivityBadge'
import { TaskActivityBadge } from '../../src/renderer/src/components/activity/TaskActivityBadge'
import { useCaptainActivity, useCommanderActivity } from '../../src/renderer/src/lib/activity/use-activity'
import { activityNow, pendingActivityDeadlines } from '../../src/renderer/src/lib/activity/activity-clock'
import { useSessionActivityStore } from '../../src/renderer/src/lib/activity/session-activity-adapter'
import { useCommanderActivityStore } from '../../src/renderer/src/lib/activity/commander-activity-adapter'
import { useTaskStore } from '../../src/renderer/src/stores/task-store'
import { useAgentStore } from '../../src/renderer/src/stores/agent-store'
import { useProjectStore } from '../../src/renderer/src/stores/project-store'
import { useCoordinatorStore } from '../../src/renderer/src/stores/coordinator-store'
import { useCanvasStore, type CanvasPanelData } from '../../src/renderer/src/stores/canvas-store'
import { useCommanderStore } from '../../src/renderer/src/stores/commander-store'
import { useCommanderCallStore } from '../../src/renderer/src/stores/commander-call-store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice-store'
import { useUIStore } from '../../src/renderer/src/stores/ui-store'
import { TaskStatus, type Task, type Agent } from '../../src/renderer/src/types'
import './fixture.css'

const stamp = '2026-10-13T10:00:00Z'
function task(id: string, status = TaskStatus.AgentWorking): Task {
  return { id, title: id, description: 'Controlled activity evidence; no live provider.', type: 'general', priority: 'low', status,
    assignee: '', due_date: null, labels: [], attachments: [], repos: [], output_fields: [],
    agent_id: 'fixture-agent', session_id: null, external_id: null, source_id: null, source: 'local',
    skill_ids: null, snoozed_until: null, resolution: null, feedback_rating: null, feedback_comment: null,
    is_recurring: false, recurrence_pattern: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null,
    auto_start_agent: false, auto_complete_without_review: false, complete_at_source: null,
    created_at: stamp, updated_at: stamp, parent_task_id: null, next_subtask_ids: [], sort_order: 0, project_id: 'audit-project' }
}
const agent: Agent = { id: 'fixture-agent', name: 'Controlled agent', server_url: '', config: { coding_agent: 'claude-code', model: 'fixture-model' }, is_default: true, created_at: stamp, updated_at: stamp }
useProjectStore.setState({ currentProjectId: 'audit-project', isLoaded: true, projects: [{ id: 'audit-project', name: 'Activity audit', description: '', default_agent_id: agent.id, captain_agent_id: agent.id, git_provider: null, git_org: null, settings: {}, sort_order: 0, archived: false, created_at: stamp, updated_at: stamp }] })
useTaskStore.setState({ tasks: [task('task-one'), task('task-two'), task('task-ready', TaskStatus.ReadyForReview)], isLoading: false })
useAgentStore.setState({ agents: [agent], isLoading: false, sessions: new Map() })
useCoordinatorStore.setState({ captainTaskIds: { 'audit-project': 'captain-audit' } })
useCommanderStore.setState({ selectedSessionId: 'commander-session', messages: { 'commander-session': [] } })
useUIStore.setState({ sidebarView: 'tasks', activeModal: null, statusFilter: 'all', dashboardPreviewTaskId: null })
// A push-to-talk call may remain open without opening a capture lease. This
// harness does not assert microphone or output-audio behavior; the separate
// Commander native harness exercises controlled capture and real PCM output.
useCommanderCallStore.setState({ micMode: 'push-to-talk' })
useVoiceStore.setState({ available: true, enabled: true, permission: 'granted', runtime: { installed: true }, engine: { state: 'ready' }, tts: { enabled: true, status: { state: 'ready' } } })
const panels: CanvasPanelData[] = ['task-one', 'task-two'].map((id, index) => ({ id: 'panel-' + id, type: 'task', refId: id, title: id, x: index * 620, y: 0, width: 600, height: 390, zIndex: index + 1 }))
useCanvasStore.setState({ panels, edges: [] })
Object.assign(window.fixture, {
  inspect: () => ({ now: activityNow(), session: useSessionActivityStore.getState(), commander: useCommanderActivityStore.getState(), deadlines: pendingActivityDeadlines(), call: { status: useCommanderCallStore.getState().status, sessionId: useCommanderCallStore.getState().sessionId }, agentCache: [...useAgentStore.getState().sessions].map(([id, session]) => ({ id, status: session.status, sessionId: session.sessionId })) }),
  hydrateLegacy: () => useAgentStore.getState().initSession('task-one', 'cached-dead-session', agent.id),
  taskStatus: (id: string, status: TaskStatus) => window.fixture.emit('onTaskUpdated', { taskId: id, updates: { status } })
})
const noop = () => {}
function ExpandedEvidence() {
  const captain = useCaptainActivity('captain-audit')
  const commander = useCommanderActivity()
  return <aside className="audit-expanded" aria-label="Expanded activity evidence">
    <div data-testid="expanded-captain"><ActivityBadge result={captain} entityName="Captain" entityKey="task:captain-audit" region="audit-captain" /><span>{captain.detail}</span></div>
    <div data-testid="expanded-commander"><ActivityBadge result={commander} entityName="Commander" entityKey="commander" region="audit-commander" allowMotion={false} /><span>{commander.detail}</span></div>
    <div data-testid="expanded-unknown"><TaskActivityBadge taskId="unobserved-task" title="Unobserved task" region="audit-unknown" allowMotion={false} hideWhenQuiet={false} /></div>
  </aside>
}
function Fixture() {
  const view = useUIStore(s => s.sidebarView)
  const activePanels = useCanvasStore(s => s.panels)
  return <div className="audit-shell bg-background text-foreground">
    <CommanderCallHost /><CommanderCallSurfaces />
    <header data-testid="audit-topbar"><TopBar onOpenCommandPalette={noop} /></header>
    <div className="audit-shell-body">
      <aside data-testid="audit-nav"><NavRail /></aside>
      {view === 'commander' ? <main className="audit-commander"><CommanderWorkspace /></main> : <main className="audit-content" aria-label="Activity audit workspace">
        <HeroSection onSeeFullConversation={noop} />
        <ExpandedEvidence />
        <section className="audit-board" aria-label="Actual task board"><TaskBoard /></section>
        <section className="audit-canvas" aria-label="Actual canvas panels">{activePanels.map(panel => <CanvasPanel key={panel.id} panel={panel} zoom={1} />)}</section>
      </main>}
    </div>
    <footer data-testid="audit-status"><StatusBar /></footer>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
