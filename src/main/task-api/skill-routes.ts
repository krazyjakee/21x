import type { DatabaseManager, UpdateSkillData } from '../database'

function validateSkillParams(params: Record<string, unknown>): { error: string } | null {
  if (params.confidence !== undefined) {
    const c = Number(params.confidence)
    if (!Number.isFinite(c) || c < 0 || c > 1) return { error: 'confidence must be a number between 0.0 and 1.0' }
  }
  if (params.tags !== undefined && !Array.isArray(params.tags)) return { error: 'tags must be an array of strings' }
  if (params.preferred_model !== undefined && params.preferred_model !== null && typeof params.preferred_model !== 'string') {
    return { error: 'preferred_model must be a string (or null to clear)' }
  }
  return null
}

export async function handleSkillRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case '/list_skills':
      // Content is left out: an agent picks a skill from this list, then reads it with get_skill.
      return db
        .getSkills()
        .sort((a, b) => b.confidence - a.confidence || b.uses - a.uses)
        .map(({ content: _content, ...summary }) => summary)

    case '/get_skill':
      return db.getSkill(String(params.skill_id)) ?? { error: 'Skill not found' }

    case '/create_skill': {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      const description = typeof params.description === 'string' ? params.description.trim() : ''
      const content = typeof params.content === 'string' ? params.content : ''
      if (!name) return { error: 'Skill name is required' }
      if (!description) return { error: 'Skill description is required' }
      if (!content) return { error: 'Skill content is required' }
      const invalid = validateSkillParams(params)
      if (invalid) return invalid
      const existing = db.getSkillByName(name)
      if (existing) return { error: `Skill with name "${name}" already exists (id: ${existing.id}). Use update_skill to modify it.` }

      const skill = db.createSkill({
        name,
        description,
        content,
        confidence: params.confidence !== undefined ? Number(params.confidence) : undefined,
        tags: Array.isArray(params.tags) ? (params.tags as string[]) : undefined,
        preferred_model: (params.preferred_model as string | null | undefined) ?? null
      })
      return skill ? { success: true, skill } : { error: 'Failed to create skill' }
    }

    case '/update_skill': {
      const invalid = validateSkillParams(params)
      if (invalid) return invalid
      const data: UpdateSkillData = {}
      if (params.name !== undefined) data.name = params.name as string
      if (params.description !== undefined) data.description = params.description as string
      if (params.content !== undefined) data.content = params.content as string
      if (params.confidence !== undefined) data.confidence = Number(params.confidence)
      if (params.tags !== undefined) data.tags = params.tags as string[]
      if (params.preferred_model !== undefined) data.preferred_model = params.preferred_model as string | null
      if (Object.keys(data).length === 0) return { error: 'No updates provided' }

      const skill = db.updateSkill(String(params.skill_id), data)
      return skill ? { success: true, skill } : { error: 'Skill not found' }
    }

    case '/delete_skill':
      return db.deleteSkill(String(params.skill_id)) ? { success: true } : { error: 'Skill not found' }

    default:
      return undefined
  }
}
