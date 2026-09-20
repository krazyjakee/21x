import type { DatabaseManager } from '../database'
import { SkillVersionConflictError, type SkillRecord, type UpdateSkillData } from '../database/types'
import type { ChatToolDefinition, ChatToolResult } from '../chat/tools'
import {
  clip,
  mutation,
  optionalNullableString,
  projectLocatorSchema,
  requiredString,
  resolveProject,
  result,
  type ProjectToolContext
} from './project-tools'
import { isGlobalSkill } from '../../shared/skill-scope'
import type { CommanderActionChange, CommanderActionTarget } from '../../shared/commander-tools'

/**
 * The Commander's skill tools (#74; docs/skills.md, docs/commander.md).
 *
 * Skill administration, not task work: the Commander lists and reads skills
 * across every scope, creates global skills (or a named project's), updates,
 * soft-deletes, promotes a project skill to global or moves a skill into a
 * project. Like the project tools, every write takes effect on the first call
 * with no confirmation step; the descriptions say so and flag the
 * wide-reaching ones (promote, move, remove). There is no tool
 * here that assigns a skill to a task; that stays with the project's
 * Captain, and the registry test proves it.
 *
 * Results are bounded like the project tools: `list_skills` is metadata only
 * with fixed item and character caps; content is returned only by
 * `get_skill`, clipped with truncation metadata.
 */

const MAX_SKILL_ITEMS = 100
const MAX_SKILL_CONTENT_CHARS = 8_000
const MAX_CONTENT_INPUT_CHARS = 60_000
const MAX_DESCRIPTION_CHARS = 1_024
const MAX_SKILL_NAME_CHARS = 64
const MAX_TAGS = 20
const MAX_TAG_CHARS = 40
const MAX_LOCATOR_CHARS = 200
const ONE_LINE_CHARS = 160
const RESULT_PAYLOAD_BUDGET = 11_000
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export type SkillChangeKind = 'created' | 'updated' | 'removed' | 'scope'

export interface SkillToolOptions {
  db: DatabaseManager
  context: ProjectToolContext
  onSkillChanged?: (skillId: string, kind: SkillChangeKind) => void
}

/** The tools that write (listed in src/shared). Each acts on the first call and its description says so; the registry tests prove both. */
export { MUTATING_COMMANDER_SKILL_TOOLS } from '../../shared/commander-tools'

/** A skill by id, else by exact name (names are unique across scopes). */
export function resolveSkill(db: DatabaseManager, locator: unknown): SkillRecord {
  if (typeof locator !== 'string' || !locator.trim()) throw new Error('skill is required')
  const value = locator.trim()
  if (value.length > MAX_LOCATOR_CHARS) throw new Error(`skill must be at most ${MAX_LOCATOR_CHARS} characters`)
  const found = db.getSkill(value) ?? db.getSkillByName(value)
  if (!found) throw new Error(`Skill not found: ${value}. Use list_skills to see the skills and their IDs.`)
  return found
}

function projectName(db: DatabaseManager, projectId: string | null): string | null {
  if (!projectId) return null
  return db.getProject(projectId)?.name ?? '(missing project)'
}

function scopeOf(db: DatabaseManager, skill: SkillRecord): Record<string, unknown> {
  return {
    scope: isGlobalSkill(skill) ? 'global' : 'project',
    project_id: skill.project_id,
    project_name: projectName(db, skill.project_id)
  }
}

function skillTarget(skill: Pick<SkillRecord, 'id' | 'name'>): CommanderActionTarget {
  return { kind: 'skill', id: skill.id, name: skill.name }
}

function skillChanges(skill: SkillRecord, updated: Record<string, unknown>, fields: string[]): CommanderActionChange[] {
  const before = skill as unknown as Record<string, unknown>
  return fields.map((field) => ({ field, before: before[field], after: updated[field] }))
}

/** One list entry: identity, scope, a one-line description and the usage stats. */
function listEntry(db: DatabaseManager, skill: SkillRecord): Record<string, unknown> {
  return {
    id: skill.id,
    name: clip(skill.name, MAX_SKILL_NAME_CHARS),
    description: clip(skill.description.replace(/\s+/g, ' ').trim(), ONE_LINE_CHARS),
    ...scopeOf(db, skill),
    version: skill.version,
    confidence: skill.confidence,
    uses: skill.uses,
    tags: skill.tags.slice(0, MAX_TAGS).map((tag) => clip(tag, MAX_TAG_CHARS)),
    preferred_model: skill.preferred_model,
    updated_at: skill.updated_at
  }
}

