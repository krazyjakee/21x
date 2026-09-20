import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { callToolForScope, type TaskApiInvoke, type TaskMcpScope } from './mcp-servers/task-management-core'
import { handleRoute } from './task-api-server'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) }
}))

const PR_URL = 'https://github.com/acme/app/pull/12'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function setup() {
  const { db } = createTestDb()
  const project = db.createProject({ name: 'App' })!
  db.addProjectRepo(project.id, { provider: 'github', org: 'acme', name: 'app' })
  const implementer = db.createAgent({ name: 'Implementer' })!
  const reviewer = db.createAgent({ name: 'Reviewer' })!
  const implementation = db.createTask({ title: 'Implement', type: 'coding', project_id: project.id })!
  const review = db.createTask({ title: 'Security review', type: 'review', labels: ['security'], project_id: project.id })!
  db.updateTask(implementation.id, { agent_id: implementer.id })
  db.updateTask(review.id, { agent_id: reviewer.id })
  const scope: TaskMcpScope = {
    parentTaskId: null,
    taskId: review.id,
    artifactTaskId: review.id,
    projectId: project.id
  }
  const invoke: TaskApiInvoke = (route, params, trustedScope) => handleRoute(db, route, params, trustedScope)
  return { db, project, implementation, review, scope, invoke }
}

describe('record_pull_request_review_attestation', () => {
  it('derives reviewer identity from the signed task scope and records an immutable exact-head attestation', async () => {
    const h = setup()
    const result = await callToolForScope('record_pull_request_review_attestation', {
      implementation_task_id: h.implementation.id,
      pr_url: PR_URL,
      head_sha: HEAD,
      base_sha: BASE,
      verdict: 'CLEAN',
      summary: 'No unresolved P1/P2 findings.'
    }, h.scope, h.invoke)
    expect(result.isError).not.toBe(true)
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(body).toMatchObject({ status: 'recorded', attestation: {
      review_task_id: h.review.id,
      implementation_task_id: h.implementation.id,
      head_sha: HEAD,
      base_sha: BASE,
      verdict: 'CLEAN'
    } })
    expect(h.db.getCleanPullRequestReviewAttestation({
      projectId: h.project.id, repo: 'acme/app', prNumber: 12, headSha: HEAD, baseSha: BASE
    })).toMatchObject({ review_task_id: h.review.id })
  })

  it('refuses Captain and raw HTTP callers because neither has reviewer-task provenance', async () => {
    const h = setup()
    const args = {
      implementation_task_id: h.implementation.id,
      pr_url: PR_URL,
      head_sha: HEAD,
      base_sha: BASE,
      verdict: 'CLEAN'
    }
    const captain = await callToolForScope('record_pull_request_review_attestation', args, {
      parentTaskId: null, taskId: null, artifactTaskId: null, projectId: h.project.id
    }, h.invoke)
    expect(captain.isError).toBe(true)
    expect(await handleRoute(h.db, '/record_pull_request_review_attestation', {
      ...args,
      __review_attestation_scope: { project_id: h.project.id, review_task_id: h.review.id }
    })).toMatchObject({ error: expect.stringContaining('task-scoped reviewer') })
  })

  it('uses the latest auditable verdict so CHANGES_REQUIRED closes the gate and a later CLEAN reopens it', async () => {
    const h = setup()
    const call = (verdict: 'CLEAN' | 'CHANGES_REQUIRED') => callToolForScope('record_pull_request_review_attestation', {
      implementation_task_id: h.implementation.id,
      pr_url: PR_URL,
      head_sha: HEAD,
      base_sha: BASE,
      verdict
    }, h.scope, h.invoke)
    await call('CLEAN')
    expect(h.db.getCleanPullRequestReviewAttestation({
      projectId: h.project.id, repo: 'acme/app', prNumber: 12, headSha: HEAD, baseSha: BASE
    })).toBeTruthy()
    await call('CHANGES_REQUIRED')
    expect(h.db.getCleanPullRequestReviewAttestation({
      projectId: h.project.id, repo: 'acme/app', prNumber: 12, headSha: HEAD, baseSha: BASE
    })).toBeUndefined()
    await call('CLEAN')
    expect(h.db.getCleanPullRequestReviewAttestation({
      projectId: h.project.id, repo: 'acme/app', prNumber: 12, headSha: HEAD, baseSha: BASE
    })).toMatchObject({ verdict: 'CLEAN' })
  })
})
