import { useCallback } from 'react'
import { useUIStore } from '@/stores/ui-store'
import { HeroSection } from './HeroSection'
import { CommandInput } from './CommandInput'
import { QuickChips } from './QuickChips'
import { TaskBoard } from './TaskBoard'
import type { Task, TaskStatus } from '@/types'

interface DashboardWorkspaceProps {
  onTaskStatusChange?: (task: Task, status: TaskStatus) => void | Promise<void>
}

export function DashboardWorkspace({ onTaskStatusChange }: DashboardWorkspaceProps = {}) {
  const openCreateWithPrefill = useUIStore((s) => s.openCreateWithPrefill)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)

  // Handler: send message to Captain and open the drawer
  const handleSendToCaptain = useCallback((message: string, typed = false) => {
    // Open the orchestrator panel — the panel itself handles sending messages
    setShowOrchestrator(true)
    // We dispatch a custom event so the OrchestratorPanel can pick up the message
    window.dispatchEvent(new CustomEvent('captain-prefill', { detail: { message, typed } }))
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
        <CommandInput
          onSendToCaptain={handleSendToCaptain}
          onCreateTask={handleCreateTask}
        />

        {/* 3. Quick Task Chips */}
        <QuickChips
          onAskCaptain={handleSendToCaptain}
          onCreateTask={(text) => openCreateWithPrefill(text)}
        />
      </div>

      {/* Full-width sections below — constrained + centered to align with kanban */}
      <div className="max-w-[1600px] mx-auto px-6 space-y-6 pb-8">
        {/* 4. Task Board (Kanban) — full width */}
        <TaskBoard onStatusChange={onTaskStatusChange} />
      </div>
    </div>
  )
}
