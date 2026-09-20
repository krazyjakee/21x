import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { seedCaptainTasks } from '../database/seed'
import {
  CAPTAIN_MEMORY_FILE,
  CAPTAIN_MEMORY_MAX_CHARS,
  buildProjectContext,
  captainPromptOptions,
  readCaptainMemory
} from './captain-context'
import { buildCaptainSystemPrompt } from '../prompts/captain'
import type { DatabaseManager } from '../database'

/**
 * The project section of a Captain's prompt (#55). Asking "what is this
 * project / what repos do we have" is answered from here, with no tool call,
 * so everything the project editor holds must show up.
 */
describe('buildProjectContext', () => {
  let db: DatabaseManager

  beforeEach(() => {
    ;({ db } = createTestDb())
    seedCaptainTasks(db.db)
  })

  it('names the project, its brief, its repos with default branches and its resources', () => {
    const project = db.createProject({ name: 'Website relaunch', description: 'Ship the new marketing site by Q4.', git_org: 'acme' })!
    db.addProjectRepo(project.id, { name: 'site', default_branch: 'main' })
    db.addProjectRepo(project.id, { name: 'cms', org: 'partner', provider: 'gitlab' })
    db.addProjectResource(project.id, { label: 'Design files', url: 'https://figma.com/file/abc', notes: 'Source of truth for layouts' })
    db.addProjectResource(project.id, { label: 'Style guide' })

    const context = buildProjectContext(db, project.id)
    expect(context).toContain('**Website relaunch**')
    expect(context).toContain('Ship the new marketing site by Q4.')
    expect(context).toContain('- acme/site (github, default branch `main`)')
    expect(context).toContain("- partner/cms (gitlab, the remote's default branch)")
    expect(context).toContain('- Design files — https://figma.com/file/abc: Source of truth for layouts')
    expect(context).toContain('- Style guide')
    // No checkout: the follow-up decision on read-only clones is documented in the prompt.
    expect(context).toContain('You have no checkout of these repositories')
  })

  it('says so when a project has no brief, repos or resources', () => {
    const project = db.createProject({ name: 'Empty' })!
    const context = buildProjectContext(db, project.id)
    expect(context).toContain('_No brief yet.')
    expect(context).toContain('### Repositories\n\n_None.')
    expect(context).toContain('### Resources\n\n_None._')
  })

  it('is empty for an unknown project', () => {
    expect(buildProjectContext(db, 'missing')).toBe('')
  })

  it('reflects an edit the next time it is built', () => {
    const project = db.createProject({ name: 'Before' })!
    expect(buildProjectContext(db, project.id)).toContain('**Before**')
    db.updateProject(project.id, { name: 'After' })
    expect(buildProjectContext(db, project.id)).toContain('**After**')
    expect(buildProjectContext(db, project.id)).not.toContain('**Before**')
  })
})

describe('readCaptainMemory', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'captain-memory-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('is empty, with the path it would use, when the file does not exist', () => {
    const memory = readCaptainMemory(workspace)
    expect(memory).toEqual({ path: join(workspace, CAPTAIN_MEMORY_FILE), content: '', truncated: false })
  })

  it('reads the file', () => {
    writeFileSync(join(workspace, CAPTAIN_MEMORY_FILE), '# Memory\n\n- Use pnpm.\n')
    const memory = readCaptainMemory(workspace)
    expect(memory.content).toBe('# Memory\n\n- Use pnpm.')
    expect(memory.truncated).toBe(false)
  })

  it('reads legacy coordinator memory as Captain without modifying the file', () => {
    const legacy = ['Master', 'mind'].join('')
    const content = `# Daccord — ${legacy} memory\nKeep the release decision.`
    const path = join(workspace, CAPTAIN_MEMORY_FILE)
    writeFileSync(path, content)
    expect(readCaptainMemory(workspace).content).toBe('# Daccord — Captain memory\nKeep the release decision.')
    expect(readFileSync(path, 'utf-8')).toBe(content)
  })

  it('caps a long file and says so', () => {
    writeFileSync(join(workspace, CAPTAIN_MEMORY_FILE), 'x'.repeat(CAPTAIN_MEMORY_MAX_CHARS + 500))
    const memory = readCaptainMemory(workspace)
    expect(memory.content).toHaveLength(CAPTAIN_MEMORY_MAX_CHARS)
    expect(memory.truncated).toBe(true)
  })
})

describe('captainPromptOptions', () => {
  let db: DatabaseManager
  let workspace: string

  beforeEach(() => {
    ;({ db } = createTestDb())
    seedCaptainTasks(db.db)
    workspace = mkdtempSync(join(tmpdir(), 'captain-ws-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("builds the prompt from the row's project and the workspace memory file", () => {
    const project = db.createProject({ name: 'Alpha', description: 'The alpha brief.' })!
    db.addProjectRepo(project.id, { name: 'alpha-api', org: 'acme', default_branch: 'develop' })
    writeFileSync(join(workspace, CAPTAIN_MEMORY_FILE), '- Decision: ship weekly.\n- Open: waiting on legal.')
    const row = db.getCoordinatorTask(project.id)!

    const prompt = buildCaptainSystemPrompt(captainPromptOptions(db, row, workspace))
    expect(prompt).toContain('## Project context')
    expect(prompt).toContain('**Alpha**')
    expect(prompt).toContain('The alpha brief.')
    expect(prompt).toContain('acme/alpha-api (github, default branch `develop`)')
    expect(prompt).toContain('## Project memory')
    expect(prompt).toContain(join(workspace, CAPTAIN_MEMORY_FILE))
    expect(prompt).toContain('- Decision: ship weekly.\n- Open: waiting on legal.')
  })

  it('tells a Captain with no memory file yet to create one', () => {
    const row = db.getCoordinatorTask()!
    const prompt = buildCaptainSystemPrompt(captainPromptOptions(db, row, workspace))
    expect(prompt).toContain('**Default**')
    expect(prompt).toContain('_The file does not exist yet.')
  })
})
