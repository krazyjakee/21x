/**
 * Skill scope (#74). A skill is either global (`project_id` null: visible to
 * every project) or owned by one project (visible to the Commander, that
 * project's Captain and the sessions of that project's tasks). Names stay
 * unique across both scopes so global and project skills can be written to
 * one workspace without a filename collision.
 */

export interface ScopedSkill {
  /** null = global. Older rows and mocks may omit the field; treat that as global. */
  project_id?: string | null
}

/** True when a session limited to `projectId` may see and use the skill. */
export function isSkillVisibleToProject(skill: ScopedSkill, projectId: string | null | undefined): boolean {
  if (!skill.project_id) return true
  return !!projectId && skill.project_id === projectId
}

/** True when the skill belongs to exactly that project (never for a global skill). */
export function isSkillOwnedByProject(skill: ScopedSkill, projectId: string | null | undefined): boolean {
  return !!skill.project_id && !!projectId && skill.project_id === projectId
}

export function isGlobalSkill(skill: ScopedSkill): boolean {
  return !skill.project_id
}

/** "Global" or the owning project's name; the id when the project is unknown. */
export function skillScopeLabel(skill: ScopedSkill, projectName?: string | null): string {
  if (!skill.project_id) return 'Global'
  return projectName?.trim() ? projectName : skill.project_id
}
