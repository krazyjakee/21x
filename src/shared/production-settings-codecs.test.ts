import { describe, expect, it } from 'vitest'
import { PRODUCTION_SETTINGS_CODECS as codecs, PRODUCTION_API_KEY_SET_MARKER as marker, isProductionSettingWrite, projectProductionSetting, requiresNativeSettingsOwner, settingProjectId } from './production-settings-codecs'

const secret = { id: 'secret-one', name: 'Database', description: 'Private database access', env_var_name: 'DATABASE_URL', created_at: 'created', updated_at: 'updated' }
describe('production settings and secret codecs', () => {
  it('preserves empty/missing/void contracts and credential marker projection', () => {
    expect(codecs['settings:get'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(codecs['settings:get'].encodeResult('')).toEqual({ defined: true, value: '' })
    expect(codecs['settings:set'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['secrets:update'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['secrets:delete'].encodeResult(false)).toEqual({ defined: true, value: false })
    expect(projectProductionSetting('openai_api_key', 'private-key')).toBe(marker)
    expect(projectProductionSetting('openai_api_key', '')).toBe('')
    expect(codecs['settings:set'].decodeArguments(codecs['settings:set'].encodeArguments(['openai_api_key', marker]))).toEqual(['openai_api_key', marker])
    expect(codecs['settings:getAll'].encodeResult({ openai_api_key: 'private-key', theme: 'dark', mobile_auth_token: 'live-token', mobile_init_code_current: 'pairing-code', 'sessions.commander_memory': 'private history' }))
      .toEqual({ defined: true, value: { openai_api_key: marker, theme: 'dark' } })
  })

  it('exposes only finite environment presence results', () => {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY']) expect(codecs['env:get'].validateArguments([key])).toBe(true)
    for (const key of ['PATH', 'HOME', 'TASK_API_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY_EXTRA']) expect(codecs['env:get'].validateArguments([key])).toBe(false)
    for (const value of [null, '', marker]) expect(codecs['env:get'].validateResult(value)).toBe(true)
    expect(codecs['env:get'].validateResult('private-environment-value')).toBe(false)
  })

  it('validates exact setting domains, scoped identities, URLs and thresholds', () => {
    expect(settingProjectId('canvas_state:project-one')).toBe('project-one')
    expect(settingProjectId('drawing_state:../outside')).toBeNull()
    for (const key of ['mobile_auth_token', '__schema_version', 'sessions.commander_generation:owner', 'session-feedback-completion:task', 'arbitrary_api_key', 'drawing_state:../outside']) expect(codecs['settings:get'].validateArguments([key])).toBe(false)
    for (const [key, value] of [['max_concurrent_agent_sessions', '2junk'], ['max_concurrent_agent_sessions', '-1'], ['heartbeat_default_interval', '0'], ['heartbeat_active_hours_start', '28:00'],
      ['git_provider', 'arbitrary'], ['chat_base_url', 'https://user:secret@example.test'], ['chat_base_url', 'https://example.test/?token=secret'], ['chat_agent_id', '../outside'],
      ['sessions.rollover_thresholds', '{"contextRatio":2}'], ['sessions.rollover_thresholds', '{"unknown":1}'], ['commander_briefing', '{"enabled":true,"cron":"* * * * *","speak":false,"token":"private"}']]) {
      expect(isProductionSettingWrite(key, value)).toBe(false)
    }
    expect(isProductionSettingWrite('heartbeat_active_hours_start', '')).toBe(true)
    expect(isProductionSettingWrite('chat_agent_id', '')).toBe(true)
    expect(isProductionSettingWrite('sessions.rollover_thresholds', '{"contextRatio":0.7,"compactions":2}')).toBe(true)
    expect(isProductionSettingWrite('current_user_email', 'fake@example.test')).toBe(false)
    expect(isProductionSettingWrite('OPENCODE_BINARY_PATH', '/tmp/injected-executable')).toBe(false)
    expect(requiresNativeSettingsOwner('voice_enabled')).toBe(true)
    expect(requiresNativeSettingsOwner('elevenlabs_api_key')).toBe(true)
    expect(requiresNativeSettingsOwner('voice_advanced_stt')).toBe(false)
  })

  it('preserves secret inputs but projects exact metadata without values/ciphertext', () => {
    const data = { name: secret.name, description: '', env_var_name: 'DATABASE_URL', value: '\uFEFFmultiline\nsecret-雪' }
    expect(codecs['secrets:create'].decodeArguments(codecs['secrets:create'].encodeArguments([data]))).toEqual([data])
    expect(codecs['secrets:update'].decodeArguments(codecs['secrets:update'].encodeArguments([secret.id, { name: 'Renamed', value: undefined }]))).toEqual([secret.id, { name: 'Renamed' }])
    expect(codecs['secrets:create'].encodeResult({ ...secret, value: 'private-value', ciphertext: 'private-bytes' })).toEqual({ defined: true, value: secret })
    expect(codecs['secrets:getAll'].validateResult([{ ...secret, value: 'private-value' }])).toBe(false)
    expect(codecs['secrets:create'].validateArguments([{ ...data, env_var_name: 'BAD;COMMAND' }])).toBe(false)
    expect(codecs['secrets:create'].validateArguments([{ ...data, project_id: 'foreign' }])).toBe(false)
    expect(codecs['secrets:update'].validateArguments([secret.id, { value: '' }])).toBe(true)
    expect(codecs['secrets:create'].validateArguments([{ ...data, value: '' }])).toBe(true)
    expect(() => codecs['secrets:create'].decodeArguments({ data, caller: { principal: 'service' } })).toThrow('arguments')
  })

  it('bounds UTF8 aggregate values and record counts without truncation', () => {
    const tooLarge = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`canvas_state:project-${index}`, '界'.repeat(20_000)]))
    expect(() => codecs['settings:getAll'].encodeResult(tooLarge)).toThrow('result')
    expect(codecs['settings:getAll'].validateWireResult({ defined: true, value: tooLarge })).toBe(false)
    expect(codecs['secrets:getAll'].validateResult(Array.from({ length: 129 }, () => secret))).toBe(false)
    expect(codecs['settings:getAll'].validateResult({ openai_api_key: 'private-key' })).toBe(false)
    expect(codecs['settings:getAll'].validateResult({ mobile_auth_token: 'private' })).toBe(false)
  })
})
