import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import type { DatabaseManager } from '../database'

export interface SkillSyncResult {
  created: string[]
  updated: string[]
  unchanged: string[]
}

interface ParsedSkill {
  name: string
  description: string
  content: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function emptySkillSyncResult(): SkillSyncResult {
  return { created: [], updated: [], unchanged: [] }
}

/** Parses `---\nname: ...\ndescription: ...\n---\n\ncontent` plus optional metadata. */
function parseSkillMd(raw: string): ParsedSkill | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n\n?([\s\S]*)$/)
  if (!match) return null

  const frontmatter = match[1]
  const content = match[2].trim()

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  if (!nameMatch) return null

  // writeSkillFiles wraps values in double quotes (see sanitizeYamlValue).
  const stripQuotes = (v: string): string => {
    const t = v.trim()
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return t
  }
  const name = stripQuotes(nameMatch[1])
  const description = descMatch ? stripQuotes(descMatch[1]) : ''
  if (!SKILL_NAME_PATTERN.test(name)) return null

  const confidenceMatch = frontmatter.match(/^confidence:\s*([0-9.]+)$/m)
  const usesMatch = frontmatter.match(/^uses:\s*(\d+)$/m)
  const lastUsedMatch = frontmatter.match(/^lastUsed:\s*(.+)$/m)
  const tagsMatch = frontmatter.match(/^tags:\s*\n((?:  - .+\n?)+)/m)

  return {
    name,
    description,
    content,
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : undefined,
    uses: usesMatch ? parseInt(usesMatch[1], 10) : undefined,
    last_used: lastUsedMatch ? lastUsedMatch[1].trim() : undefined,
    tags: tagsMatch
      ? tagsMatch[1].split('\n').map(line => line.trim().replace(/^- /, '')).filter(Boolean)
      : undefined
  }
}

/** Reads one skill entry: `<dir>/SKILL.md` or a flat `<name>.md` file. */
function readSkillEntry(skillsDir: string, entry: string): ParsedSkill | null {
  const entryPath = join(skillsDir, entry)
  let skillFile: string
  let fallbackName: string
  try {
    if (statSync(entryPath).isDirectory()) {
      skillFile = join(entryPath, 'SKILL.md')
      if (!existsSync(skillFile)) return null
      fallbackName = entry.replace(/_/g, '-')
    } else if (entry.endsWith('.md')) {
      skillFile = entryPath
      fallbackName = entry.replace(/\.md$/, '').replace(/_/g, '-')
    } else {
      return null
    }
  } catch {
    return null
  }

  let raw: string
  try {
    raw = readFileSync(skillFile, 'utf-8')
  } catch {
    return null
  }

  const parsed = parseSkillMd(raw)
  if (parsed) return parsed
  return SKILL_NAME_PATTERN.test(fallbackName) ? { name: fallbackName, description: '', content: raw.trim() } : null
}

/**
 * Scans the workspace skill directories (.claude/skills for Claude Code,
 * .agents/skills for other agents, .opencode/skills legacy) and creates or
 * updates DB skills that changed.
 */
export function syncSkillsFromDirectory(db: DatabaseManager, workspaceDir: string): SkillSyncResult {
  const skillsDirs = [
    join(workspaceDir, '.claude', 'skills'),
    join(workspaceDir, '.agents', 'skills'),
    join(workspaceDir, '.opencode', 'skills')
  ].filter(existsSync)
  console.log(`[AgentManager] syncSkillsFromWorkspace: workspaceDir=${workspaceDir}, skillsDirs found=${skillsDirs.length}`, skillsDirs)
  const result = emptySkillSyncResult()
  if (skillsDirs.length === 0) return result

  const seen = new Set<string>()
  for (const skillsDir of skillsDirs) {
    let entries: string[]
    try {
      entries = readdirSync(skillsDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const parsed = readSkillEntry(skillsDir, entry)
      if (!parsed || seen.has(parsed.name)) continue
      seen.add(parsed.name)

      const existing = db.getSkillByName(parsed.name)
      if (!existing) {
        db.createSkill({
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          confidence: parsed.confidence,
          uses: parsed.uses,
          last_used: parsed.last_used,
          tags: parsed.tags
        })
        result.created.push(parsed.name)
        continue
      }

      const changed = existing.content !== parsed.content
        || existing.description !== parsed.description
        || (parsed.confidence !== undefined && existing.confidence !== parsed.confidence)
        || (parsed.uses !== undefined && existing.uses !== parsed.uses)
        || (parsed.last_used !== undefined && existing.last_used !== parsed.last_used)
        || (parsed.tags !== undefined && JSON.stringify(existing.tags) !== JSON.stringify(parsed.tags))

      if (changed) {
        db.updateSkill(existing.id, {
          description: parsed.description,
          content: parsed.content,
          ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
          ...(parsed.uses !== undefined && { uses: parsed.uses }),
          ...(parsed.last_used !== undefined && { last_used: parsed.last_used }),
          ...(parsed.tags !== undefined && { tags: parsed.tags })
        })
        result.updated.push(parsed.name)
      } else {
        result.unchanged.push(parsed.name)
      }
    }
  }

  console.log(`[AgentManager] Skill sync: created=${result.created.length}, updated=${result.updated.length}, unchanged=${result.unchanged.length}`)
  return result
}
