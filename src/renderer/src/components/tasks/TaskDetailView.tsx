import React, { useEffect } from 'react'
import { Pencil, Trash2, Calendar, User, Tag, Clock, Bot, Play, History, GitBranch, Route, Plus, X, BookOpen, AlarmClockOff, BellRing, Folder, Repeat, Star, Sparkles, Layers, Settings2, Terminal } from 'lucide-react'
import { CollapsibleDescription } from '@/components/ui/CollapsibleDescription'
import { Button } from '@/components/ui/Button'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskAttachments } from './TaskAttachments'
import { Badge } from '@/components/ui/Badge'
import { formatDate, formatRelativeDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { useSkillStore } from '@/stores/skill-store'
import { AssigneeSelect } from './AssigneeSelect'
import { TaskStatus, CodingAgentType } from '@/types'
import type { Task, FileAttachment, OutputField, Agent } from '@/types'
import { formatRecurrencePattern } from './recurrence-format'
import { SNOOZE_SOMEDAY } from '@/lib/snooze-options'
import { AnthropicLogo, OpenCodeLogo, OpenAILogo, PiLogo } from '@/components/icons/AgentLogos'
import { HeartbeatSection } from './HeartbeatSection'
import { useUIStore } from '@/stores/ui-store'
import { SubtasksSection } from './SubtasksSection'
import { ParentTaskContext } from './ParentTaskContext'
import { AgentConfigWarning } from './AgentConfigWarning'

interface TaskDetailViewProps {
  task: Task
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: () => void
  onAssignAgent: (agentId: string | null) => void
  onUpdateRepos: (repos: string[]) => void
  onAddRepos: () => void
  onUpdateSkillIds?: (skillIds: string[] | null) => void
  onAddSkills?: () => void
  onStartAgent?: () => void
  canStartAgent?: boolean
  onResumeAgent?: () => void
  canResumeAgent?: boolean
  onRestartAgent?: () => void
  canRestartAgent?: boolean
  onSnooze?: () => void
  onUnsnooze?: () => void
  onReassign?: (userIds: string[], displayName: string) => Promise<void>
  onTriage?: () => void
  canTriage?: boolean
  /** Open the agent editor dialog for a specific agent (or the currently assigned one). */
  onEditAgent?: (agentId: string) => void
  /** Save an inline description edit. When provided, the description becomes editable. */
  onUpdateDescription?: (description: string) => void | Promise<void>
  /** Update auto-start / auto-complete flags for recurring templates */
  onUpdateAutoFlags?: (updates: { auto_start_agent?: boolean; auto_complete_without_review?: boolean }) => void
  subtasks?: Task[]
  siblingSubtasks?: Task[]
  parentTask?: Task | null
  onUpdateNextSubtaskIds?: (taskIds: string[]) => void | Promise<void>
  onNavigateToTask?: (taskId: string) => void
  /** When provided, each subtask shows an action to open it as a separate window/panel. */
  onOpenSubtaskInWindow?: (taskId: string) => void
  onAddSubtask?: (title: string) => void
  onReorderSubtasks?: (orderedIds: string[]) => void
  /** Presentation-only mode used by the task workspace redesign. */
  displayMode?: 'full' | 'prestart' | 'panel'
  /** Output fields live in their own pinned artifact tab in panel mode. */
  showOutputFields?: boolean
  /** The workspace header owns the primary action once a session exists. */
  showPrimaryActions?: boolean
}

function TaskDetailViewComponent({ task, agents, onEdit, onDelete, onUpdateAttachments, onUpdateOutputFields, onCompleteTask, onAssignAgent, onUpdateRepos, onAddRepos, onUpdateSkillIds, onAddSkills, onStartAgent, canStartAgent, onResumeAgent, canResumeAgent, onRestartAgent, canRestartAgent, onSnooze, onUnsnooze, onReassign, onTriage, canTriage, onEditAgent, onUpdateDescription, onUpdateAutoFlags, subtasks, siblingSubtasks, parentTask, onUpdateNextSubtaskIds, onNavigateToTask, onOpenSubtaskInWindow, onAddSubtask, onReorderSubtasks, displayMode = 'full', showOutputFields = true, showPrimaryActions = true }: TaskDetailViewProps) {
  // Per-field selectors — a selector-less useSkillStore() re-renders this
  // large view on every skill-store mutation.
  const skills = useSkillStore((s) => s.skills)
  const fetchSkills = useSkillStore((s) => s.fetchSkills)
  const openTaskOnCanvas = useUIStore((s) => s.openTaskOnCanvas)
  const isActive = task.status !== TaskStatus.Completed

  useEffect(() => {
    if (task.agent_id && Array.isArray(task.skill_ids)) {
      fetchSkills()
    }
  }, [task.agent_id, task.skill_ids])
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)

  const handleOpenFolder = async () => {
    const workspaceDir = await window.electronAPI.tasks.getWorkspaceDir(task.id)
    await window.electronAPI.shell.openPath(workspaceDir)
  }

  return (
    <div className="flex flex-col h-full">
      {displayMode === 'full' && (
      <div className="flex items-center justify-between border-b border-border/60 px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <TaskStatusBadge status={task.status} />
          <TaskTypeBadge type={task.type} />
          <TaskPriorityBadge priority={task.priority} />
        </div>
        <div className="flex items-center gap-1">
          {isActive && isSnoozed(task.snoozed_until) && onUnsnooze && (
            <Button variant="ghost" size="sm" onClick={onUnsnooze}>
              <BellRing className="h-3.5 w-3.5" />
              Unsnooze
            </Button>
          )}
          {isActive && !isSnoozed(task.snoozed_until) && onSnooze && (
            <Button variant="ghost" size="sm" onClick={onSnooze}>
              <AlarmClockOff className="h-3.5 w-3.5" />
              Snooze
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => openTaskOnCanvas(task.id)} title="Open in Canvas">
            <Layers className="h-3.5 w-3.5" />
            Canvas
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className={`${displayMode === 'prestart' ? 'max-w-[780px] px-6 py-6' : displayMode === 'panel' ? 'max-w-none px-5 py-5' : 'max-w-2xl px-8 py-8'} mx-auto space-y-6`}>
          {parentTask && onNavigateToTask && (
            <ParentTaskContext parentTask={parentTask} onNavigateToTask={onNavigateToTask} />
          )}

          <div className={displayMode === 'prestart' ? 'rounded-xl border border-border/50 bg-card p-5' : ''}>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {(task.description || onUpdateDescription) && (
              <CollapsibleDescription
                taskId={task.id}
                description={task.description}
                size="sm"
                className="mt-3 text-muted-foreground"
                onSave={onUpdateDescription}
                collapsedLines={displayMode === 'panel' ? 3 : 5}
              />
            )}
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-4 text-sm">
            {task.parent_task_id && (
              <>
                <span className="text-muted-foreground flex items-start gap-2 pt-1"><Route className="h-3.5 w-3.5" /> Next subtasks</span>
                <div className="space-y-2" data-testid="next-subtasks-field">
                  {(siblingSubtasks || []).length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {(siblingSubtasks || []).map((sibling) => {
                        const nextSubtaskIds = task.next_subtask_ids ?? []
                        const selected = nextSubtaskIds.includes(sibling.id)
                        return (
                          <label key={sibling.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs cursor-pointer hover:bg-accent">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => onUpdateNextSubtaskIds?.(
                                selected
                                  ? nextSubtaskIds.filter((id) => id !== sibling.id)
                                  : [...nextSubtaskIds, sibling.id]
                              )}
                            />
                            {sibling.title}
                          </label>
                        )
                      })}
                    </div>
                  ) : <span className="text-xs text-muted-foreground">No sibling subtasks</span>}
                  <p className="text-[11px] text-muted-foreground">
                    {(task.next_subtask_ids ?? []).length > 0
                      ? 'Selected subtasks start automatically when this task is completed.'
                      : 'The parent orchestrator decides what to do next.'}
                  </p>
                </div>
              </>
            )}
            <>
              <span className="text-muted-foreground flex items-center gap-2"><User className="h-3.5 w-3.5" /> Assignee</span>
              <AssigneeSelect
                assignee={task.assignee}
                sourceId={task.source_id}
                taskId={task.id}
                onReassign={(userIds, displayName) => onReassign?.(userIds, displayName)}
              />
            </>
            <>
              <span className="text-muted-foreground flex items-center gap-2"><Bot className="h-3.5 w-3.5" /> Agent</span>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={task.agent_id || ''}
                    onChange={(e) => onAssignAgent(e.target.value || null)}
                    className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer"
                  >
                    <option value="">No agent assigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                  {task.agent_id && agents.find(a => a.id === task.agent_id)?.config.coding_agent && (() => {
                    const agent = agents.find(a => a.id === task.agent_id)
                    const codingAgent = agent?.config.coding_agent
                    const agentName = codingAgent === CodingAgentType.CLAUDE_CODE ? 'Claude Code' :
                                     codingAgent === CodingAgentType.OPENCODE ? 'OpenCode' :
                                     codingAgent === CodingAgentType.CURSOR ? 'Cursor' :
                                     codingAgent === CodingAgentType.PI ? 'Pi' :
                                     'Codex'
                    const LogoComponent = codingAgent === CodingAgentType.CLAUDE_CODE ? AnthropicLogo :
                                         codingAgent === CodingAgentType.OPENCODE ? OpenCodeLogo :
                                         codingAgent === CodingAgentType.CURSOR ? Terminal :
                                         codingAgent === CodingAgentType.PI ? PiLogo :
                                         OpenAILogo
                    return (
                      <div
                        className="w-4 h-4 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                        title={agentName}
                      >
                        <LogoComponent className="w-full h-full" />
                      </div>
                    )
                  })()}
                  {/* Per-row action buttons are outline/secondary — the big
                      state-aware primary CTA lives at the bottom of the view
                      (see the prioritized CTA section). Keeping these inline
                      for quick access but visually secondary so there's only
                      one primary-colored button on screen at a time. */}
                  {canTriage && onTriage && (
                    <Button variant="outline" size="sm" onClick={onTriage} className="h-7 gap-1.5 px-3">
                      <Sparkles className="h-3 w-3" />
                      Triage
                    </Button>
                  )}
                  {canResumeAgent && onResumeAgent && (
                    <Button variant="outline" size="sm" onClick={onResumeAgent} className="h-7 gap-1.5 px-3">
                      <History className="h-3 w-3" />
                      Resume session
                    </Button>
                  )}
                  {canRestartAgent && onRestartAgent && (
                    <Button variant="outline" size="sm" onClick={onRestartAgent} className="h-7 gap-1.5 px-3">
                      <Play className="h-3 w-3" />
                      Restart session
                    </Button>
                  )}
                  {canStartAgent && onStartAgent && (
                    <Button variant="outline" size="sm" onClick={onStartAgent} className="h-7 gap-1.5 px-3">
                      <Play className="h-3 w-3" />
                      Start
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {task.agent_id && onEditAgent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditAgent(task.agent_id!)}
                      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                      title="Edit agent configuration"
                      data-testid="edit-agent-button"
                    >
                      <Settings2 className="h-3 w-3" />
                      Edit agent
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenFolder}
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                    title="Open workspace folder"
                  >
                    <Folder className="h-3 w-3" />
                    Open workspace folder
                  </Button>
                </div>
                <AgentConfigWarning
                  task={task}
                  agents={agents}
                  onEditAgent={onEditAgent}
                />
              </div>
            </>
            <>
              <span className="text-muted-foreground flex items-center gap-2"><GitBranch className="h-3.5 w-3.5" /> Repos</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {task.repos.map((repo) => (
                  <Badge key={repo} className="gap-1 pr-1">
                    {repo.split('/').pop()}
                    <button
                      onClick={() => onUpdateRepos(task.repos.filter((r) => r !== repo))}
                      className="rounded-full hover:bg-foreground/10 p-0.5"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
                <Button variant="ghost" size="sm" onClick={onAddRepos} className="h-6 gap-1 px-2 text-xs text-muted-foreground">
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              </div>
            </>
            {task.agent_id && onUpdateSkillIds && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><BookOpen className="h-3.5 w-3.5" /> Skills</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {!Array.isArray(task.skill_ids) ? (
                    <span className="text-sm text-muted-foreground">Using agent defaults</span>
                  ) : (
                    <>
                      {task.skill_ids.map((skillId) => {
                        const skill = skills.find((s) => s.id === skillId)
                        if (!skill) return null
                        return (
                          <Badge key={skillId} className="gap-1 pr-1">
                            {skill.name}
                            <button
                              onClick={() => onUpdateSkillIds(task.skill_ids!.filter((id) => id !== skillId))}
                              className="rounded-full hover:bg-foreground/10 p-0.5"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </Badge>
                        )
                      })}
                    </>
                  )}
                  <Button variant="ghost" size="sm" onClick={onAddSkills} className="h-6 gap-1 px-2 text-xs text-muted-foreground">
                    <Plus className="h-3 w-3" />
                    {!Array.isArray(task.skill_ids) ? 'Customize' : 'Add'}
                  </Button>
                  {Array.isArray(task.skill_ids) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUpdateSkillIds(null)}
                      className="h-6 text-xs text-muted-foreground"
                    >
                      Reset to defaults
                    </Button>
                  )}
                </div>
              </>
            )}
            {task.due_date && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Calendar className="h-3.5 w-3.5" /> Due date</span>
                <span className={overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : ''}>
                  {formatDate(task.due_date)}
                  {overdue && <Badge variant="red" className="ml-2">Overdue</Badge>}
                  {dueSoon && <Badge variant="yellow" className="ml-2">Due soon</Badge>}
                </span>
              </>
            )}
            {isSnoozed(task.snoozed_until) && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><AlarmClockOff className="h-3.5 w-3.5" /> Hidden until</span>
                <span className="text-muted-foreground">
                  {task.snoozed_until === SNOOZE_SOMEDAY ? 'Someday' : formatDate(task.snoozed_until)}
                </span>
              </>
            )}
            {task.is_recurring && task.recurrence_pattern && !task.recurrence_parent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Repeat className="h-3.5 w-3.5" /> Recurrence</span>
                <div className="flex flex-col gap-1">
                  <span>{formatRecurrencePattern(task.recurrence_pattern)}</span>
                  {task.next_occurrence_at && (
                    <span className="text-xs text-muted-foreground">
                      Next: {formatDate(task.next_occurrence_at)}
                    </span>
                  )}
                </div>
              </>
            )}
            {task.is_recurring && !task.recurrence_parent_id && task.agent_id && onUpdateAutoFlags && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Play className="h-3.5 w-3.5" /> Auto-start</span>
                <label className="flex items-center gap-2 cursor-pointer" data-testid="auto-start-agent-toggle">
                  <input
                    type="checkbox"
                    checked={task.auto_start_agent}
                    onChange={(e) => onUpdateAutoFlags({ auto_start_agent: e.target.checked })}
                    className="h-4 w-4 rounded border-border bg-background text-primary cursor-pointer"
                  />
                  <span className="text-sm">Auto-start agent on new instances</span>
                </label>
                <span className="text-muted-foreground flex items-center gap-2"><Sparkles className="h-3.5 w-3.5" /> Auto-complete</span>
                <label className="flex items-center gap-2 cursor-pointer" data-testid="auto-complete-toggle">
                  <input
                    type="checkbox"
                    checked={task.auto_complete_without_review}
                    onChange={(e) => onUpdateAutoFlags({ auto_complete_without_review: e.target.checked })}
                    className="h-4 w-4 rounded border-border bg-background text-primary cursor-pointer"
                  />
                  <span className="text-sm">Auto-complete without review</span>
                </label>
              </>
            )}
            {task.recurrence_parent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Repeat className="h-3.5 w-3.5" /> Instance</span>
                <Badge variant="blue" className="w-fit">Created from recurring template</Badge>
              </>
            )}
            {task.status === TaskStatus.Completed && task.feedback_rating && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Star className="h-3.5 w-3.5" /> Feedback</span>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }, (_, i) => (
                      <Star
                        key={i}
                        className={`h-3.5 w-3.5 ${i < task.feedback_rating! ? 'fill-[#f5b301] text-[#f5b301]' : 'text-muted-foreground/30'}`}
                      />
                    ))}
                  </div>
                  {task.feedback_comment && (
                    <span className="text-muted-foreground text-xs">{task.feedback_comment}</span>
                  )}
                </div>
              </>
            )}
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Created</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.created_at)}</span>
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Updated</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.updated_at)}</span>
            {(task.status === TaskStatus.ReadyForReview || task.heartbeat_enabled) && (
              <HeartbeatSection task={task} />
            )}
          </div>

          {task.labels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="h-3.5 w-3.5" /> Labels
              </div>
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((label) => (
                  <Badge key={label} variant="blue">{label}</Badge>
                ))}
              </div>
            </div>
          )}

          {!task.parent_task_id && (
            <SubtasksSection
              subtasks={subtasks || []}
              onNavigateToTask={onNavigateToTask}
              onOpenSubtaskInWindow={onOpenSubtaskInWindow}
              onAddSubtask={onAddSubtask}
              onReorderSubtasks={onReorderSubtasks}
            />
          )}

          {/* Always render the attachments section so users can add files directly
              from the task view modal, even when the task has no attachments yet. */}
          <div className="rounded-md border p-4">
            <TaskAttachments
              items={task.attachments}
              onChange={onUpdateAttachments}
              taskId={task.id}
            />
          </div>

          {showOutputFields && task.output_fields.length > 0 && (
            <div className="rounded-md border p-4">
              <OutputFieldsDisplay
                fields={task.output_fields}
                onChange={onUpdateOutputFields}
                isActive={isActive}
                onComplete={onCompleteTask}
                taskUpdatedAt={task.updated_at}
              />
            </div>
          )}

          {showPrimaryActions && isActive && (() => {
            // Prioritized main CTA — state-aware.
            //
            // In most states the happy path is to move the task forward with an
            // agent action, so Start > Resume > Restart > Triage wins over the
            // always-available Complete escape hatch.
            //
            // In ReadyForReview the happy path flips: the agent has already
            // finished, so the user is reviewing the result and the expected
            // next step is to accept (Complete). Resume stays visible as a
            // secondary "needs another pass" affordance. Mirrors how code
            // review tools promote Merge/Approve after an agent finishes.
            type AgentAction = { label: string; icon: typeof Play; onClick: () => void; testId: string }
            let agentAction: AgentAction | null = null
            if (canStartAgent && onStartAgent) {
              agentAction = { label: 'Start Task', icon: Play, onClick: onStartAgent, testId: 'main-cta-start' }
            } else if (canResumeAgent && onResumeAgent) {
              agentAction = { label: 'Resume Session', icon: History, onClick: onResumeAgent, testId: 'main-cta-resume' }
            } else if (canRestartAgent && onRestartAgent) {
              agentAction = { label: 'Restart Session', icon: Play, onClick: onRestartAgent, testId: 'main-cta-restart' }
            } else if (canTriage && onTriage) {
              agentAction = { label: 'Triage', icon: Sparkles, onClick: onTriage, testId: 'main-cta-triage' }
            }

            const hasOutputCompleteButton = task.output_fields.length > 0
            // If OutputFieldsDisplay already renders its own Complete button (when
            // all required fields are filled), don't render another here.
            const showCompleteButton = !hasOutputCompleteButton

            const isReadyForReview = task.status === TaskStatus.ReadyForReview

            // In ReadyForReview the happy path is acceptance (Complete) — the
            // agent action stays visible for "needs another pass" but as a
            // secondary outline button. This applies even when our own Complete
            // isn't rendered (because OutputFieldsDisplay has one when
            // output_fields exist) — we still demote the agent action so there
            // aren't two green buttons on screen.
            const agentActionIsPrimary = !!agentAction && !isReadyForReview
            const completeIsPrimary =
              showCompleteButton && (!agentAction || isReadyForReview)

            if (!agentAction && !showCompleteButton) return null

            return (
              <div className="flex flex-col gap-2">
                {agentAction && agentActionIsPrimary && (
                  <Button
                    onClick={agentAction.onClick}
                    size="lg"
                    className="w-full gap-2"
                    data-testid={agentAction.testId}
                  >
                    <agentAction.icon className="h-4 w-4" />
                    {agentAction.label}
                  </Button>
                )}
                {showCompleteButton && (
                  <Button
                    onClick={onCompleteTask}
                    variant={completeIsPrimary ? 'default' : 'outline'}
                    size={completeIsPrimary ? 'lg' : 'default'}
                    className="w-full"
                    data-testid="main-cta-complete"
                  >
                    Complete Task
                  </Button>
                )}
                {agentAction && !agentActionIsPrimary && (
                  <Button
                    onClick={agentAction.onClick}
                    variant="outline"
                    className="w-full gap-2"
                    data-testid={agentAction.testId}
                  >
                    <agentAction.icon className="h-4 w-4" />
                    {agentAction.label}
                  </Button>
                )}
              </div>
            )
          })()}

          <div className="pt-2 border-t text-xs text-muted-foreground">
            Source: <Badge className="ml-1">{task.source}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}

export const TaskDetailView = React.memo(TaskDetailViewComponent)
