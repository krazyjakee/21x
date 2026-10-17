import { describe, expect, it } from 'vitest'
import { PROJECT_CONFIGURATION_CODECS as codecs, isProjectConfigurationSettings } from './project-configuration-codecs'
import { CONFIGURATION_COMMAND_CODECS } from './configuration-desktop-codecs'
import { DATABASE_COMMAND_CODECS } from './database-desktop-codecs'

export const projectEditorInput = {
  name: 'Project', description: 'Context', default_agent_id: 'agent_one', captain_agent_id: null,
  git_provider: 'github' as const, git_org: 'synthetic',
  settings: {
    limits: { max_concurrent_agents: 2, daily_session_cap: 20, daily_token_cap: null, paused: false },
    captain_wakeups: { enabled: true, kinds: ['approval_pending', 'task_failed'] },
    scheduled_review: { enabled: true, cron: '0 9 * * 1-5' },
    concurrency: { captain_control: true, levels: { agent_one: 2 }, pinned: { agent_one: 1 } },
    public_note: 'Retained metadata'
  }
}
describe('production project editor codecs', () => {
  it('round trips exact retained editor fields without expanding proof-only owners', () => {
    expect(codecs['project:create'].decodeArguments(codecs['project:create'].encodeArguments([projectEditorInput]))).toEqual([projectEditorInput])
    expect(codecs['project:update'].decodeArguments(codecs['project:update'].encodeArguments(['project_one', projectEditorInput]))).toEqual(['project_one', projectEditorInput])
    expect(DATABASE_COMMAND_CODECS['project:create'].validateArguments([projectEditorInput])).toBe(false)
    expect(CONFIGURATION_COMMAND_CODECS['project:update'].validateArguments(['project_one', projectEditorInput])).toBe(false)
  })
  it('omits only declared optional undefined and permits explicit null selections', () => {
    expect(codecs['project:create'].encodeArguments([{ name: 'New', description: undefined, default_agent_id: null }])).toEqual({ data: { name: 'New', default_agent_id: null } })
    expect(codecs['project:update'].validateArguments(['project_one', {}])).toBe(true)
  })
  it('rejects unknown fields, invalid identity and non-finite or silently reinterpreted settings', () => {
    for (const data of [{ name: undefined }, { name: '' }, { name: 'x', archived: true }, { name: 'x', captain_agent_id: '../other' }, { name: 'x', git_provider: 'other' }])
      expect(codecs['project:create'].validateArguments([data])).toBe(false)
    for (const settings of [
      { limits: { paused: 'true' } }, { limits: { max_concurrent_agents: 0 } }, { limits: { daily_session_cap: 1.5 } },
      { captain_wakeups: { kinds: ['task_failed', 'task_failed'] } }, { captain_wakeups: { kinds: ['unknown'] } },
      { scheduled_review: { enabled: true, cron: 'not cron' } }, { concurrency: { pinned: { agent_one: 11 } } },
      { nested: { openai_api_key: 'secret' } }, { nested: { api_keys: {} } }, { unknown: Number.NaN }, { bytes: new Uint8Array(4) },
      { text: 'x'.repeat(65_537) }, { entries: Array.from({ length: 129 }, () => 1) }
    ]) expect(isProjectConfigurationSettings(settings), JSON.stringify(settings).slice(0, 150)).toBe(false)
  })
})
