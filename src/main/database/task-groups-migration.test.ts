import { afterEach, describe, expect, it } from 'vitest'
import { createPortableDbFixture } from '../../../test/helpers/portable-db-test-helper'
import { applySchema } from './schema'
import { migrateTaskGroups } from './task-groups-migration'

const fixtures: ReturnType<typeof createPortableDbFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.db.close()) })

describe('v37 task group migration', () => {
  it('upgrades installed v36 once without changing task or transcript ownership', () => {
    const fixture = createPortableDbFixture(); fixtures.push(fixture)
    const { db, rawDb } = fixture
    const agent = db.createAgent({ name: 'Retained agent' })!
    const task = db.createTask({ title: 'Existing work' })!
    db.updateTask(task.id, { agent_id: agent.id, session_id: 'retained-native' })
    db.upsertTranscriptParts(task.id, [{ id: 'existing-result', role: 'assistant', content: 'Retain this result' }])
    const original = db.getTranscriptParts(task.id)
    rawDb.exec('DROP INDEX idx_tasks_group; ALTER TABLE tasks DROP COLUMN group_id; DROP TABLE task_group_memberships; DROP TABLE task_groups;')
    db.setSetting('__schema_version', '36')
    expect(applySchema(rawDb)).toBe(true)
    expect(db.getSetting('__schema_version')).toBe('37')
    expect(db.getTask(task.id)).toMatchObject({ agent_id: agent.id, session_id: 'retained-native', group_id: null })
    expect(db.getTranscriptParts(task.id)).toEqual(original)
    expect(db.listTaskGroups(task.project_id)).toEqual([])
    expect(applySchema(rawDb)).toBe(false)
    expect(rawDb.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps group constraints and retained membership episodes identical on fresh and repeated migrations', () => {
    const fixture = createPortableDbFixture(); fixtures.push(fixture)
    const { db, rawDb } = fixture
    const agent = db.createAgent({ name: 'Default', is_default: true })!
    const tasks = [db.createTask({ title: 'First' })!, db.createTask({ title: 'Second' })!]
    const group = db.createTaskGroup({ title: 'Together', task_ids: tasks.map(task => task.id), agent_id: agent.id })
    migrateTaskGroups(rawDb); migrateTaskGroups(rawDb)
    expect(db.getTaskGroup(group.id)).toEqual(group)
    expect(() => rawDb.prepare(`INSERT INTO task_group_memberships (id,group_id,task_id,position,joined_at,progress_updated_at)
      VALUES ('duplicate',?,?,0,'now','now')`).run(group.id, tasks[0].id)).toThrow(/UNIQUE/)
    expect(() => rawDb.prepare("UPDATE task_group_memberships SET progress_state='approved'").run()).toThrow(/CHECK/)
    expect(() => rawDb.prepare('DELETE FROM tasks WHERE id=?').run(group.execution_task_id)).toThrow(/FOREIGN KEY/)
    expect(rawDb.pragma('foreign_key_check')).toEqual([])
  })
})
