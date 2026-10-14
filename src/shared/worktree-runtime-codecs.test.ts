import { describe, expect, it } from 'vitest'
import { WORKTREE_RUNTIME_CODECS as codecs, WORKTREE_RUNTIME_EVENT_CODECS as events, WORKTREE_RUNTIME_OPERATIONS, WORKTREE_RUNTIME_LIMITS, WORKTREE_RUNTIME_ERROR, WORKSPACE_RUNTIME_ERROR } from './worktree-runtime-codecs'

describe('finite retained worktree contracts', () => {
  it('keeps six exact controls, optional arguments and void/null results', () => {
    expect(WORKTREE_RUNTIME_OPERATIONS).toHaveLength(6)
    const setup = ['task-1', [{ fullName: 'team/repo', defaultBranch: 'main' }], 'team', undefined] as const
    expect(codecs['worktree:setup'].encodeArguments([...setup] as never)).toEqual({ taskId: 'task-1', repos: setup[1], org: 'team' })
    expect(codecs['worktree:setup'].decodeArguments({ taskId: 'task-1', repos: [{ fullName: 'team/repo', defaultBranch: 'main' }], org: 'team' })).toEqual([...setup])
    expect(codecs['worktree:cleanup'].encodeArguments(['task-1', [], '', false])).toEqual({ taskId: 'task-1', repos: [], org: '', removeTaskDir: false })
    expect(codecs['worktree:cleanup'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['worktree:readFile'].encodeResult(null)).toEqual({ defined: true, value: null })
  })
  it('refuses roots, endpoints, provider extras, escaping paths and ambiguous namespaces', () => {
    for (const filePath of ['../private', '/private', 'C:\\private', 'repo/../../private', 'a\0b']) expect(() => codecs['worktree:readFile'].decodeArguments({ taskId: 'task-1', repoFullName: null, filePath })).toThrow()
    expect(() => codecs['worktree:setup'].decodeArguments({ taskId: 'task-1', repos: [{ fullName: 'team/repo', defaultBranch: 'main', cloneUrl: 'https://foreign.example/repo.git' }], org: 'team' })).toThrow()
    expect(() => codecs['worktree:files'].decodeArguments({ taskId: 'task-1', repos: [], workspaceRoot: undefined } as never)).toThrow()
    expect(codecs['worktree:files'].validateArguments(['task-1', [{ fullName: 'a/repo' }, { fullName: 'b/repo' }]])).toBe(false)
    expect(codecs['worktree:setup'].validateArguments(['task-1', [{ fullName: 'team/repo', defaultBranch: '--help' }], 'team'])).toBe(false)
    expect(codecs['worktree:readFile'].decodeArguments({ taskId: 'task-1', repoFullName: null, filePath: './notes/日本語.md' })).toEqual(['task-1', null, './notes/日本語.md'])
  })
  it('preserves useful binary/truncated metadata and enforces preview and encoded-envelope limits', () => {
    for (const result of [{ content: '', size: 300000, binary: false, truncated: true }, { content: '', size: 12, binary: true, truncated: false }, { content: 'actual text', size: 11, binary: false, truncated: false }]) expect(codecs['worktree:readFile'].decodeResult(result)).toEqual(result)
    expect(codecs['worktree:readFile'].validateResult({ content: 'x'.repeat(WORKTREE_RUNTIME_LIMITS.previewBytes + 1), size: 200000, binary: false, truncated: false })).toBe(false)
    expect(codecs['worktree:readFile'].validateResult({ content: 'not binary', size: 10, binary: true, truncated: false })).toBe(false)
    expect(codecs['worktree:readFile'].validateResult({ content: '', size: Number.MAX_SAFE_INTEGER + 1, binary: false, truncated: true })).toBe(false)
    const oversized = Array.from({ length: 8 }, (_, i) => ({ repo: `team/repo${i}`, diff: '\0'.repeat(20000) }))
    expect(() => codecs['worktree:changes'].encodeResult(oversized)).toThrow()
  })
  it('projects existing metadata without private diagnostics or signed URL material', () => {
    const encoded = codecs['worktree:changes'].encodeResult([{ repo: 'team/repo', diff: '', branch: undefined, error: 'private token', prUrl: 'https://user:secret@github.com/team/repo/pull/4?signature=secret#token' }])
    expect(encoded).toEqual({ defined: true, value: [{ repo: 'team/repo', diff: '', error: WORKTREE_RUNTIME_ERROR, prUrl: 'https://github.com/team/repo/pull/4' }] })
    expect(JSON.stringify(encoded)).not.toContain('secret')
    expect(codecs['worktree:files'].validateResult([{ repo: 'team/repo', allFiles: Array.from({ length: 4097 }, (_, i) => `file-${i}`) }])).toBe(false)
    expect(codecs['worktree:files'].validateResult([{ repo: 'team/repo', allFiles: ['../private'] }])).toBe(false)
  })
  it('uses only three actual bounded progress events and fixed failure fields', () => {
    expect(Object.keys(events)).toEqual(['worktree:progress', 'workspace:cleanup-progress', 'workspace:cleanup-complete'])
    expect(events['worktree:progress'].encodePayload({ taskId: 'task-1', repo: 'repo', step: 'error', done: true, error: 'private diagnostic' })).toEqual({ taskId: 'task-1', repo: 'repo', step: 'error', done: true, error: WORKTREE_RUNTIME_ERROR })
    expect(events['workspace:cleanup-complete'].encodePayload({ cleaned: 0, errors: ['private diagnostic'] })).toEqual({ cleaned: 0, errors: [WORKSPACE_RUNTIME_ERROR] })
    expect(events['worktree:progress'].validatePayload({ taskId: '', repo: 'repo', step: 'cloning', done: false })).toBe(false)
    expect(events['workspace:cleanup-progress'].validatePayload({ phase: 'done', current: 0, total: -1 })).toBe(false)
  })
})
