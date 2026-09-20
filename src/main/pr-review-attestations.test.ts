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
  const implementationNonce = db.rotateTaskMcpScopeNonce(implementation.id)
  const reviewNonce = db.rotateTaskMcpScopeNonce(review.id)
  const scope: TaskMcpScope = {
    parentTaskId: null,
    taskId: review.id,
    artifactTaskId: review.id,
    projectId: project.id,
    agentId: reviewer.id,
    sessionNonce: reviewNonce
  }
  const implementationScope: TaskMcpScope = {
    parentTaskId: null,
    taskId: implementation.id,
    artifactTaskId: implementation.id,
    projectId: project.id,
    agentId: implementer.id,
    sessionNonce: implementationNonce
  }
  const invoke: TaskApiInvoke = (route, params, trustedScope) => handleRoute(db, route, params, trustedScope)
  return { db, project, implementer, reviewer, implementation, review, scope, implementationScope, invoke }
}

async function handoff(h: ReturnType<typeof setup>, reviewTaskId = h.review.id) {
  return callToolForScope('create_pull_request_review_handoff', {
    review_task_id: reviewTaskId,
    pr_url: PR_URL,
    head_sha: HEAD,
    base_sha: BASE
  }, h.implementationScope, h.invoke)
}

async function attest(h: ReturnType<typeof setup>, implementationTaskId = h.implementation.id) {
  return callToolForScope('record_pull_request_review_attestation', {
    implementation_task_id: implementationTaskId,
    pr_url: PR_URL,
    head_sha: HEAD,
    base_sha: BASE,
    verdict: 'CLEAN',
    summary: 'No unresolved P1/P2 findings.'
  }, h.scope, h.invoke)
}

describe('record_pull_request_review_attestation', () => {
  it('derives reviewer identity from the signed task scope and records an immutable exact-head attestation', async () => {
    const h = setup()
    expect((await handoff(h)).isError).not.toBe(true)
    const result = await attest(h)
    expect(result.isError).not.toBe(true)
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(body).toMatchObject({ status: 'recorded', attestation: {
      review_task_id: h.review.id,
      implementation_task_id: h.implementation.id,
      head_sha: HEAD,
      base_sha: BASE,
      verdict: 'CLEAN',
      handoff_id: expect.any(String),
      implementation_agent_id: h.implementer.id,
      reviewer_agent_id: h.reviewer.id
    } })
    expect(h.db.getCleanPullRequestReviewAttestation({
      projectId: h.project.id, repo: 'acme/app', prNumber: 12, headSha: HEAD, baseSha: BASE
    })).toMatchObject({ review_task_id: h.review.id })
  })

  it('refuses Captain and raw HTTP callers because neither has reviewer-task provenance', async () => {
    const h = setup()
    await handoff(h)
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
    })).toMatchObject({ error: expect.stringContaining('task-, agent-, and session-scoped') })
  })

  it('uses the latest auditable verdict so CHANGES_REQUIRED closes the gate and a later CLEAN reopens it', async () => {
    const h = setup()
    await handoff(h)
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

  it('rejects a mutable reviewer assignment instead of letting it impersonate the handed-off agent', async () => {
    const h = setup()
    expect((await handoff(h)).isError).not.toBe(true)
    const replacement = h.db.createAgent({ name: 'Replacement reviewer' })!
    h.db.updateTask(h.review.id, { agent_id: replacement.id })

    expect((await attest(h)).isError).toBe(true)
    const replacementScope = { ...h.scope, agentId: replacement.id }
    const replacementAttempt = await callToolForScope('record_pull_request_review_attestation', {
      implementation_task_id: h.implementation.id,
      pr_url: PR_URL,
      head_sha: HEAD,
      base_sha: BASE,
      verdict: 'CLEAN'
    }, replacementScope, h.invoke)
    expect(replacementAttempt.isError).toBe(true)
    expect(replacementAttempt.content[0].text).toContain('does not match the agent named by the exact-head handoff')
  })

  it('invalidates signed review credentials when either task session is replaced', async () => {
    const h = setup()
    h.db.rotateTaskMcpScopeNonce(h.implementation.id)
    const staleHandoff = await handoff(h)
    expect(staleHandoff.isError).toBe(true)
    expect(staleHandoff.content[0].text).toContain('stale or has been replaced')

    const freshImplementationScope = {
      ...h.implementationScope,
      sessionNonce: h.db.getTaskMcpScopeNonce(h.implementation.id)
    }
    const handedOff = await callToolForScope('create_pull_request_review_handoff', {
      review_task_id: h.review.id,
      pr_url: PR_URL,
      head_sha: HEAD,
      base_sha: BASE
    }, freshImplementationScope, h.invoke)
    expect(handedOff.isError).not.toBe(true)

    h.db.rotateTaskMcpScopeNonce(h.review.id)
    const staleAttestation = await attest(h)
    expect(staleAttestation.isError).toBe(true)
    expect(staleAttestation.content[0].text).toContain('stale or has been replaced')
  })

  it('rejects a caller-selected unrelated implementation task without its own signed handoff', async () => {
    const h = setup()
    await handoff(h)
    const unrelatedAgent = h.db.createAgent({ name: 'Unrelated implementer' })!
    const unrelated = h.db.createTask({ title: 'Unrelated work', type: 'coding', project_id: h.project.id })!
    h.db.updateTask(unrelated.id, { agent_id: unrelatedAgent.id })

    const result = await attest(h, unrelated.id)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No signed exact-head handoff')
  })

  it('allows a top-level task scope carrying a signed agent identity to create and consume a handoff', async () => {
    const h = setup()
    expect(h.implementation.parent_task_id).toBeNull()
    expect(h.review.parent_task_id).toBeNull()
    expect((await handoff(h)).isError).not.toBe(true)
    expect((await attest(h)).isError).not.toBe(true)
  })
})
