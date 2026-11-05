import { afterEach, describe, expect, it } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { applySchema } from './schema'

const fixtures: ReturnType<typeof createPortableDbFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.db.close()) })

const PULL_REQUEST = { repo: 'krazyjakee/21x', pr_number: 7, head_sha: 'head', base_sha: 'base' }

/** Two agents, the tasks they worked on, and a finished review between them. */
function reviewed() {
  const fixture = createPortableDbFixture(); fixtures.push(fixture)
  const { db } = fixture
  const author = db.createAgent({ name: 'Author' })!
  const reviewer = db.createAgent({ name: 'Reviewer' })!
  const implementation = db.createTask({ title: 'Build it' })!
  const review = db.createTask({ title: 'Review it' })!
  const ids = {
    project_id: implementation.project_id!, ...PULL_REQUEST,
    implementation_task_id: implementation.id, review_task_id: review.id,
    implementation_agent_id: author.id, reviewer_agent_id: reviewer.id
  }
  const handoff = db.createPullRequestReviewHandoff(ids)!
  const attestation = db.createPullRequestReviewAttestation({ ...ids, handoff_id: handoff.id, verdict: 'CLEAN', summary: 'Looks right' })!
  return { ...fixture, author, reviewer, implementation, handoff, attestation }
}

const OLD_TABLES = `
  DROP INDEX IF EXISTS idx_pr_review_attestations_handoff;
  DROP TABLE pr_review_attestations;
  DROP TABLE pr_review_handoffs;
  CREATE TABLE pr_review_handoffs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
    implementation_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    implementation_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_pr_review_handoffs_exact ON pr_review_handoffs(project_id, repo, pr_number, head_sha, base_sha, created_at DESC);
  CREATE TABLE pr_review_attestations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
    implementation_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    implementation_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    verdict TEXT NOT NULL CHECK (verdict IN ('CLEAN', 'CHANGES_REQUIRED')),
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  , handoff_id TEXT REFERENCES pr_review_handoffs(id) ON DELETE RESTRICT);
  CREATE INDEX idx_pr_review_attestations_exact ON pr_review_attestations(project_id, repo, pr_number, head_sha, base_sha, created_at DESC);
  CREATE INDEX idx_pr_review_attestations_handoff ON pr_review_attestations(handoff_id);
`

describe('deleting an agent that has PR reviews on record', () => {
  it('deletes the agent and keeps the review evidence intact', () => {
    const { db, rawDb, reviewer, attestation, handoff } = reviewed()
    expect(db.deleteAgent(reviewer.id)).toBe(true)
    expect(db.getAgent(reviewer.id)).toBeUndefined()
    expect(rawDb.prepare('SELECT * FROM pr_review_attestations WHERE id = ?').get(attestation.id)).toEqual(attestation)
    expect(rawDb.prepare('SELECT * FROM pr_review_handoffs WHERE id = ?').get(handoff.id)).toEqual(handoff)
  })

  it('still will not delete a task a review points at', () => {
    const { db, rawDb, implementation } = reviewed()
    expect(() => rawDb.prepare('DELETE FROM tasks WHERE id = ?').run(implementation.id)).toThrow(/FOREIGN KEY/)
    expect(db.getTask(implementation.id)).toBeTruthy()
  })
})

describe('v39 review reference migration', () => {
  function upgraded() {
    const fixture = reviewed()
    const { db, rawDb, attestation, handoff } = fixture
    const handoffs = rawDb.prepare('SELECT * FROM pr_review_handoffs').all() as Record<string, unknown>[]
    const attestations = rawDb.prepare('SELECT * FROM pr_review_attestations').all() as Record<string, unknown>[]
    rawDb.pragma('foreign_keys = OFF')
    rawDb.exec(OLD_TABLES)
    rawDb.pragma('foreign_keys = ON')
    const insert = (table: string, row: Record<string, unknown>): void => {
      const columns = Object.keys(row)
      rawDb.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row) as never[])
    }
    handoffs.forEach(row => insert('pr_review_handoffs', row))
    attestations.forEach(row => insert('pr_review_attestations', row))
    // Real installs hold attestations older than handoffs, with no handoff id.
    insert('pr_review_attestations', { ...attestations[0], id: 'before-handoffs', handoff_id: null })
    rawDb.prepare(`INSERT INTO pr_readiness_snapshots
      (id, project_id, repo, pr_number, head_sha, base_sha, state_fingerprint, classification, attestation_id, created_at)
      VALUES ('snapshot', ?, ?, 7, 'head', 'base', 'fingerprint', 'ready', ?, 'now')`)
      .run(attestation.project_id, PULL_REQUEST.repo, attestation.id)
    expect(() => rawDb.prepare('DELETE FROM agents WHERE id = ?').run(fixture.reviewer.id)).toThrow(/FOREIGN KEY/)
    db.setSetting('__schema_version', '38')
    expect(applySchema(rawDb)).toBe(true)
    return { ...fixture, attestation, handoff }
  }

  it('lets the agent go and keeps every record, including one with no handoff', () => {
    const { db, rawDb, reviewer, attestation } = upgraded()
    expect(db.getSetting('__schema_version')).toBe('40')
    expect(db.deleteAgent(reviewer.id)).toBe(true)
    expect(rawDb.prepare('SELECT id FROM pr_review_attestations ORDER BY id').all()).toEqual(
      [{ id: 'before-handoffs' }, { id: attestation.id }].sort((a, b) => a.id.localeCompare(b.id)))
    expect(rawDb.prepare('SELECT * FROM pr_review_attestations WHERE id = ?').get(attestation.id)).toEqual(attestation)
    expect(rawDb.prepare('SELECT handoff_id FROM pr_review_attestations WHERE id = ?').get('before-handoffs')).toEqual({ handoff_id: null })
  })

  it('leaves links into these tables and their indexes in place', () => {
    const { rawDb, attestation } = upgraded()
    expect(rawDb.prepare('SELECT attestation_id FROM pr_readiness_snapshots WHERE id = ?').get('snapshot')).toEqual({ attestation_id: attestation.id })
    const indexes = (rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name LIKE 'pr_review_%'").all() as { name: string }[]).map(row => row.name).sort()
    expect(indexes).toEqual(['idx_pr_review_attestations_exact', 'idx_pr_review_attestations_handoff', 'idx_pr_review_handoffs_exact'])
    expect(rawDb.pragma('foreign_key_check')).toEqual([])
  })

  it('leaves foreign keys on and runs once', () => {
    const { rawDb } = upgraded()
    expect(rawDb.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(applySchema(rawDb)).toBe(false)
  })
})
