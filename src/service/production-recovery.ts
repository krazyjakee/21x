import type { DatabaseManager } from '../main/database/manager'
import { DurableStartQueueStore } from '../main/sessions/start-queue-store'
import { ProviderRecoveryStore } from '../main/sessions/provider-recovery-store'
import { CaptainRuntimeStore } from '../main/sessions/runtime-store'
import { TaskStatus } from '../shared/constants'

export const PRODUCTION_RESTART_REVIEW = 'production_restart_review'
const guidance = 'The production owner restarted. Inspect saved output and external outcomes, then explicitly continue. Previous process claims do not authorize another dispatch.'

/** Called synchronously under the profile lock, before constructing any effect
 * owner. A backend/session ID is evidence, never permission to replay work or
 * kill a process. This policy belongs only to the production Tauri bootstrap. */
export function reconcileProductionRestart(source: DatabaseManager): { tasks: number; starts: number; deliveries: number; providers: number; captains: number } {
  return source.db.transaction(() => {
    const queue = new DurableStartQueueStore(source)
    const providers = new ProviderRecoveryStore(source)
    const captains = new CaptainRuntimeStore(source)
    const starts = queue.active()
    const pendingProviders = providers.list()
    const pendingCaptains = captains.list().filter(row => ['starting_server', 'starting_session', 'verifying', 'retrying', 'recovering', 'healthy'].includes(row.phase))
    // Do not use lease expiry: no previous process lease can be owned here.
    const deliveries = source.db.prepare("SELECT id, task_id, project_id FROM delivery_outbox WHERE state IN ('pending', 'claimed')").all() as Array<{ id: string; task_id: string | null; project_id: string | null }>
    const affected = new Set((source.db.prepare('SELECT id FROM tasks WHERE status IN (?, ?)').all(TaskStatus.AgentWorking, TaskStatus.Triaging) as Array<{ id: string }>).map(row => row.id))
    for (const row of starts) affected.add(row.taskId)
    for (const row of pendingProviders) affected.add(row.taskId)
    for (const row of pendingCaptains) affected.add(row.ownerId)
    for (const row of deliveries) if (row.task_id) affected.add(row.task_id)

    // A flagged ancestor can automatically select the same interrupted child
    // again, even when the child's own flag is false. Pause that chain too.
    const paused = new Set(affected)
    for (const id of paused) {
      const task = source.db.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(id) as { parent_task_id: string | null } | undefined
      if (task?.parent_task_id) paused.add(task.parent_task_id)
    }
    const now = Date.now(), projects = new Set(deliveries.flatMap(row => row.project_id ? [row.project_id] : []))
    for (const id of paused) {
      const task = source.getTask(id)
      if (!task) continue
      projects.add(task.project_id)
      // Retain backend IDs, transcript, assignment and graph/progress evidence.
      // Disable completion too: interrupted work is not reviewed work.
      source.db.prepare(`UPDATE tasks SET status = CASE WHEN status IN (?, ?) THEN ? ELSE status END,
        auto_start_agent=0, auto_complete_without_review=0, updated_at=? WHERE id=?`)
        .run(TaskStatus.AgentWorking, TaskStatus.Triaging, TaskStatus.NotStarted, new Date(now).toISOString(), id)
      if (affected.has(id) && task.role !== 'captain') {
        if (!queue.get(id)) queue.enqueue({ taskId: id, projectId: task.project_id, agentId: task.agent_id ?? 'unassigned',
          priority: task.priority, reason: 'recovery', queuedAt: new Date(now).toISOString() })
        queue.fail(id, PRODUCTION_RESTART_REVIEW, 'explicit_continuation_required', guidance)
      }
    }
    // Generation changes fence late provider acknowledgements. Delivery and
    // queue terminal states also prevent a reused idempotency key from replay.
    for (const row of pendingProviders) providers.change(row, { state: 'failed', nextRetryAt: null, cause: guidance })
    for (const row of pendingCaptains) captains.transition(row.ownerId, row.generation, 'failed', {
      deadlineAt: null, probeOk: false, errorCode: 'RESTART_REVIEW_REQUIRED', errorDetail: guidance })
    source.db.prepare(`UPDATE delivery_outbox SET state='cancelled', claim_owner=NULL,
      claim_expires_at=NULL, last_error=?, updated_at=? WHERE state IN ('pending', 'claimed')`).run(guidance, now)
    // Accepted receipts remain accepted: existing reconciliation may acknowledge
    // them locally, but must never dispatch their payload again.
    for (const projectId of projects) source.appendProjectStatusJournal(projectId, {
      summary: 'Production restart paused interrupted work for explicit review.', blockers: [guidance],
      decisions: ['Old start, message and provider retry authority retired; saved sessions and external outcomes retained.',
        'Automatic start/completion paused for affected tasks and their parent chains. Inspect outcomes before explicitly continuing or re-enabling automation.']
    }, { source: 'system_recovery' })
    return { tasks: affected.size, starts: starts.length, deliveries: deliveries.length, providers: pendingProviders.length, captains: pendingCaptains.length }
  })()
}
