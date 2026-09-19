import type { DatabaseManager } from '../database'
import { SkillVersionConflictError, type SkillRecord, type UpdateSkillData } from '../database/types'
import { isSkillOwnedByProject, isSkillVisibleToProject } from '../../shared/skill-scope'

/**
 * Skill routes, scope-aware (#74).
 *
 * A session limited to one project (the Captain or a task agent; see
 * task-management-core.ts, which attaches {@link SKILL_SCOPE_PARAM} to every
 * skill call and overwrites anything the caller sent under that key) sees
 * global skills plus its project's own, and may create or change only its
 * project's. A global skill is read-only to it: creating or changing one
 * needs the user's confirmation, which a session cannot obtain, so the call
 * is refused with a message telling the Captain to ask the user (who can
 * do it in the Skills view or through the Commander).
 *
 * Callers with no scope (the IPC handlers behind the Skills view, the mobile
 * API, internal full-access callers) see and may change everything; a new
 * skill is global unless `project_id` names a project.
 */

/** Set by the MCP dispatcher, never by the calling agent. */
export const SKILL_SCOPE_PARAM = '_skill_scope'

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(['list_skills', 'get_skill', 'create_skill', 'update_skill', 'delete_skill'])

export interface SkillRouteScope {
  project_id: string
  /** The project's Captain, or one of its task agents. */
  role: 'coordinator' | 'task'
}

export function readSkillScope(params: Record<string, unknown>): SkillRouteScope | null {
  const raw = params[SKILL_SCOPE_PARAM]
  if (!raw || typeof raw !== 'object') return null
  const scope = raw as Record<string, unknown>
  if (typeof scope.project_id !== 'string' || !scope.project_id) return null
  return { project_id: scope.project_id, role: scope.role === 'coordinator' ? 'coordinator' : 'task' }
}

/** One message for "not there" and "not yours", so a session cannot probe other projects' skill ids. */
const SKILL_NOT_VISIBLE = { error: 'Access denied: skill not found in this project or the global catalog' }

function globalSkillRefusal(verb: string): { error: string } {
  return {
    error: `Global skills need the user's explicit confirmation, which this session cannot obtain. Ask the user to ${verb} it in the Skills view or through the Commander, or work on a project skill instead.`
  }
}

function validateSkillParams(params: Record<string, unknown>): { error: string } | null {
  if (params.confidence !== undefined) {
    const c = Number(params.confidence)
    if (!Number.isFinite(c) || c < 0 || c > 1) return { error: 'confidence must be a number between 0.0 and 1.0' }
  }
  if (params.tags !== undefined && !Array.isArray(params.tags)) return { error: 'tags must be an array of strings' }
  if (params.preferred_model !== undefined && params.preferred_model !== null && typeof params.preferred_model !== 'string') {
    return { error: 'preferred_model must be a string (or null to clear)' }
  }
  if (params.expected_version !== undefined) {
    const v = Number(params.expected_version)
    if (!Number.isInteger(v) || v < 1) return { error: 'expected_version must be a positive integer' }
  }
  return null
}

/** The skill as the API returns it: `scope` spelled out beside `project_id`. */
function withScope(db: DatabaseManager, skill: SkillRecord): Record<string, unknown> {
  return {
    ...skill,
    scope: skill.project_id ? 'project' : 'global',
    project_name: skill.project_id ? db.getProject(skill.project_id)?.name ?? null : null
  }
}

/**
 * The visible-skill check task routes apply to `skill_ids` (#74): a task may
 * only carry global skills and skills its own project owns. Returns the
 * offending skills' names so the caller can say which ones.
 */
export function validateSkillAssignment(db: DatabaseManager, skillIds: unknown, projectId: string): { error: string } | null {
  if (!Array.isArray(skillIds) || skillIds.length === 0) return null
  const ids = skillIds.filter((id): id is string => typeof id === 'string')
  // Ids that match no skill pass through as before (writeSkillFiles skips them).
  const foreign = db.getSkillsByIds(ids).filter((skill) => !isSkillVisibleToProject(skill, projectId))
  if (foreign.length > 0) {
    return { error: `Skill(s) owned by another project cannot be assigned here: ${foreign.map((s) => s.name).join(', ')}. Ask the user to promote them to global first.` }
  }
  return null
}

