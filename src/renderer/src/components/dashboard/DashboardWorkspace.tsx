import { useCallback } from 'react'
import { useUIStore } from '@/stores/ui-store'
import { getCurrentProjectId, useProjectStore } from '@/stores/project-store'
import { getCaptainTaskId, useCoordinatorStore } from '@/stores/coordinator-store'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { HeroSection } from './HeroSection'
import { CommandInput } from './CommandInput'
import { TaskSearch } from './TaskSearch'
import { TaskBoard } from './TaskBoard'
import type { TaskBoardProps } from './TaskBoard'

interface DashboardWorkspaceProps {
  onTaskStatusChange?: TaskBoardProps['onStatusChange']
}

export function DashboardWorkspace({ onTaskStatusChange }: DashboardWorkspaceProps = {}) {
  const openCreateWithPrefill = useUIStore((s) => s.openCreateWithPrefill)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const projectId = useProjectStore((s) => s.currentProjectId)

  // Handler: send message to Captain and open the drawer
  const handleSendToCaptain = useCallback((message: string): boolean => {
    // Nowhere to deliver it yet. A load that failed is not retried on its own, so ask again.
    if (!getCaptainTaskId()) {
      void useCoordinatorStore.getState().load(getCurrentProjectId())
      dispatchShortcutFeedback('This project’s Captain is not ready yet. Your message is still in the box.', true)
      return false
    }
    // Open the orchestrator panel — the panel itself handles sending messages
    setShowOrchestrator(true)
    // We dispatch a custom event so the OrchestratorPanel can pick up the message
    window.dispatchEvent(new CustomEvent('captain-prefill', { detail: { message } }))
    return true
  }, [setShowOrchestrator])

  // Handler: create task from command input text
  const handleCreateTask = useCallback((text: string) => {
    if (text) {
      openCreateWithPrefill(text)
    } else {
      openCreateWithPrefill('')
    }
  }, [openCreateWithPrefill])

  // Handler: open Captain drawer from hero "See full conversation"
  const handleSeeFullConversation = useCallback(() => {
    setShowOrchestrator(true)
  }, [setShowOrchestrator])

  return (
    <div className="ui-scale h-full overflow-y-auto overflow-x-hidden">
      {/* Command center — centered narrow column */}
      <div className="max-w-3xl mx-auto px-6 pt-8 pb-6 space-y-5">
        {/* 1. Hero — Recent Captain Messages */}
        <HeroSection onSeeFullConversation={handleSeeFullConversation} />

        {/* 2. Command Input */}
        {/* Keyed: text typed for one project's Captain must not be sent to the next. */}
        <CommandInput
          key={projectId}
          draftKey={`dashboard:${projectId}`}
          onSendToCaptain={handleSendToCaptain}
          onCreateTask={handleCreateTask}
        />

        {/* 3. Search all current-project tasks, including completed and snoozed work. */}
        <TaskSearch />
      </div>

      {/* Full-width sections below — constrained + centered to align with kanban */}
      <div className="max-w-[1600px] mx-auto px-6 space-y-6 pb-8">
        {/* 4. Task Board (Kanban) — full width */}
        <TaskBoard onStatusChange={onTaskStatusChange} />
      </div>
    </div>
  )
}
