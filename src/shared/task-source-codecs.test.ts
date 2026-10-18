import { describe, expect, it } from 'vitest'
import { TASK_SOURCE_CODECS as codecs, TASK_SOURCE_KEY_SET_MARKER as marker, TASK_SOURCE_PLUGIN_IDS, isTaskSourceConfig, isTaskSourceConfigInput, projectTaskSource } from './task-source-codecs'

const source = { id: 'source-one', mcp_server_id: null, name: 'Notion', plugin_id: 'notion', config: { data_source_id: 'database-one', api_token: 'private-token', internal_refresh_token: 'hidden-token' },
  list_tool: '', list_tool_args: { authorization: 'private-legacy-argument' }, update_tool: '', update_tool_args: {}, last_synced_at: null, enabled: true, project_id: 'project-one', created_at: 'created', updated_at: 'updated' }

describe('task source finite production codecs', () => {
  it('projects exact public metadata and markers without plaintext, ciphertext or legacy argument exports', () => {
    const expected = { ...source, config: { data_source_id: 'database-one', api_token: marker }, list_tool_args: {} }
    expect(projectTaskSource(source)).toEqual(expected)
    expect(codecs['taskSource:getAll'].encodeResult([source])).toEqual({ defined: true, value: [expected] })
    expect(codecs['taskSource:getAll'].validateResult([source])).toBe(false)
    expect(codecs['taskSource:getAll'].validateResult([{ ...expected, credential_blob: 'private' }])).toBe(false)
    expect(JSON.stringify(projectTaskSource(source))).not.toMatch(/private-token|hidden-token|private-legacy-argument/)
    expect(projectTaskSource({ ...source, plugin_id: 'retired-plugin', config: { opaque_secret: 'retained-private' } })).toEqual({ ...source, plugin_id: 'retired-plugin', config: {}, list_tool_args: {} })
  })

  it('preserves exact missing/update/void/filter semantics and rejects missing successful create', () => {
    expect(codecs['taskSource:getAll'].encodeArguments([])).toEqual({})
    expect(codecs['taskSource:getAll'].decodeArguments({ projectId: '' })).toEqual([''])
    expect(codecs['taskSource:update'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['taskSource:delete'].encodeResult(false)).toEqual({ defined: true, value: false })
    expect(codecs['taskSource:exportUpdate'].encodeResult(undefined)).toEqual({ defined: false })
    expect(() => codecs['taskSource:create'].encodeResult(undefined)).toThrow('result')
    expect(codecs['taskSource:update'].decodeArguments(codecs['taskSource:update'].encodeArguments(['source-one', { enabled: false, name: undefined }]))).toEqual(['source-one', { enabled: false }])
  })

  it.each(['critical', 'high', 'medium', 'low', 'urgent'])('accepts canonical export priority or explicit input alias %s without wire rewriting', priority => {
    const payload = { taskId: 'task-one', fields: { priority } }
    expect(codecs['taskSource:exportUpdate'].encodeArguments(['task-one', { priority }])).toEqual(payload)
    expect(codecs['taskSource:exportUpdate'].decodeArguments(payload)).toEqual(['task-one', { priority }])
  })

  it.each(['emergency', 'Critical', '', 1, null])('rejects invalid export priority %j', priority => {
    expect(codecs['taskSource:exportUpdate'].validateArguments(['task-one', { priority }])).toBe(false)
    expect(() => codecs['taskSource:exportUpdate'].decodeArguments({ taskId: 'task-one', fields: { priority } })).toThrow('arguments')
  })

  it('bounds write-only raw credentials separately from the marker-only DTO and finite plugin configuration', () => {
    const value = '\uFEFFcredential-雪\nsecond-line'
    expect(isTaskSourceConfigInput('notion', { api_token: value })).toBe(true)
    expect(isTaskSourceConfig('notion', { api_token: value })).toBe(false)
    expect(isTaskSourceConfig('notion', { api_token: marker })).toBe(true)
    for (const value of ['', marker, 'x'.repeat(16_384)]) expect(isTaskSourceConfigInput('notion', { api_token: value })).toBe(true)
    for (const value of ['x'.repeat(16_385), '雪'.repeat(5462), 'secret\0suffix']) expect(isTaskSourceConfigInput('notion', { api_token: value })).toBe(false)
    expect(isTaskSourceConfigInput('github-issues', { api_token: 'unsupported-secret' })).toBe(false)
    expect(isTaskSourceConfigInput('notion', { arbitrary_api_key: 'unsupported-secret' })).toBe(false)
    expect(codecs['taskSource:update'].validateArguments(['source-one', { config: { arbitrary: 'value' } }])).toBe(false)
    expect(codecs['taskSource:create'].validateArguments([{ name: 'Source', mcp_server_id: null, plugin_id: 'retired-plugin' }])).toBe(false)
    for (const plugin_id of TASK_SOURCE_PLUGIN_IDS) expect(codecs['taskSource:create'].validateArguments([{ name: 'Source', mcp_server_id: null, plugin_id, config: {} }])).toBe(true)
    expect(isTaskSourceConfigInput('youtrack', { server_url: 'https://user:private@example.test' })).toBe(false)
    expect(isTaskSourceConfigInput('connector-bridge', { props: { arbitrary: 'private' } })).toBe(false)
    for (const poll_interval_minutes of [15, '15', 0, '0', '']) expect(isTaskSourceConfigInput('connector-bridge', { poll_interval_minutes })).toBe(true)
    for (const poll_interval_minutes of ['arbitrary', '-1', 'Infinity']) expect(isTaskSourceConfigInput('connector-bridge', { poll_interval_minutes })).toBe(false)
  })

  it('refuses injected authority and unsupported legacy tool or cross-project mutation fields', () => {
    expect(() => codecs['taskSource:sync'].decodeArguments({ sourceId: 'source-one', caller: { projectId: 'foreign' } })).toThrow('arguments')
    expect(codecs['taskSource:update'].validateArguments(['source-one', { project_id: 'foreign' }])).toBe(false)
    expect(codecs['taskSource:create'].validateArguments([{ name: 'Source', mcp_server_id: null, plugin_id: 'github-issues', list_tool: 'execute-arbitrary' }])).toBe(false)
    expect(codecs['taskSource:create'].validateArguments([{ name: 'Source', mcp_server_id: null, plugin_id: 'github-issues', update_tool_args: { command: 'arbitrary' } }])).toBe(false)
    expect(codecs['taskSource:exportUpdate'].validateArguments(['task-one', { agent_id: 'foreign-agent' }])).toBe(false)
    expect(codecs['taskSource:exportUpdate'].validateArguments(['task-one', { title: 'New title', complete_at_source: false }])).toBe(true)
    expect(codecs['taskSource:reassign'].validateArguments(['task-one', ['user-one', 'user-one'], 'User'])).toBe(false)
    expect(codecs['taskSource:reassign'].validateArguments(['task-one', [], ''])).toBe(true)
  })

  it('validates exact bounded users, sync/reassignment replies and aggregate frames without truncation', () => {
    const user = { id: 'remote-one', email: 'fixture@example.test', name: 'Fixture' }
    expect(codecs['taskSource:getUsers'].validateResult([user])).toBe(true)
    expect(codecs['taskSource:getUsers'].validateResult([{ ...user, access_token: 'private' }])).toBe(false)
    expect(codecs['taskSource:getUsers'].validateResult(Array.from({ length: 513 }, () => user))).toBe(false)
    expect(codecs['taskSource:getAll'].validateResult(Array.from({ length: 257 }, () => projectTaskSource(source)))).toBe(false)
    expect(codecs['taskSource:sync'].validateResult({ source_id: 'source-one', imported: 1, updated: 0, errors: [] })).toBe(true)
    expect(codecs['taskSource:sync'].validateResult({ source_id: 'source-one', imported: -1, updated: 0, errors: [] })).toBe(false)
    expect(codecs['taskSource:reassign'].validateResult({ success: true, retry: true })).toBe(false)
    const large = Array.from({ length: 256 }, () => ({ ...source, config: { data_source_id: '雪'.repeat(4096), api_token: marker }, list_tool_args: {} }))
    expect(() => codecs['taskSource:getAll'].encodeResult(large)).toThrow('result')
  })
})
