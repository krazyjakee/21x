import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskWorkspace } from '../../src/renderer/src/components/tasks/TaskWorkspace'
import { useTaskStore } from '../../src/renderer/src/stores/task-store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings-store'
import { useAgentStore, SessionStatus } from '../../src/renderer/src/stores/agent-store'
import { useArtifactStore } from '../../src/renderer/src/stores/artifact-store'
import { TaskStatus, type Task, type Agent } from '../../src/renderer/src/types'
import './fixture.css'

const task: Task = {
  id: 'layout-task', title: 'Review customer checkout and prepare the deployment',
  description: '## Customer checkout\n\nReview the full checkout flow, document what changed, and explain the next step.\n\n' + Array.from({ length: 20 }, (_, i) => `- Review item ${i + 1}: confirm that customers can complete their order.`).join('\n'),
  type: 'general', priority: 'medium', status: TaskStatus.NotStarted,
  assignee: '', due_date: null, labels: ['checkout', 'release review'], attachments: [], repos: [],
  output_fields: [], agent_id: 'layout-agent', session_id: null, external_id: null, source_id: null,
  source: 'manual', skill_ids: null, snoozed_until: null, resolution: null, feedback_rating: null,
  feedback_comment: null, is_recurring: false, recurrence_pattern: null, recurrence_parent_id: null,
  last_occurrence_at: null, next_occurrence_at: null, auto_start_agent: false,
  auto_complete_without_review: false, complete_at_source: null,
  created_at: '2026-10-13T10:00:00Z', updated_at: '2026-10-13T10:00:00Z',
  parent_task_id: null, next_subtask_ids: [], sort_order: 0
}
const agent: Agent = {
  id: 'layout-agent', name: 'Checkout agent', server_url: '', config: { coding_agent: 'claude-code', model: 'fixture' },
  is_default: true, created_at: task.created_at, updated_at: task.updated_at
}
useTaskStore.setState({ tasks: [task], fetchTasks: async () => {} })
useSettingsStore.setState({ fetchSettings: async () => {} })
useAgentStore.setState({ agents: [agent], sessions: new Map() })
useArtifactStore.setState({ hydrate: async () => {} })
const noop = () => {}
function Fixture() {
  const [activeTask, setTask] = useState(task)
  Object.assign(window.fixture, {
    transcript: () => {
      useAgentStore.getState().initSession(task.id, 'layout-session', agent.id)
      useAgentStore.setState(state => ({ sessions: new Map(state.sessions).set(task.id, {
        ...state.sessions.get(task.id)!, status: SessionStatus.IDLE,
        messages: [{ id: 'layout-message', role: 'assistant', content: 'The checkout review is ready. Please review the release notes before deployment.', timestamp: new Date() }]
      }) }))
      setTask({ ...task, session_id: 'layout-session', status: TaskStatus.ReadyForReview })
    }
  })
  return <div className="h-screen bg-background text-foreground" data-testid="task-fixture">
    <TaskWorkspace task={activeTask} agents={[agent]} onEdit={noop} onDelete={noop}
      onUpdateAttachments={noop} onUpdateOutputFields={noop} onCompleteTask={noop} onAssignAgent={noop}
      showActivity={false} />
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
