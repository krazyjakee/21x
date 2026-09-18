/**
 * What a project's Mastermind knows about its project (#55).
 *
 * The Mastermind's system prompt is the built-in persona (prompts/mastermind.ts)
 * followed by a project section built here from the project row, its repos and
 * its resources, and by the memory file it keeps in its workspace. The section
 * is rebuilt from the database on every session start, resume and send, so an
 * edit to the project reaches the next message without restarting anything.
 * It is deliberately cheap: three indexed reads and one small file.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { DatabaseManager, TaskRecord } from '../database'
import type { MastermindPromptOptions } from '../prompts/mastermind'
import type { MastermindMemory } from '../../shared/mastermind-memory'
import { listProjectRepos, taskProjectId } from './project-repos'

/** The file the Mastermind keeps its long-lived notes in, inside its workspace. */
export const MASTERMIND_MEMORY_FILE = 'MEMORY.md'

/** Characters of the memory file injected into the prompt; the rest is cut with a notice. */
export const MASTERMIND_MEMORY_MAX_CHARS = 12_000

export type { MastermindMemory }

/** What the DB lookups need; a Pick so tests can pass a small stub. */
export type MastermindContextStore = Pick<DatabaseManager, 'getProject' | 'getProjectRepos' | 'getProjectResources' | 'getSetting'>

export function mastermindMemoryPath(workspaceDir: string): string {
  return join(workspaceDir, MASTERMIND_MEMORY_FILE)
}

/** Reads the memory file; a missing or unreadable file is empty memory, never an error. */
export function readMastermindMemory(workspaceDir: string): MastermindMemory {
  const path = mastermindMemoryPath(workspaceDir)
  let raw = ''
  try {
    if (existsSync(path)) raw = readFileSync(path, 'utf-8')
  } catch (error) {
    console.warn(`[AgentManager] Could not read Mastermind memory at ${path}:`, error)
  }
  const trimmed = raw.trim()
  const truncated = trimmed.length > MASTERMIND_MEMORY_MAX_CHARS
  return { path, content: truncated ? trimmed.slice(0, MASTERMIND_MEMORY_MAX_CHARS) : trimmed, truncated }
}

/**
 * The project section of the prompt: name, brief, repos with default branches,
 * resources. The Mastermind answers "what is this project / what repos do we
 * have" from this, without a tool call.
 */
export function buildProjectContext(db: MastermindContextStore, projectId: string): string {
  const project = db.getProject(projectId)
  if (!project) return ''
  const lines: string[] = []
  lines.push(`You are the Mastermind of the project **${project.name}**. Everything you plan, create and start belongs to it.`)
  const brief = project.description?.trim()
  lines.push('', '### Brief', '', brief || '_No brief yet. Ask the user what the project is for when it matters._')

  const repos = listProjectRepos(db, projectId)
  lines.push('', '### Repositories', '')
  if (repos.length === 0) {
    lines.push('_None. Tasks in this project run without a repository; add one in the project editor to change that._')
  } else {
    for (const repo of repos) {
      const branch = repo.defaultBranch ? `default branch \`${repo.defaultBranch}\`` : "the remote's default branch"
      lines.push(`- ${repo.fullName} (${repo.provider}, ${branch})`)
    }
  }

  const resources = db.getProjectResources(projectId)
  lines.push('', '### Resources', '')
  if (resources.length === 0) {
    lines.push('_None._')
  } else {
    for (const resource of resources) {
      const url = resource.url ? ` — ${resource.url}` : ''
      const notes = resource.notes?.trim() ? `: ${resource.notes.trim()}` : ''
      lines.push(`- ${resource.label}${url}${notes}`)
    }
  }

  lines.push(
    '',
    '### Code access',
    '',
    'You have no checkout of these repositories: your workspace holds only your own files. ' +
    'To look at real code, plan against it or verify a claim, create a task for an agent (or ask a running one) and read its report back. ' +
    'Do not guess at file contents.'
  )
  return lines.join('\n')
}

/**
 * Prompt options for a coordinator row: the project section from its
 * project_id and the memory file from its workspace.
 */
export function mastermindPromptOptions(
  db: MastermindContextStore,
  task: TaskRecord,
  workspaceDir: string
): MastermindPromptOptions {
  return {
    projectContext: buildProjectContext(db, taskProjectId(task)),
    memory: readMastermindMemory(workspaceDir)
  }
}
