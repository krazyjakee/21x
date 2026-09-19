// Scope (#74): skills.project_id is null for a global skill and a project id
// for a project skill. Reads take a SkillListFilter; the access policy (who
// may see, create, change or move a skill) lives with the callers:
// skill-routes.ts for sessions, commander/skill-tools.ts for the Commander.
import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { deserializeSkill, normalizePreferredModel } from './serializers'
import { SkillVersionConflictError, type CreateSkillData, type SkillListFilter, type SkillRecord, type SkillRow, type UpdateSkillData } from './types'

export function getSkills(m: DatabaseManager, filter?: SkillListFilter): SkillRecord[] {
  const clauses = ['is_deleted = 0']
  const params: string[] = []
  if (filter?.visibleToProject !== undefined) {
    clauses.push('(project_id IS NULL OR project_id = ?)')
    params.push(filter.visibleToProject)
  }
  if (filter?.scope !== undefined) {
    if (filter.scope === null) clauses.push('project_id IS NULL')
    else { clauses.push('project_id = ?'); params.push(filter.scope) }
  }
  const rows = m.prepare(
    `SELECT * FROM skills WHERE ${clauses.join(' AND ')} ORDER BY name ASC`
  ).all(...params) as SkillRow[]
  return rows.map(deserializeSkill)
}

export function getSkill(m: DatabaseManager, id: string): SkillRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM skills WHERE id = ? AND is_deleted = 0'
  ).get(id) as SkillRow | undefined
  return row ? deserializeSkill(row) : undefined
}

/** The named skills; with `visibleToProject`, only the global ones and that project's own. */
export function getSkillsByIds(m: DatabaseManager, ids: string[], visibleToProject?: string): SkillRecord[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const scope = visibleToProject !== undefined ? ' AND (project_id IS NULL OR project_id = ?)' : ''
  const rows = m.db.prepare(
    `SELECT * FROM skills WHERE id IN (${placeholders}) AND is_deleted = 0${scope} ORDER BY name ASC`
  ).all(...ids, ...(visibleToProject !== undefined ? [visibleToProject] : [])) as SkillRow[]
  return rows.map(deserializeSkill)
}

export function createSkill(m: DatabaseManager, data: CreateSkillData): SkillRecord | undefined {
  const id = createId()
  const now = new Date().toISOString()
  const confidence = data.confidence ?? 0.5
  const uses = data.uses ?? 0
  const lastUsed = data.last_used ?? null
  const tags = JSON.stringify(data.tags ?? [])
  const preferredModel = normalizePreferredModel(data.preferred_model)
  const projectId = data.project_id || null
  m.prepare(`
    INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, preferred_model, project_id, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, data.name, data.description, data.content, confidence, uses, lastUsed, tags, preferredModel, projectId, now, now)
  return getSkill(m, id)
}

/**
 * Field updates. Throws SkillVersionConflictError when `expected_version`
 * is given and a content change would overwrite a newer version.
 */
export function updateSkill(m: DatabaseManager, id: string, data: UpdateSkillData): SkillRecord | undefined {
  const existing = getSkill(m, id)
  if (!existing) return undefined

  const setClauses: string[] = []
  const values: (string | number | null)[] = []

  if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
  if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
  if (data.content !== undefined) { setClauses.push('content = ?'); values.push(data.content) }
  if (data.confidence !== undefined) { setClauses.push('confidence = ?'); values.push(data.confidence) }
  if (data.uses !== undefined) { setClauses.push('uses = ?'); values.push(data.uses) }
  if (data.last_used !== undefined) { setClauses.push('last_used = ?'); values.push(data.last_used) }
  if (data.tags !== undefined) { setClauses.push('tags = ?'); values.push(JSON.stringify(data.tags)) }
  if (data.preferred_model !== undefined) {
    setClauses.push('preferred_model = ?'); values.push(normalizePreferredModel(data.preferred_model))
  }

  if (setClauses.length === 0) return existing

  // Only increment version for content changes, not usage updates (uses / last_used)
  const isContentChange = data.name !== undefined || data.description !== undefined ||
    data.content !== undefined || data.confidence !== undefined || data.tags !== undefined ||
    data.preferred_model !== undefined
  if (isContentChange && data.expected_version !== undefined && data.expected_version !== existing.version) {
    throw new SkillVersionConflictError(id, existing.version, data.expected_version)
  }
  if (isContentChange) {
    setClauses.push('version = version + 1')
  }
  // `updated_at` means "when the content last changed", so usage updates
  // leave it alone.
  if (isContentChange) {
    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
  }
  values.push(id)

  // The version guard is re-checked in the statement itself, so two writers
  // that both read the same version cannot both get through.
  const guard = isContentChange && data.expected_version !== undefined ? ' AND version = ?' : ''
  if (guard) values.push(data.expected_version as number)
  const changed = m.db.prepare(
    `UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?${guard}`
  ).run(...values).changes
  if (guard && changed === 0) {
    const current = getSkill(m, id)
    throw new SkillVersionConflictError(id, current?.version ?? existing.version, data.expected_version as number)
  }

  return getSkill(m, id)
}

/**
 * Moves a skill to a project (an id) or promotes it to global (null). The
 * explicit scope change of #74: not part of updateSkill, so a plain field
 * update can never change who sees a skill. Bumps the version.
 */
export function setSkillProject(m: DatabaseManager, id: string, projectId: string | null): SkillRecord | undefined {
  const existing = getSkill(m, id)
  if (!existing) return undefined
  const next = projectId || null
  if (existing.project_id === next) return existing
  m.prepare(
    'UPDATE skills SET project_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
  ).run(next, new Date().toISOString(), id)
  return getSkill(m, id)
}

/** Tasks (any project, any status) whose skill_ids name the skill; for scope-move validation. */
export function getTasksUsingSkill(m: DatabaseManager, skillId: string): Array<{ id: string; title: string; project_id: string }> {
  const rows = m.prepare(
    'SELECT id, title, project_id, skill_ids FROM tasks WHERE skill_ids LIKE ?'
  ).all(`%${skillId}%`) as Array<{ id: string; title: string; project_id: string | null; skill_ids: string | null }>
  return rows
    .filter((row) => {
      try {
        const ids = JSON.parse(row.skill_ids ?? '[]') as unknown
        return Array.isArray(ids) && ids.includes(skillId)
      } catch {
        return false
      }
    })
    .map((row) => ({ id: row.id, title: row.title, project_id: row.project_id ?? DEFAULT_PROJECT_ID }))
}

export function getSkillByName(m: DatabaseManager, name: string): SkillRecord | undefined {
  const row = m.prepare(
    'SELECT * FROM skills WHERE name = ? AND is_deleted = 0'
  ).get(name) as SkillRow | undefined
  return row ? deserializeSkill(row) : undefined
}

export function deleteSkill(m: DatabaseManager, id: string): boolean {
  const result = m.prepare(
    'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
  ).run(new Date().toISOString(), id)
  return result.changes > 0
}
