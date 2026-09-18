import { describe, it, expect } from 'vitest'

import {
  claudeServerPrefix,
  claudeToolIds,
  opencodeDisallowedToolMap,
  readServerToolLimits,
  resolveAllowedToolNames,
  resolveDisallowedToolNames
} from './mcp-tool-limits'

/**
 * Most cases below are about one distinction: `undefined` (no limit) versus
 * `[]` (a limit of nothing).
 */
describe('readServerToolLimits', () => {
  it('reads an entry with enabledTools, which is what AgentForm writes', () => {
    const limits = readServerToolLimits([{ serverId: 'a', enabledTools: ['one', 'two'] }])
    expect(limits.get('a')).toEqual(['one', 'two'])
  })

  it('treats a bare string and an entry without enabledTools as unrestricted', () => {
    const limits = readServerToolLimits(['a', { serverId: 'b' }])
    expect(limits.get('a')).toBeUndefined()
    expect(limits.get('b')).toBeUndefined()
    // Present, but with no limit — not absent.
    expect(limits.has('a')).toBe(true)
    expect(limits.has('b')).toBe(true)
  })

  it('never throws on a malformed config', () => {
    for (const entries of [undefined, null, 'x', [null, 42, {}, { serverId: '' }]] as never[]) {
      expect(() => readServerToolLimits(entries)).not.toThrow()
    }
  })

  it('treats a malformed enabledTools as no tools, never as all tools', () => {
    const limits = readServerToolLimits([{ serverId: 'a', enabledTools: 'one' as never }])
    expect(limits.get('a')).toEqual([])
  })

  it('drops empty and duplicate tool names', () => {
    const limits = readServerToolLimits([
      { serverId: 'a', enabledTools: ['one', 'one', '', 'two'] }
    ])
    expect(limits.get('a')).toEqual(['one', 'two'])
  })
})

describe('resolveAllowedToolNames', () => {
  const serverTools = [
    { name: 'one' },
    { name: 'two' },
    { name: 'three' },
    { name: 'four' },
    { name: 'five' },
    { name: 'six' }
  ]

  it('returns TWO of SIX when two are enabled', () => {
    expect(resolveAllowedToolNames({ serverTools, limit: ['one', 'two' ] })).toEqual([
      'one',
      'two'
    ])
  })

  it('returns every tool when the limit is absent', () => {
    expect(resolveAllowedToolNames({ serverTools, limit: undefined })).toHaveLength(6)
  })

  it('returns no tools for an empty limit', () => {
    expect(resolveAllowedToolNames({ serverTools, limit: [] })).toEqual([])
  })

  it('takes the INTERSECTION, so a stale name cannot resurrect a tool', () => {
    expect(
      resolveAllowedToolNames({ serverTools, limit: ['one', 'deleted_tool'] })
    ).toEqual(['one'])
  })

  it('takes the INTERSECTION, so a NEW upstream tool is not auto-granted', () => {
    const grown = [...serverTools, { name: 'seven' }]
    expect(resolveAllowedToolNames({ serverTools: grown, limit: ['one'] })).toEqual(['one'])
  })
})

describe('resolveDisallowedToolNames', () => {
  const serverTools = [{ name: 'one' }, { name: 'two' }, { name: 'three' }]

  it('names every tool outside the limit', () => {
    expect(resolveDisallowedToolNames({ serverTools, limit: ['one'] })).toEqual([
      'two',
      'three'
    ])
  })

  it('denies NOTHING when the server is unrestricted', () => {
    expect(resolveDisallowedToolNames({ serverTools, limit: undefined })).toEqual([])
  })

  it('denies every advertised tool for an empty limit', () => {
    expect(resolveDisallowedToolNames({ serverTools, limit: [] })).toEqual(['one', 'two', 'three'])
  })
})

describe('claudeToolIds', () => {
  it('uses the mcp__server__tool form the SDK expects', () => {
    expect(claudeToolIds('task-management', 'list_tasks')).toEqual([
      'mcp__task-management__list_tasks'
    ])
  })

  it('normalizes the server name the way Claude Code does', () => {
    expect(claudeServerPrefix('My Server.io')).toBe('mcp__My_Server_io__')
    expect(claudeToolIds('My Server', 'send')).toEqual(['mcp__My_Server__send'])
  })

  it('covers both tool-name forms when the tool name needs normalizing', () => {
    expect(claudeToolIds('chat', 'send.message')).toEqual([
      'mcp__chat__send.message',
      'mcp__chat__send_message'
    ])
  })
})

describe('opencodeDisallowedToolMap', () => {
  it('maps only DENIED tools, and to false', () => {
    const map = opencodeDisallowedToolMap({
      chat: { enabledTools: ['send'], knownTools: ['send', 'delete'] }
    })
    expect(map).toEqual({ chat_delete: false })
  })

  it('never emits a bare tool name that could disable an OpenCode built-in', () => {
    const map = opencodeDisallowedToolMap({
      files: { enabledTools: ['list'], knownTools: ['list', 'read', 'bash'] }
    })
    expect(map).toEqual({ files_read: false, files_bash: false })
  })

  it('normalizes names the way OpenCode does', () => {
    const map = opencodeDisallowedToolMap({
      'My Server': { enabledTools: [], knownTools: ['send.message'] }
    })
    expect(map).toEqual({ My_Server_send_message: false })
  })

  it('is undefined for an unrestricted server, so nothing is disabled by accident', () => {
    expect(
      opencodeDisallowedToolMap({
        chat: { knownTools: ['send', 'delete'] }
      })
    ).toBeUndefined()
  })
})
