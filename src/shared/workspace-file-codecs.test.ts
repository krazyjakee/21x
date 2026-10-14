import { describe, expect, it } from 'vitest'
import { WORKSPACE_FILE_CODECS, WORKSPACE_FILE_OPERATIONS, WORKSPACE_FILE_LIMITS } from './workspace-file-codecs'

describe('four finite workspace-file codecs', () => {
  it('preserves exact request keys and missing/null/value result semantics', () => {
    expect(Object.keys(WORKSPACE_FILE_CODECS)).toEqual([...WORKSPACE_FILE_OPERATIONS])
    expect(WORKSPACE_FILE_CODECS['tasks:getWorkspaceDir'].encodeArguments(['literal-task'])).toEqual({ taskId: 'literal-task' })
    for (const operation of ['shell:readTextFile', 'shell:openPath', 'shell:showItemInFolder'] as const) {
      expect(WORKSPACE_FILE_CODECS[operation].encodeArguments(['/workspace/task/file.txt'])).toEqual({ filePath: '/workspace/task/file.txt' })
      expect(WORKSPACE_FILE_CODECS[operation].decodeArguments({ filePath: '/workspace/task/file.txt' })).toEqual(['/workspace/task/file.txt'])
    }
    expect(WORKSPACE_FILE_CODECS['tasks:getWorkspaceDir'].encodeResult('/workspace/literal-task')).toEqual({ defined: true, value: '/workspace/literal-task' })
    expect(WORKSPACE_FILE_CODECS['shell:readTextFile'].encodeResult(null)).toEqual({ defined: true, value: null })
    for (const operation of ['shell:openPath', 'shell:showItemInFolder'] as const) {
      const codec = WORKSPACE_FILE_CODECS[operation]
      expect(codec.encodeResult(undefined)).toEqual({ defined: false }); expect(codec.decodeResult(undefined)).toBeUndefined()
      expect(codec.validateWireResult({ defined: false })).toBe(true); expect(codec.validateWireResult({ defined: false, value: null })).toBe(false)
      expect(() => codec.encodeResult(null)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    }
  })
  it('supports bounded real Unicode POSIX/Windows-drive/UNC absolute DTO paths without granting them', () => {
    for (const path of ['/tmp/研究/任务/🦀 résumé.txt', 'C:\\Users\\研究\\任务\\résumé.txt', '\\\\server\\share\\任务\\résumé.txt', 'C:/Users/research/task/file.txt']) {
      const codec = WORKSPACE_FILE_CODECS['shell:readTextFile']
      expect(codec.decodeArguments(codec.encodeArguments([path]))).toEqual([path]); expect(WORKSPACE_FILE_CODECS['tasks:getWorkspaceDir'].validateResult(path)).toBe(true)
    }
  })
  it('refuses relative/control/lossy Unicode paths, injected task/root fields and malformed IDs', () => {
    for (const path of ['./relative.txt', 'C:relative.txt', 'https://foreign.example/file', '/tmp/control\nfile', '/tmp/\u0000file', '/tmp/\uD800file', '/' + 'é'.repeat(WORKSPACE_FILE_LIMITS.pathBytes)]) expect(() => WORKSPACE_FILE_CODECS['shell:readTextFile'].encodeArguments([path])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    for (const id of ['../task', 'task/other', '', 't'.repeat(129)]) expect(() => WORKSPACE_FILE_CODECS['tasks:getWorkspaceDir'].encodeArguments([id])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => WORKSPACE_FILE_CODECS['shell:readTextFile'].decodeArguments({ filePath: '/workspace/task/file', taskId: 'foreign', root: '/private' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => WORKSPACE_FILE_CODECS['tasks:getWorkspaceDir'].decodeArguments({ taskId: 'task', workspaceRoot: '/private' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
  })
  it('retains large-file metadata and safe size while refusing content truncation claims or oversized/lossy output', () => {
    const codec = WORKSPACE_FILE_CODECS['shell:readTextFile']
    expect(codec.decodeResult({ content: '', size: Number.MAX_SAFE_INTEGER })).toEqual({ content: '', size: Number.MAX_SAFE_INTEGER })
    expect(codec.encodeResult({ content: 'é'.repeat(65536), size: 131072 }).defined).toBe(true)
    for (const value of [{ content: 'Partial preview', size: 131073 }, { content: 'é'.repeat(65537), size: 131074 }, { content: '\uD800', size: 1 }, { content: '', size: Number.MAX_SAFE_INTEGER + 1 }, { content: '', size: -1 }, { content: '', size: NaN }, { content: '', size: 0, token: 'private' }]) expect(() => codec.encodeResult(value)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
  })
  it('bounds the complete envelope even for the worst JSON text escaping', () => {
    const encoded = WORKSPACE_FILE_CODECS['shell:readTextFile'].encodeResult({ content: '\u0001'.repeat(WORKSPACE_FILE_LIMITS.contentBytes), size: WORKSPACE_FILE_LIMITS.contentBytes })
    expect(new TextEncoder().encode(JSON.stringify(encoded)).length).toBeLessThan(WORKSPACE_FILE_LIMITS.resultBytes)
    expect(WORKSPACE_FILE_CODECS['shell:readTextFile'].validateWireResult(encoded)).toBe(true)
  })
})
