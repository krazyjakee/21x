import { describe, expect, it, vi } from 'vitest'
import { ForgejoIssuesPlugin } from './forgejo-issues-plugin'
import { PluginActionId, type PluginContext } from './types'
import { TaskStatus } from '../../shared/constants'
import type { ForgejoManager } from '../forgejo-manager'
import type { TaskRecord } from '../database'

function setup() {
  const manager = {
    listLogins: vi.fn().mockResolvedValue([{ name: 'local', url: 'http://forge.lan:3000', sshHost: '', user: 'alice', isDefault: false }]),
    fetchUsername: vi.fn().mockResolvedValue('alice'),
    fetchUserOrgs: vi.fn().mockResolvedValue(['team']),
    fetchOrgRepos: vi.fn().mockResolvedValue([{ name: 'app', fullName: 'team/app' }]),
    fetchIssues: vi.fn().mockResolvedValue([
      { number: 4, title: 'Crash', body: 'Stack', state: 'open', assignees: [{ login: 'bob' }], labels: [{ name: 'p1' }, { name: 'bug' }], milestone: null, created_at: '', updated_at: '' }
    ]),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    fetchRepoCollaborators: vi.fn().mockResolvedValue([])
  }
  const settings: Record<string, string> = {}
  const db = {
    getSetting: (key: string) => settings[key],
    setSetting: (key: string, value: string) => { settings[key] = value },
    getTaskByExternalId: vi.fn().mockReturnValue(undefined),
    createTask: vi.fn().mockReturnValue({ id: 't1' }),
    updateTask: vi.fn()
  }
  const plugin = new ForgejoIssuesPlugin(manager as unknown as ForgejoManager)
  const ctx = { db } as unknown as PluginContext
  return { manager, db, settings, plugin, ctx }
}

const config = { login: 'local', owner: 'team', repo: 'app', state: 'open' }

describe('ForgejoIssuesPlugin', () => {
  it('resolves logins, owners, and repos for the chosen tea login', async () => {
    const { plugin, ctx, manager } = setup()
    expect(await plugin.resolveOptions('logins', {}, ctx)).toEqual([{ value: 'local', label: 'local — alice@http://forge.lan:3000' }])
    expect(await plugin.resolveOptions('owners', {}, ctx)).toEqual([])
    expect(await plugin.resolveOptions('owners', { login: 'local' }, ctx)).toEqual([
      { value: 'alice', label: 'alice (personal)' },
      { value: 'team', label: 'team' }
    ])
    expect(await plugin.resolveOptions('repos', config, ctx)).toEqual([{ value: 'app', label: 'app' }])
    expect(manager.fetchOrgRepos).toHaveBeenCalledWith('team', 'local')
  })

  it('requires a tea login in the config', () => {
    const { plugin } = setup()
    expect(plugin.validateConfig({ owner: 'team', repo: 'app' })).toBe('tea login is required')
    expect(plugin.validateConfig(config)).toBeNull()
  })

  it('imports issues as Forgejo tasks and records the repo provider', async () => {
    const { plugin, ctx, db, manager, settings } = setup()
    const result = await plugin.importTasks('src-1', config, ctx)

    expect(result).toEqual({ imported: 1, updated: 0, errors: [] })
    expect(manager.fetchIssues).toHaveBeenCalledWith('team', 'app', expect.objectContaining({ login: 'local', state: 'open' }))
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Crash',
      source: 'Forgejo',
      external_id: '4',
      priority: 'high',
      assignee: 'bob',
      labels: ['bug'],
      repos: ['team/app'],
      status: TaskStatus.NotStarted
    }))
    expect(JSON.parse(settings.repo_providers)).toEqual({ 'team/app': 'forgejo' })
  })

  it('closes issues through the configured login', async () => {
    const { plugin, ctx, manager } = setup()
    const task = { external_id: '4' } as TaskRecord
    const result = await plugin.executeAction(PluginActionId.CloseIssue, task, undefined, config, ctx)
    expect(result).toEqual({ success: true, taskUpdate: { status: TaskStatus.Completed } })
    expect(manager.updateIssue).toHaveBeenCalledWith('team', 'app', 4, { state: 'closed' }, 'local')
  })
})
