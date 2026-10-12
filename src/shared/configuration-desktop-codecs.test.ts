import { describe, expect, it } from 'vitest'
import { CONFIGURATION_COMMAND_CODECS as codecs, CONFIGURATION_EVENT_CODECS, CONFIGURATION_OWNER_REQUIREMENTS, projectPublicAgent } from './configuration-desktop-codecs'
import type { JsonValue } from './service-protocol'

const agent = {
  id: 'agent-1', name: 'Synthetic Agent', server_url: 'http://localhost:4096', is_default: false, created_at: '2026-01-01', updated_at: '2026-01-01',
  config: { coding_agent: 'codex', skill_ids: ['skill-1'], secret_ids: ['secret-metadata-id'], mcp_servers: [{ serverId: 'server-1', enabledTools: [] }], api_keys: { openai: 'fixture-private-key' }, max_parallel_sessions: 1 },
  mcp_scope_nonce: 'fixture-private-nonce'
}
const skill = { id: 'skill-1', name: 'Synthetic skill', description: '', content: '\uFEFFinstructions 你好', version: 2, confidence: 0.5, uses: 0, last_used: null, tags: [], preferred_model: null, project_id: null, created_at: '2026-01-01', updated_at: '2026-01-01', is_deleted: 0 }

describe('configuration command codecs', () => {
  it('limits configuration invalidation events to their exact owned metadata', () => {
    expect(CONFIGURATION_EVENT_CODECS['skills:changed'].validatePayload({ skillId: 'skill-1', kind: 'scope' })).toBe(true)
    expect(CONFIGURATION_EVENT_CODECS['skills:changed'].validatePayload({ skillId: 'skill-1', kind: 'scope', content: 'private' })).toBe(false)
    expect(CONFIGURATION_EVENT_CODECS['skills:changed'].validatePayload({ skillId: 'skill-1', kind: 'unknown' })).toBe(false)
    expect(CONFIGURATION_EVENT_CODECS['project:changed'].validatePayload({ projectId: 'project-1', kind: 'repos' })).toBe(true)
    expect(CONFIGURATION_EVENT_CODECS['project:changed'].validatePayload({ projectId: 'project-1', kind: 'settings' })).toBe(false)
  })
  it('projects Agent metadata while excluding plaintext keys/private columns', () => {
    const encoded = projectPublicAgent(agent)
    expect(JSON.stringify(encoded)).not.toContain('fixture-private-key')
    expect(JSON.stringify(encoded)).not.toContain('fixture-private-nonce')
    expect(JSON.stringify(encoded)).not.toContain('api_keys')
    expect(codecs['agent:create'].validateResult(encoded)).toBe(true)
    expect((encoded as { config: JsonValue }).config).toMatchObject({ secret_ids: ['secret-metadata-id'], mcp_servers: [{ serverId: 'server-1', enabledTools: [] }] })
    expect(codecs['agent:create'].validateResult(agent)).toBe(false)
    expect(codecs['agent:getAll'].encodeResult([agent])).toEqual({ defined: true, value: [encoded] })
  })

  it('rejects credential writes and undeclared nested agent capabilities', () => {
    expect(() => codecs['agent:create'].decodeArguments({ data: { name: 'Synthetic', config: { api_keys: { openai: 'fixture-private-key' } } } })).toThrow()
    expect(() => codecs['agent:update'].decodeArguments({ id: 'agent-1', data: { config: { env: { TOKEN: 'fixture-private-key' } } } })).toThrow()
    expect(() => codecs['agent:create'].decodeArguments({ data: { name: 'Synthetic', server_url: 'file:///tmp/private' } })).toThrow()
    expect(() => codecs['agent:create'].decodeArguments({ data: { name: 'Synthetic', server_url: 'https://@example.com/' } })).toThrow()
    expect(() => codecs['agent:create'].decodeArguments({ data: { name: 'Synthetic', config: { max_parallel_sessions: 1.5 } } })).toThrow()
    expect(() => codecs['agent:update'].decodeArguments({ id: 'agent-1', data: { config: { fallback_agent_ids: ['agent-2', 'agent-2'] } } })).toThrow()
  })

  it('preserves declared optional fields, null scope and optimistic version arguments', () => {
    expect(codecs['skills:create'].encodeArguments([{ name: 'Synthetic', description: '', content: '\uFEFFcontent', preferred_model: undefined, project_id: null }])).toEqual({ data: { name: 'Synthetic', description: '', content: '\uFEFFcontent', project_id: null } })
    expect(codecs['skills:update'].decodeArguments({ id: 'skill-1', data: { content: 'new', expected_version: 2, preferred_model: null } })).toEqual(['skill-1', { content: 'new', expected_version: 2, preferred_model: null }])
    expect(codecs['skills:setProject'].encodeArguments(['skill-1', null])).toEqual({ id: 'skill-1', projectId: null })
    expect(() => codecs['skills:update'].decodeArguments({ id: 'skill-1', data: { project_id: 'project-2' } })).toThrow()
    expect(() => codecs['skills:update'].decodeArguments({ id: 'skill-1', data: { expected_version: 0 } })).toThrow()
    expect(codecs['skills:update'].encodeResult(skill)).toEqual({ defined: true, value: expect.not.objectContaining({ is_deleted: expect.anything() }) })
    expect(codecs['skills:update'].encodeResult(skill)).toMatchObject({ value: { content: '\uFEFFinstructions 你好', version: 2 } })
    expect(CONFIGURATION_OWNER_REQUIREMENTS['skills:update']).toContain('conflict')
  })

  it('rejects owner-dependent project mutations and preserves archive defaults', () => {
    expect(codecs['project:archive'].encodeArguments(['project-1', undefined])).toEqual({ id: 'project-1' })
    expect(codecs['project:archive'].decodeArguments({ id: 'project-1', archived: false })).toEqual(['project-1', false])
    expect(() => codecs['project:update'].decodeArguments({ id: 'project-1', data: { settings: { limits: { paused: false } } } })).toThrow()
    expect(() => codecs['project:update'].decodeArguments({ id: 'project-1', data: { captain_agent_id: 'agent-2' } })).toThrow()
    expect(CONFIGURATION_OWNER_REQUIREMENTS['agent:update']).toContain('drainStartQueue')
  })

  it('encodes repository/resource metadata without granting filesystem or URL authority', () => {
    expect(codecs['projectRepo:add'].encodeArguments(['project-1', { name: 'repo', provider: 'gitlab', org: 'group/subgroup', default_branch: null }])).toEqual({ projectId: 'project-1', data: { name: 'repo', provider: 'gitlab', org: 'group/subgroup', default_branch: null } })
    expect(codecs['projectResource:add'].decodeArguments({ projectId: 'project-1', data: { label: 'Context', url: 'file:///example/context', notes: 'notes' } })).toEqual(['project-1', { label: 'Context', url: 'file:///example/context', notes: 'notes' }])
    expect(() => codecs['projectRepo:reorder'].decodeArguments({ projectId: 'project-1', orderedIds: ['repo-1', 'repo-1'] })).toThrow()
    expect(() => codecs['projectResource:add'].decodeArguments({ projectId: 'project-1', data: { label: 'Context', url: Buffer.from('bytes') } } as unknown as JsonValue)).toThrow()
    expect(codecs['projectResource:reorder'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['projectRepo:remove'].encodeResult(false)).toEqual({ defined: true, value: false })
    expect(codecs['projectRepo:remove'].validateWireResult({ defined: false })).toBe(false)
  })
})
