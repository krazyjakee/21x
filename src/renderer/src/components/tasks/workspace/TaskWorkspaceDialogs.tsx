import { useCallback, useEffect, useState } from 'react'
import { getSourceCompletionDescription, getTaskSourceName } from '@shared/task-completion'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useAgentStore } from '@/stores/agent-store'
import { onAgentIncompatibleSession } from '@/lib/ipc-client'
import { subscribe } from '@/lib/shared-ipc-listeners'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { OrgPickerDialog } from '@/components/github/OrgPickerDialog'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { SkillSelectorDialog } from '@/components/skills/SkillSelectorDialog'
import { AgentFormDialog } from '@/components/settings/forms/AgentFormDialog'
import { FeedbackDialog } from '../FeedbackDialog'
import { SnoozeDialog } from '../SnoozeDialog'
import { IncompatibleSessionDialog } from '../IncompatibleSessionDialog'
import type { useRepoSetupFlow } from './useRepoSetupFlow'
import type { useTaskFeedbackFlow } from './useTaskFeedbackFlow'
import type { Agent, Task, CreateAgentDTO, UpdateAgentDTO } from '@/types'

interface TaskWorkspaceDialogsProps {
  task: Task
  agents: Agent[]
  repoSetup: ReturnType<typeof useRepoSetupFlow>
  feedback: ReturnType<typeof useTaskFeedbackFlow>
  showSkillSelector: boolean
  onShowSkillSelectorChange: (open: boolean) => void
  onUpdateSkillIds: (skillIds: string[] | null) => Promise<void>
  showSnooze: boolean
  onShowSnoozeChange: (open: boolean) => void
  onSnooze: (isoString: string) => Promise<void>
  editingAgentId: string | null
  onEditingAgentIdChange: (agentId: string | null) => void
  onStartFreshSession: () => Promise<void>
}

export function TaskWorkspaceDialogs({
  task,
  agents,
  repoSetup,
  feedback,
  showSkillSelector,
  onShowSkillSelectorChange,
  onUpdateSkillIds,
  showSnooze,
  onShowSnoozeChange,
  onSnooze,
  editingAgentId,
  onEditingAgentIdChange,
  onStartFreshSession
}: TaskWorkspaceDialogsProps) {
  const taskSources = useTaskSourceStore((state) => state.sources)
  const updateAgent = useAgentStore((s) => s.updateAgent)
  const [showIncompatibleSession, setShowIncompatibleSession] = useState(false)
  const [incompatibleSessionError, setIncompatibleSessionError] = useState<string>()

  // Shared listener to avoid MaxListeners warnings with many open panels.
  useEffect(() => {
    return subscribe<{ taskId: string; agentId: string; error: string }>(
      'agent:incompatible-session',
      (cb) => onAgentIncompatibleSession(cb),
      (data) => {
        if (data.taskId === task.id) {
          setIncompatibleSessionError(data.error)
          setShowIncompatibleSession(true)
        }
      }
    )
  }, [task.id])

  const handleSaveAgent = useCallback(async (data: CreateAgentDTO | UpdateAgentDTO) => {
    if (!editingAgentId) return
    await updateAgent(editingAgentId, data as UpdateAgentDTO)
    onEditingAgentIdChange(null)
  }, [editingAgentId, updateAgent, onEditingAgentIdChange])

  const editingAgent = editingAgentId ? agents.find((a) => a.id === editingAgentId) : undefined
  const sourceName = task.source_id ? taskSources.find((source) => source.id === task.source_id)?.name : undefined

  return (
    <>
      <GhCliSetupDialog
        open={repoSetup.showGhSetup}
        onOpenChange={repoSetup.setShowGhSetup}
        onComplete={repoSetup.handleGhSetupComplete}
      />

      <OrgPickerDialog
        open={repoSetup.showOrgPicker}
        onOpenChange={repoSetup.setShowOrgPicker}
        onSelect={repoSetup.handleOrgSelected}
      />

      {repoSetup.githubOrg && (
        <RepoSelectorDialog
          open={repoSetup.showRepoSelector}
          onOpenChange={repoSetup.setShowRepoSelector}
          org={repoSetup.githubOrg}
          orgProvider={repoSetup.orgProvider}
          initialRepos={task.repos}
          onConfirm={repoSetup.handleReposConfirmed}
        />
      )}

      <SkillSelectorDialog
        open={showSkillSelector}
        onOpenChange={onShowSkillSelectorChange}
        initialSkillIds={task.skill_ids ?? []}
        onConfirm={onUpdateSkillIds}
      />

      <FeedbackDialog
        open={feedback.showFeedback}
        sourceName={task.source_id ? getTaskSourceName(task, sourceName) : undefined}
        completionDescription={getSourceCompletionDescription(task, sourceName)}
        onSubmit={feedback.handleFeedbackSubmit}
        onSkip={feedback.handleFeedbackSkip}
        onCancel={feedback.handleFeedbackCancel}
      />

      <SnoozeDialog
        open={showSnooze}
        onOpenChange={onShowSnoozeChange}
        onSnooze={onSnooze}
      />

      <IncompatibleSessionDialog
        open={showIncompatibleSession}
        onOpenChange={setShowIncompatibleSession}
        onStartFresh={onStartFreshSession}
        error={incompatibleSessionError}
      />

      <AgentFormDialog
        agent={editingAgent}
        open={!!editingAgentId}
        onClose={() => onEditingAgentIdChange(null)}
        onSubmit={handleSaveAgent}
      />
    </>
  )
}