export async function handleSkillRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  const scope = readSkillScope(params)

  switch (route) {
    case '/list_skills': {
      // Content is left out: an agent picks a skill from this list, then reads it with get_skill.
      const filter = scope
        ? { visibleToProject: scope.project_id }
        : params.scope === 'global' ? { scope: null }
          : typeof params.project_id === 'string' && params.project_id ? { scope: params.project_id }
            : undefined
      return db
        .getSkills(filter)
        .sort((a, b) => b.confidence - a.confidence || b.uses - a.uses)
        .map((skill) => {
          const { content: _content, ...summary } = withScope(db, skill)
          return summary
        })
    }

    case '/get_skill': {
      const skill = db.getSkill(String(params.skill_id))
      if (!skill) return scope ? SKILL_NOT_VISIBLE : { error: 'Skill not found' }
      if (scope && !isSkillVisibleToProject(skill, scope.project_id)) return SKILL_NOT_VISIBLE
      return withScope(db, skill)
    }

    case '/create_skill': {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      const description = typeof params.description === 'string' ? params.description.trim() : ''
      const content = typeof params.content === 'string' ? params.content : ''
      if (!name) return { error: 'Skill name is required' }
      if (!description) return { error: 'Skill description is required' }
      if (!content) return { error: 'Skill content is required' }
      const invalid = validateSkillParams(params)
      if (invalid) return invalid

      let projectId: string | null
      if (scope) {
        // A session's skill belongs to its project. `global: true` is the
        // only way to ask for more, and it is refused: see the module comment.
        if (params.global === true) return globalSkillRefusal('create')
        projectId = scope.project_id
      } else {
        projectId = typeof params.project_id === 'string' && params.project_id ? params.project_id : null
        if (projectId && !db.getProject(projectId)) return { error: `Project not found: ${projectId}` }
      }

      // Names are unique across scopes (docs/skills.md), so a project skill
      // can never shadow a global one in a workspace.
      const existing = db.getSkillByName(name)
      if (existing) {
        const where = existing.project_id ? `in project ${existing.project_id}` : 'as a global skill'
        const visible = !scope || isSkillVisibleToProject(existing, scope.project_id)
        return {
          error: visible
            ? `Skill with name "${name}" already exists ${where} (id: ${existing.id}). Use update_skill to modify it.`
            : `Skill name "${name}" is taken by another project's skill. Skill names are unique across all projects; choose another name.`
        }
      }

      const skill = db.createSkill({
        name,
        description,
        content,
        confidence: params.confidence !== undefined ? Number(params.confidence) : undefined,
        tags: Array.isArray(params.tags) ? (params.tags as string[]) : undefined,
        preferred_model: (params.preferred_model as string | null | undefined) ?? null,
        project_id: projectId
      })
      return skill ? { success: true, skill: withScope(db, skill) } : { error: 'Failed to create skill' }
    }

    case '/update_skill': {
      const invalid = validateSkillParams(params)
      if (invalid) return invalid
      const skillId = String(params.skill_id)
      const existing = db.getSkill(skillId)
      if (scope) {
        if (!existing || !isSkillVisibleToProject(existing, scope.project_id)) return SKILL_NOT_VISIBLE
        if (!isSkillOwnedByProject(existing, scope.project_id)) return globalSkillRefusal('change')
      } else if (!existing) {
        return { error: 'Skill not found' }
      }

      const data: UpdateSkillData = {}
      if (params.name !== undefined) data.name = params.name as string
      if (params.description !== undefined) data.description = params.description as string
      if (params.content !== undefined) data.content = params.content as string
      if (params.confidence !== undefined) data.confidence = Number(params.confidence)
      if (params.tags !== undefined) data.tags = params.tags as string[]
      if (params.preferred_model !== undefined) data.preferred_model = params.preferred_model as string | null
      if (Object.keys(data).length === 0) return { error: 'No updates provided' }
      if (params.expected_version !== undefined) data.expected_version = Number(params.expected_version)
      if (data.name !== undefined && data.name !== existing.name) {
        const taken = db.getSkillByName(data.name)
        if (taken && taken.id !== existing.id) return { error: `Skill name "${data.name}" is already taken. Skill names are unique across all projects.` }
      }

      try {
        const skill = db.updateSkill(skillId, data)
        return skill ? { success: true, skill: withScope(db, skill) } : { error: 'Skill not found' }
      } catch (error) {
        if (error instanceof SkillVersionConflictError) {
          return { error: error.message, conflict: 'stale_version', current_version: error.currentVersion }
        }
        throw error
      }
    }

    case '/delete_skill': {
      const skillId = String(params.skill_id)
      if (scope) {
        const existing = db.getSkill(skillId)
        if (!existing || !isSkillVisibleToProject(existing, scope.project_id)) return SKILL_NOT_VISIBLE
        if (!isSkillOwnedByProject(existing, scope.project_id)) return globalSkillRefusal('delete')
      }
      return db.deleteSkill(skillId) ? { success: true } : { error: 'Skill not found' }
    }

    default:
      return undefined
  }
}
