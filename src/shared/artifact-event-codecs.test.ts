import { describe, expect, it } from 'vitest'
import { ARTIFACT_EVENT_CODECS, ARTIFACT_EVENT_LIMITS } from './artifact-event-codecs'
import { ArtifactType } from './artifacts'

const codec = ARTIFACT_EVENT_CODECS['artifact:updated']
const file = { id: 'task-1:workpiece:notes', taskId: 'task-1', type: ArtifactType.MARKDOWN, title: 'Notes 雪', path: 'artifacts/notes/README.md', files: ['artifacts/notes/README.md'], workpieceKey: 'notes', updatedAt: 1730000000123.5, reloadTrigger: 1730000000123 }
const pull = { id: 'task-1:pr:1', taskId: 'task-1', type: ArtifactType.PR, title: 'Pull request #1', url: 'https://github.com/acme/app/pull/1', updatedAt: 1730000000123, reloadTrigger: 0 }
const paths = (count: number) => Array.from({ length: count }, (_, index) => `${index}-${'a'.repeat(600)}`)

describe('artifact:updated wire contract', () => {
  it('round-trips the task-tool and transcript artifact shapes Electron sends', () => {
    for (const artifact of [file, pull]) {
      const source = { taskId: 'task-1', artifact }
      const wire = codec.encodePayload(source)
      expect(wire).toEqual(source)
      expect(codec.validatePayload(wire)).toBe(true)
      expect(codec.decodePayload(wire)).toEqual(source)
    }
    expect(codec.dropInvalid).toBe(true)
  })

  it('removes absent optional fields, including a workpiece with no entry file yet', () => {
    const wire = codec.encodePayload({ taskId: 'task-1', artifact: { ...file, path: undefined, url: undefined } }) as unknown as { artifact: Record<string, unknown> }
    expect(Object.hasOwn(wire.artifact, 'path')).toBe(false)
    expect(Object.hasOwn(wire.artifact, 'url')).toBe(false)
    expect(codec.validatePayload(wire)).toBe(true)
  })

  it.each([
    ['an undeclared field', { ...file, secret: 'private' }],
    ['another task', { ...file, taskId: 'task-2' }],
    ['an id from another task', { ...file, id: 'task-2:workpiece:notes' }],
    ['an unknown type', { ...file, type: 'script' }],
    ['a blank title', { ...file, title: '   ' }],
    ['a control character', { ...file, title: 'Notes\n' }],
    ['an absolute path', { ...file, path: '/home/private/notes.md' }],
    ['a parent path', { ...file, path: '../notes.md' }],
    ['a drive path', { ...file, path: 'C:\\private\\notes.md' }],
    ['a url on a file', { ...file, url: 'https://github.com/acme/app/pull/1' }],
    ['a path on a pull request', { ...pull, path: 'notes.md' }],
    ['a pull request with no url', { ...pull, url: undefined }],
    ['a negative time', { ...file, updatedAt: -1 }],
    ['an infinite time', { ...file, updatedAt: Number.POSITIVE_INFINITY }],
    ['a fractional reload trigger', { ...file, reloadTrigger: 1.5 }],
    ['duplicate files', { ...file, files: ['a.md', 'a.md'] }],
    ['too many files', { ...file, files: Array.from({ length: 501 }, (_, index) => `${index}.md`) }],
    ['an empty workpiece key', { ...file, workpieceKey: '' }]
  ])('refuses %s', (_name, artifact) => {
    const payload = { taskId: 'task-1', artifact }
    expect(() => codec.encodePayload(payload)).toThrow()
    expect(codec.validatePayload(payload)).toBe(false)
    expect(() => codec.decodePayload(payload as never)).toThrow()
  })

  it.each([
    'https://x-access-token:ghp_private@github.com/acme/app/pull/1',
    'https://github.com/acme/app/pull/1?token=private',
    'https://github.com/acme/app/pull/1#private',
    'https://github.com\\@foreign.example/pull/1',
    'https://github.com/acme/app/pull/1 ',
    'file:///etc/passwd',
    'https://'
  ])('refuses the link %s', url => {
    expect(() => codec.encodePayload({ taskId: 'task-1', artifact: { ...pull, url } })).toThrow()
  })

  it('refuses malformed envelopes', () => {
    for (const payload of [null, 'text', [], {}, { taskId: 'task-1' }, { artifact: file }, { taskId: '../task', artifact: file }, { taskId: 'task-1', artifact: 'text' }, { taskId: 'task-1', artifact: file, sessionId: 'private' }]) {
      expect(() => codec.encodePayload(payload)).toThrow()
      expect(codec.validatePayload(payload)).toBe(false)
    }
  })

  it('enforces the frame limit that production_contracts.rs also applies', () => {
    expect(ARTIFACT_EVENT_LIMITS.eventBytes).toBe(256 * 1024)
    expect(codec.validatePayload({ taskId: 'task-1', artifact: { ...file, files: paths(400) } })).toBe(true)
    expect(codec.validatePayload({ taskId: 'task-1', artifact: { ...file, files: paths(500) } })).toBe(false)
  })
})
