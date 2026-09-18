import { TaskStatus } from '@shared/constants'
import type { SessionActions } from './TaskPropertiesGrid'

const PRIMARY_BTN_CLASS =
  'w-full inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 active:opacity-60 rounded-md px-4 py-2.5 text-sm font-medium'
const SECONDARY_BTN_CLASS =
  'w-full inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium active:opacity-60 border border-border bg-transparent text-foreground hover:bg-accent'

interface AgentAction { label: string; onClick: () => void; testId: string }

function PlayIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  )
}

/**
 * State-aware primary CTA. Usually the happy path is to move the task forward
 * with an agent action (Start > Resume > Triage beats the always-available
 * Complete). In ReadyForReview it flips: the user is reviewing the agent's
 * result, so Complete is primary and the agent action stays visible as a
 * secondary "needs another pass" affordance — even when canComplete is false
 * (e.g. output fields not yet filled).
 */
export function TaskPrimaryCta({ status, actions, canComplete, onComplete }: {
  status: string
  actions: Pick<SessionActions, 'canStart' | 'canResume' | 'canTriage' | 'onStart' | 'onResume' | 'onTriage'>
  canComplete: boolean
  onComplete: () => void
}) {
  const { canStart, canResume, canTriage } = actions
  if (!canStart && !canResume && !canTriage && !canComplete) return null

  let agentAction: AgentAction | null = null
  if (canStart) agentAction = { label: 'Start Task', onClick: actions.onStart, testId: 'main-cta-start' }
  else if (canResume) agentAction = { label: 'Resume Session', onClick: actions.onResume, testId: 'main-cta-resume' }
  else if (canTriage) agentAction = { label: 'Triage', onClick: actions.onTriage, testId: 'main-cta-triage' }

  const isReadyForReview = status === TaskStatus.ReadyForReview
  const agentActionIsPrimary = !!agentAction && !isReadyForReview
  const completeIsPrimary = canComplete && (!agentAction || isReadyForReview)

  const agentButton = agentAction && (
    <button
      onClick={agentAction.onClick}
      data-testid={agentAction.testId}
      className={agentActionIsPrimary ? PRIMARY_BTN_CLASS : SECONDARY_BTN_CLASS}
    >
      <PlayIcon />
      {agentAction.label}
    </button>
  )

  return (
    <div className="px-4 py-4 flex flex-col gap-2 border-b border-border">
      {agentActionIsPrimary && agentButton}
      {canComplete && (
        <button
          onClick={onComplete}
          data-testid="main-cta-complete"
          className={completeIsPrimary ? PRIMARY_BTN_CLASS : SECONDARY_BTN_CLASS}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Complete Task
        </button>
      )}
      {!agentActionIsPrimary && agentButton}
    </div>
  )
}
