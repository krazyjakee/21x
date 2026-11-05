import { afterEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { TaskStatus } from '../../shared/constants'
import { CHAT_SETTING_KEYS } from '../../shared/chat'
import { captainSessionAgentKey } from '../../shared/agent-deletion'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
function fixture() {
  const db = createPortableTestDb(); databases.push(db)
  for (const agent of db.getAgents()) db.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id)
  const doomed = db.createAgent({ name: 'Doomed', is_default: true })!
  const kept = db.createAgent({ name: 'Kept', config: { coding_agent: 'codex', fallback_agent_ids: [doomed.id] } })!
  const project = db.createProject({ name: 'Work' })!
  const task = (title: string, fields: Record<string, unknown> = {}) => {
    const created = db.createTask({ title, project_id: project.id, repos: ['owner/repo'] })!
    db.updateTask(created.id, { agent_id: doomed.id, ...fields })
    return created
  }
  return { db, doomed, kept, project, task }
}

describe('deleting an agent', () => {
  it('previews and reports the same thing, and the preview changes nothing', () => {
    const h = fixture(); const open = h.task('Open work')
    const preview = h.db.getAgentDeletionImpact(h.doomed.id)!
    expect(h.db.getAgent(h.doomed.id)).toBeDefined(); expect(h.db.getTask(open.id)?.agent_id).toBe(h.doomed.id)
    expect(h.db.removeAgent(h.doomed.id)).toEqual(preview)
    expect(h.db.removeAgent(h.doomed.id)).toBe(false)
  })

  it('keeps affected tasks visible and unassigned, and leaves completed history out of the report', () => {
    const h = fixture(); const open = h.task('Open work'); const done = h.task('Done work', { status: TaskStatus.Completed })
    const report = h.db.removeAgent(h.doomed.id)
    expect(report).toMatchObject({ unassigned_tasks: { total: 1, items: [{ id: open.id, title: 'Open work' }] } })
    expect(h.db.getTask(open.id)).toMatchObject({ agent_id: null, status: TaskStatus.NotStarted })
    expect(h.db.getTask(done.id)).toMatchObject({ agent_id: null, status: TaskStatus.Completed })
    expect(h.db.getTasks({ projectId: h.project.id }).map(row => row.id)).toContain(open.id)
  })

  it('reports a recurring auto-start schedule, the case that used to lose its agent silently', () => {
    const h = fixture()
    const recurring = h.task('Nightly', { is_recurring: true, recurrence_pattern: '0 3 * * *', auto_start_agent: true })
    expect(h.db.removeAgent(h.doomed.id)).toMatchObject({ recurring_tasks: { total: 1 }, recurring_auto_start: 1, unassigned_tasks: { total: 0 } })
    expect(h.db.getTask(recurring.id)).toMatchObject({ agent_id: null, auto_start_agent: true })
  })

  it('settles a task that only claims to be worked on, so it cannot look busy for ever', () => {
    const h = fixture()
    const working = h.task('Lost in a crash', { status: TaskStatus.AgentWorking, session_id: 'gone' })
    const learning = h.task('Was learning', { status: TaskStatus.AgentLearning })
    h.db.removeAgent(h.doomed.id)
    expect(h.db.getTask(working.id)).toMatchObject({ status: TaskStatus.NotStarted, session_id: null })
    expect(h.db.getTask(learning.id)?.status).toBe(TaskStatus.ReadyForReview)
  })

  it('dissolves an active group whatever its status, returning its tasks to the board', () => {
    const h = fixture(); const tasks = [h.task('One'), h.task('Two')]
    const group = h.db.createTaskGroup({ title: 'Batch', task_ids: tasks.map(row => row.id), agent_id: h.doomed.id })
    h.db.updateTask(group.execution_task_id, { status: TaskStatus.AgentWorking })
    expect(h.db.removeAgent(h.doomed.id)).toMatchObject({ dissolved_groups: { total: 1, items: [{ id: group.id, title: 'Batch' }] } })
    expect(h.db.getTaskGroup(group.id)?.state).toBe('dissolved')
    for (const task of tasks) expect(h.db.getTask(task.id)).toMatchObject({ group_id: null, agent_id: null, status: TaskStatus.NotStarted })
  })

  it('leaves no pointer in fallback lists, project columns, concurrency, Commander or settings', () => {
    const h = fixture()
    const other = h.db.createProject({ name: 'Other', default_agent_id: h.doomed.id, captain_agent_id: h.doomed.id })!
    const concurrency = { captain_control: false, levels: { [h.doomed.id]: 2, [h.kept.id]: 3 }, pinned: { [h.doomed.id]: 1 } }
    h.db.updateProject(other.id, { settings: { concurrency, limits: { keep: true } } })
    h.db.setSetting(CHAT_SETTING_KEYS.agentId, h.doomed.id)
    expect(h.db.removeAgent(h.doomed.id)).toMatchObject({ commander_cleared: true, fallback_agents: { total: 1 }, default_projects: { total: 1 }, concurrency_projects: { total: 1 } })
    expect(h.db.getAgent(h.kept.id)?.config.fallback_agent_ids).toEqual([])
    expect(h.db.getProject(other.id)).toMatchObject({ default_agent_id: null, captain_agent_id: null })
    expect(h.db.getProject(other.id)?.settings).toEqual({ concurrency: { captain_control: false, levels: { [h.kept.id]: 3 }, pinned: {} }, limits: { keep: true } })
    expect(h.db.getSetting(CHAT_SETTING_KEYS.agentId)).toBe('')
  })

  it('forgets a Captain session with its binding, so the next agent does not resume a foreign session', () => {
    const h = fixture(); const captain = h.db.getCoordinatorTask(h.project.id)!
    h.db.updateTask(captain.id, { session_id: 'doomed-session' })
    h.db.setSetting(captainSessionAgentKey(captain.id), h.doomed.id)
    h.db.removeAgent(h.doomed.id)
    expect(h.db.getTask(captain.id)?.session_id).toBeNull()
    expect(h.db.getSetting(captainSessionAgentKey(captain.id))).toBeFalsy()
  })

  it('withdraws a start left active for the agent, which would otherwise block CLI changes', () => {
    const h = fixture(); const queued = h.task('Queued')
    h.db.db.prepare(`INSERT INTO agent_start_queue (id, task_id, project_id, agent_id, admission_reason, fifo_seq, created_at, queued_at, updated_at)
      VALUES ('row', ?, ?, ?, 'agent_limit', 1, 1, 1, 1)`).run(queued.id, h.project.id, h.doomed.id)
    h.db.removeAgent(h.doomed.id)
    expect(h.db.db.prepare('SELECT state, recovery_cause FROM agent_start_queue WHERE id = ?').get('row')).toEqual({ state: 'cancelled', recovery_cause: 'agent_deleted' })
  })

  it('promotes the next agent when the default goes, and says so', () => {
    const h = fixture(); h.db.setSetting('default_agent_id', h.doomed.id)
    expect(h.db.removeAgent(h.doomed.id)).toMatchObject({ was_default: true, replacement_default: { id: h.kept.id, name: 'Kept' }, last_agent: false })
    expect(h.db.getAgent(h.kept.id)?.is_default).toBe(true)
    expect(h.db.getSetting('default_agent_id')).toBe(h.kept.id)
  })

  it('allows deleting the last agent and leaves its tasks unassigned', () => {
    const h = fixture(); const open = h.task('Open work')
    h.db.removeAgent(h.kept.id)
    expect(h.db.removeAgent(h.doomed.id)).toMatchObject({ last_agent: true, replacement_default: null })
    expect(h.db.getAgents()).toEqual([]); expect(h.db.getTask(open.id)?.agent_id).toBeNull()
  })

  it('deletes an agent that signed a PR review and keeps the review record, which still blocks a merge', () => {
    const h = fixture(); const work = h.task('Work'); const review = h.task('Review'); h.db.updateTask(work.id, { agent_id: h.kept.id })
    const handoff = h.db.createPullRequestReviewHandoff({ project_id: h.project.id, repo: 'owner/repo', pr_number: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
      implementation_task_id: work.id, review_task_id: review.id, implementation_agent_id: h.kept.id, reviewer_agent_id: h.doomed.id })!
    expect(h.db.removeAgent(h.doomed.id)).not.toBe(false)
    expect(h.db.db.prepare('SELECT reviewer_agent_id FROM pr_review_handoffs WHERE id = ?').get(handoff.id)).toEqual({ reviewer_agent_id: h.doomed.id })
  })

  it('rolls everything back when one step fails, leaving the agent exactly as it was', () => {
    const h = fixture(); const open = h.task('Open work')
    h.db.db.exec("CREATE TRIGGER refuse BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'refused'); END")
    expect(() => h.db.removeAgent(h.doomed.id)).toThrow('refused')
    expect(h.db.getAgent(h.kept.id)?.config.fallback_agent_ids).toEqual([h.doomed.id])
    expect(h.db.getTask(open.id)?.agent_id).toBe(h.doomed.id)
  })

  it('journals the change in each affected project, so it outlives the dialog', () => {
    const h = fixture(); h.task('Open work')
    h.db.removeAgent(h.doomed.id)
    const row = h.db.db.prepare('SELECT summary, decisions FROM project_status_journal WHERE project_id = ?').get(h.project.id) as { summary: string; decisions: string }
    expect(row.summary).toContain('“Doomed”'); expect(row.decisions).toContain('Open work')
  })
})