/** The full record for `get_skill`, with the content clipped and the clip declared. */
function detailEntry(db: DatabaseManager, skill: SkillRecord): Record<string, unknown> {
  const truncated = skill.content.length > MAX_SKILL_CONTENT_CHARS
  return {
    ...listEntry(db, skill),
    description: clip(skill.description, MAX_DESCRIPTION_CHARS),
    last_used: skill.last_used,
    created_at: skill.created_at,
    content: truncated ? skill.content.slice(0, MAX_SKILL_CONTENT_CHARS) : skill.content,
    content_chars: skill.content.length,
    content_truncated: truncated
  }
}

function skillName(input: Record<string, unknown>, key = 'name'): string {
  const name = requiredString(input, key, MAX_SKILL_NAME_CHARS)
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`${key} must be lowercase letters, digits and single hyphens (e.g. "pr-review")`)
  return name
}

function tagList(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((tag) => typeof tag !== 'string')) throw new Error('tags must be an array of strings')
  if (raw.length > MAX_TAGS) throw new Error(`tags may hold at most ${MAX_TAGS} entries`)
  return (raw as string[]).map((tag) => tag.trim()).filter(Boolean).map((tag) => clip(tag, MAX_TAG_CHARS))
}

function contentInput(raw: unknown, key = 'content'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${key} is required`)
  if (raw.length > MAX_CONTENT_INPUT_CHARS) throw new Error(`${key} must be at most ${MAX_CONTENT_INPUT_CHARS} characters`)
  return raw
}

function expectedVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw new Error('expected_version must be a positive integer')
  return raw
}

function assertNameFree(db: DatabaseManager, name: string, exceptId?: string): void {
  const taken = db.getSkillByName(name)
  if (taken && taken.id !== exceptId) {
    const where = taken.project_id ? `project "${projectName(db, taken.project_id)}"` : 'the global catalog'
    throw new Error(`Skill name "${name}" is already used in ${where} (id: ${taken.id}). Skill names are unique across all projects.`)
  }
}

/**
 * Why a skill cannot become a project skill: tasks in other projects or
 * agent-level defaults (which serve every project) still reference it.
 */
function moveBlockers(db: DatabaseManager, skill: SkillRecord, targetProjectId: string): string[] {
  const blockers: string[] = []
  const foreignTasks = db.getTasksUsingSkill(skill.id).filter((task) => task.project_id !== targetProjectId)
  if (foreignTasks.length > 0) {
    blockers.push(`assigned to ${foreignTasks.length} task(s) in other projects: ${foreignTasks.slice(0, 5).map((task) => `"${clip(task.title, 60)}"`).join(', ')}${foreignTasks.length > 5 ? ', …' : ''}`)
  }
  const agents = db.getAgents().filter((agent) => agent.config?.skill_ids?.includes(skill.id))
  if (agents.length > 0) {
    blockers.push(`a default skill of ${agents.length} agent(s), which serve every project: ${agents.slice(0, 5).map((agent) => `"${clip(agent.name, 60)}"`).join(', ')}`)
  }
  return blockers
}

function updateSkillOrConflict(db: DatabaseManager, skill: SkillRecord, changes: UpdateSkillData): SkillRecord {
  try {
    const updated = db.updateSkill(skill.id, changes)
    if (!updated) throw new Error('Skill no longer exists')
    return updated
  } catch (error) {
    if (error instanceof SkillVersionConflictError) {
      throw new Error(`${error.message} Current version: ${error.currentVersion}. Call get_skill and request the change again.`)
    }
    throw error
  }
}

function listSkills(options: SkillToolOptions, input: Record<string, unknown>): ChatToolResult {
  const { db } = options
  const scope = input.scope
  if (scope !== undefined && scope !== 'all' && scope !== 'global' && scope !== 'project') throw new Error('scope must be all, global or project')
  const project = input.project !== undefined ? resolveProject(db, input.project) : null
  if (scope === 'project' && !project) throw new Error('scope "project" needs a project')
  const includeArchived = input.include_archived_projects === true

  const archived = new Set(db.getProjects({ includeArchived: true }).filter((p) => p.archived).map((p) => p.id))
  let skills = project
    ? db.getSkills({ scope: project.id })
    : scope === 'global' ? db.getSkills({ scope: null }) : db.getSkills()
  if (!project && !includeArchived) skills = skills.filter((skill) => !skill.project_id || !archived.has(skill.project_id))
  skills = [...skills].sort((a, b) => Number(!!a.project_id) - Number(!!b.project_id) || a.name.localeCompare(b.name))

  const counts: Record<string, number> = { global: 0 }
  for (const skill of skills) {
    const key = skill.project_id ? projectName(db, skill.project_id) ?? skill.project_id : 'global'
    counts[key] = (counts[key] ?? 0) + 1
  }

  const items = skills.slice(0, MAX_SKILL_ITEMS).map((skill) => listEntry(db, skill))
  const payload: Record<string, unknown> = {
    skills: items,
    total: skills.length,
    truncated: skills.length > items.length,
    counts,
    ...(project ? { project_id: project.id, project_name: clip(project.name, MAX_LOCATOR_CHARS) } : {}),
    note: 'Metadata only; get_skill returns the content. You cannot assign skills to tasks: ask the project\'s Captain.'
  }
  while (JSON.stringify(payload).length > RESULT_PAYLOAD_BUDGET && items.length > 0) {
    items.pop()
    payload.truncated = true
  }
  return result(payload)
}

/** Commander-only skill discovery and administration. No task tools are registered here. */
export function createCommanderSkillTools(options: SkillToolOptions): ChatToolDefinition[] {
  const { db } = options
  const notify = (skillId: string, kind: SkillChangeKind): void => options.onSkillChanged?.(skillId, kind)
  const skillLocatorSchema = {
    skill: { type: 'string', description: 'Stable skill ID, or the exact skill name.' }
  }

  return [
    {
      name: 'list_skills',
      description: `List up to ${MAX_SKILL_ITEMS} skills with their scope (global, or the owning project): ID, name, one-line description, version, confidence and uses. No content. Filter with scope (all, global, project) and project; skills of archived projects only when requested.`,
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'global', 'project'], description: 'Default: all.' },
          ...projectLocatorSchema,
          include_archived_projects: { type: 'boolean' }
        },
        additionalProperties: false
      },
      handler: async (input) => listSkills(options, input)
    },
    {
      name: 'get_skill',
      description: `One skill in full: scope, metadata and its content (clipped to ${MAX_SKILL_CONTENT_CHARS} characters, with content_truncated set when clipped).`,
      inputSchema: { type: 'object', properties: skillLocatorSchema, required: ['skill'], additionalProperties: false },
      handler: async (input) => result(detailEntry(db, resolveSkill(db, input.skill)))
    },
    {
      name: 'create_skill',
      description: 'Create a skill. Global (visible to every project) unless a project is named, in which case only that project sees it. Takes effect immediately. A global skill is offered to agents in every project at once.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: MAX_SKILL_NAME_CHARS, description: 'Lowercase letters, digits and hyphens; unique across all projects.' },
          description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARS, description: 'When an agent should use the skill.' },
          content: { type: 'string', maxLength: MAX_CONTENT_INPUT_CHARS, description: 'The SKILL.md body (markdown).' },
          project: { type: 'string', description: 'Owning project (ID or exact name). Omit for a global skill.' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
          preferred_model: { type: ['string', 'null'], description: 'Model id the skill runs best with; omit for none.' }
        },
        required: ['name', 'description', 'content'],
        additionalProperties: false
      },
      handler: async (input) => {
        const name = skillName(input)
        const project = input.project !== undefined && input.project !== null && input.project !== '' ? resolveProject(db, input.project) : null
        if (project?.archived) throw new Error(`Project "${project.name}" is archived. Restore it before adding skills to it.`)
        const data = {
          name,
          description: requiredString(input, 'description', MAX_DESCRIPTION_CHARS),
          content: contentInput(input.content),
          tags: tagList(input.tags) ?? [],
          preferred_model: optionalNullableString(input.preferred_model, 'preferred_model', MAX_LOCATOR_CHARS) ?? null,
          project_id: project?.id ?? null
        }
        assertNameFree(db, name)
        return mutation(() => {
          assertNameFree(db, name)
          const created = db.createSkill(data)
          if (!created) throw new Error('Skill could not be created')
          notify(created.id, 'created')
          return detailEntry(db, created)
        }, (value) => ({
          target: { kind: 'skill', id: String(value.id), name: String(value.name) },
          changes: [{ field: 'exists', before: false, after: true }]
        }))
      }
    },
    {
      name: 'update_skill',
      description: 'Change a skill\'s name, description, content, tags or preferred model. Scope is not a field here: use promote_skill or move_skill. Takes effect immediately; the old text is overwritten, and a global skill changes for every project. Pass expected_version from get_skill so a concurrent edit is refused instead of overwritten.',
      inputSchema: {
        type: 'object',
        properties: {
          ...skillLocatorSchema,
          changes: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: MAX_SKILL_NAME_CHARS },
              description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARS },
              content: { type: 'string', maxLength: MAX_CONTENT_INPUT_CHARS },
              tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
              preferred_model: { type: ['string', 'null'] }
            },
            additionalProperties: false
          },
          expected_version: { type: 'integer', description: 'The version you last read.' }
        },
        required: ['skill', 'changes'],
        additionalProperties: false
      },
      handler: async (input) => {
        const skill = resolveSkill(db, input.skill)
        if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new Error('changes must be an object')
        const raw = input.changes as Record<string, unknown>
        const allowed = new Set(['name', 'description', 'content', 'tags', 'preferred_model'])
        if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(`changes may only contain: ${[...allowed].join(', ')}`)
        const changes: UpdateSkillData = {
          ...(raw.name !== undefined ? { name: skillName(raw) } : {}),
          ...(raw.description !== undefined ? { description: requiredString(raw, 'description', MAX_DESCRIPTION_CHARS) } : {}),
          ...(raw.content !== undefined ? { content: contentInput(raw.content) } : {}),
          ...(raw.tags !== undefined ? { tags: tagList(raw.tags) } : {}),
          ...(raw.preferred_model !== undefined ? { preferred_model: optionalNullableString(raw.preferred_model, 'preferred_model', MAX_LOCATOR_CHARS) ?? null } : {})
        }
        if (Object.keys(changes).length === 0) throw new Error('changes must include at least one supported field')
        if (changes.name !== undefined) assertNameFree(db, changes.name, skill.id)
        const version = expectedVersion(input.expected_version)
        return mutation(() => {
          if (changes.name !== undefined) assertNameFree(db, changes.name, skill.id)
          const updated = updateSkillOrConflict(db, skill, { ...changes, ...(version !== undefined ? { expected_version: version } : {}) })
          notify(skill.id, 'updated')
          return detailEntry(db, updated)
        }, () => {
          const updated = db.getSkill(skill.id)!
          return {
            target: skillTarget(updated),
            changes: skillChanges(skill, updated as unknown as Record<string, unknown>, Object.keys(changes))
          }
        })
      }
    },
    {
      name: 'remove_skill',
      description: 'Soft-delete a skill. Takes effect immediately. Destructive: agents stop receiving it at once (in every project, for a global skill); history keeps it.',
      inputSchema: { type: 'object', properties: { ...skillLocatorSchema }, required: ['skill'], additionalProperties: false },
      handler: async (input) => {
        const skill = resolveSkill(db, input.skill)
        return mutation(() => {
          if (!db.deleteSkill(skill.id)) throw new Error('Skill no longer exists')
          notify(skill.id, 'removed')
          return { removed_skill_id: skill.id, name: skill.name, ...scopeOf(db, skill) }
        }, () => ({ target: skillTarget(skill), changes: [{ field: 'exists', before: true, after: false }] }))
      }
    },
    {
      name: 'promote_skill',
      description: 'Make a project skill global. Takes effect immediately. Wide-reaching: the skill becomes visible to, and usable by, every project.',
      inputSchema: { type: 'object', properties: { ...skillLocatorSchema }, required: ['skill'], additionalProperties: false },
      handler: async (input) => {
        const skill = resolveSkill(db, input.skill)
        if (isGlobalSkill(skill)) throw new Error(`Skill "${skill.name}" is already global.`)
        return mutation(() => {
          const updated = db.setSkillProject(skill.id, null)
          if (!updated) throw new Error('Skill no longer exists')
          notify(skill.id, 'scope')
          return { ...listEntry(db, updated), previous_project_id: skill.project_id, previous_project_name: projectName(db, skill.project_id) }
        }, () => ({ target: skillTarget(skill), changes: [{ field: 'scope', before: skill.project_id, after: null }] }))
      }
    },
    {
      name: 'move_skill',
      description: 'Give a skill to one project (from global or from another project), so only that project sees it. Refused while tasks in other projects or agent-level defaults still use it. Takes effect immediately. Wide-reaching: every other project loses access to the skill.',
      inputSchema: { type: 'object', properties: { ...skillLocatorSchema, ...projectLocatorSchema }, required: ['skill', 'project'], additionalProperties: false },
      handler: async (input) => {
        const skill = resolveSkill(db, input.skill)
        const project = resolveProject(db, input.project)
        if (project.archived) throw new Error(`Project "${project.name}" is archived. Restore it before moving skills into it.`)
        if (skill.project_id === project.id) throw new Error(`Skill "${skill.name}" already belongs to "${project.name}".`)
        const blockers = moveBlockers(db, skill, project.id)
        if (blockers.length > 0) throw new Error(`Skill "${skill.name}" cannot be moved to "${project.name}": it is ${blockers.join('; and ')}. Remove those uses first, or keep it global.`)
        return mutation(() => {
          const stillBlocked = moveBlockers(db, skill, project.id)
          if (stillBlocked.length > 0) throw new Error(`Skill "${skill.name}" cannot be moved: it is ${stillBlocked.join('; and ')}.`)
          const updated = db.setSkillProject(skill.id, project.id)
          if (!updated) throw new Error('Skill no longer exists')
          notify(skill.id, 'scope')
          return { ...listEntry(db, updated), previous_project_id: skill.project_id, previous_project_name: projectName(db, skill.project_id) }
        }, () => ({ target: skillTarget(skill), changes: [{ field: 'scope', before: skill.project_id, after: project.id }] }))
      }
    }
  ]
}
