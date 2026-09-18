import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { LEGACY_MASTERMIND_SKILL_CONTENT, seedOrchestratorSkill } from './seed'
import type { DatabaseManager } from '../database'

/** The seeded "Mastermind" skill is retired: untouched copies go, edited ones stay. */
describe('seedOrchestratorSkill migration', () => {
  let db: DatabaseManager

  function insertSkill(id: string, content: string): void {
    const now = new Date().toISOString()
    db.db.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, is_deleted, created_at, updated_at)
      VALUES (?, 'Mastermind', 'seeded', ?, 1, 0.8, 0, NULL, '[]', 0, ?, ?)
    `).run(id, content, now, now)
  }

  function insertAgent(id: string, skillIds: string[]): void {
    const now = new Date().toISOString()
    db.db.prepare(`
      INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
      VALUES (?, ?, 'http://localhost:4096', ?, 0, ?, ?)
    `).run(id, id, JSON.stringify({ skill_ids: skillIds }), now, now)
  }

  function agentSkillIds(id: string): string[] {
    const row = db.db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string }
    return (JSON.parse(row.config) as { skill_ids: string[] }).skill_ids
  }

  beforeEach(() => {
    ;({ db } = createTestDb())
  })

  it('seeds nothing on a new install', () => {
    insertAgent('agent-a', [])
    seedOrchestratorSkill(db.db)
    expect(db.db.prepare("SELECT id FROM skills WHERE name = 'Mastermind'").all()).toEqual([])
    expect(agentSkillIds('agent-a')).toEqual([])
  })

  it('removes an unchanged seeded skill and detaches it from every agent', () => {
    insertSkill('skill-mm', LEGACY_MASTERMIND_SKILL_CONTENT)
    insertSkill('skill-other', '# Other')
    insertAgent('agent-a', ['skill-mm', 'skill-other'])
    insertAgent('agent-b', ['skill-other'])

    seedOrchestratorSkill(db.db)
    seedOrchestratorSkill(db.db)

    expect(db.getSkill('skill-mm')).toBeUndefined()
    expect(db.getSkill('skill-other')).toBeDefined()
    expect(agentSkillIds('agent-a')).toEqual(['skill-other'])
    expect(agentSkillIds('agent-b')).toEqual(['skill-other'])
  })

  it('keeps an edited copy as a user skill, still attached', () => {
    insertSkill('skill-mm', `${LEGACY_MASTERMIND_SKILL_CONTENT}\n\nAlways label UI work "frontend".`)
    insertAgent('agent-a', ['skill-mm'])

    seedOrchestratorSkill(db.db)

    expect(db.getSkill('skill-mm')?.content).toContain('Always label UI work')
    expect(agentSkillIds('agent-a')).toEqual(['skill-mm'])
  })
})
