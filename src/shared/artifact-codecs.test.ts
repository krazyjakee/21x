import { describe, expect, it } from 'vitest'
import { ARTIFACT_CODECS, ARTIFACT_LIMITS, ARTIFACT_OPERATIONS, isArtifactRelativePath } from './artifact-codecs'
describe('retained artifact finite DTOs', () => {
  it('accepts exactly two task-scoped reads and rejects roots, traversal, malformed paths and extra capabilities', () => {
    expect(ARTIFACT_OPERATIONS).toEqual(['artifacts:scan', 'artifacts:read'])
    const codec = ARTIFACT_CODECS['artifacts:read']
    expect(codec.decodeArguments(codec.encodeArguments(['task-1', 'repo/reports/result.md']))).toEqual(['task-1', 'repo/reports/result.md'])
    for (const path of ['/private/result.md', '../result.md', './result.md', 'a/../result.md', 'C:/private.md', 'a\\result.md', 'a//result.md', 'file:///private', 'a\0b.md']) expect(isArtifactRelativePath(path)).toBe(false)
    expect(() => codec.decodeArguments({ taskId: 'task-1', relativePath: 'result.md', root: '/private' })).toThrow()
  })
  it('preserves actual TypeScript/YAML/HTML MIME and raw inert content without adding viewer permissions', () => {
    const codec = ARTIFACT_CODECS['artifacts:read']
    for (const [mimeType, content] of [['text/typescript', 'export const x = 1'], ['application/yaml', 'key: value'], ['text/html', '<script>window.electronAPI?.app.quit()</script>']]) {
      const value = { kind: 'text', content, mimeType }
      const encoded = codec.encodeResult(value); if (!encoded.defined) throw new Error('Fixture result missing')
      expect(codec.decodeResult(encoded.value)).toEqual(value)
    }
    expect(codec.validateResult({ kind: 'text', content: 'hello', mimeType: 'text/plain', privileged: true })).toBe(false)
    expect(codec.validateResult({ kind: 'text', content: 'hello', mimeType: 'application/pdf' })).toBe(false)
  })
  it('bounds actual text/base64 payloads and the complete serialized result before private transport publication', () => {
    const codec = ARTIFACT_CODECS['artifacts:read']
    const image = { kind: 'data_url', mimeType: 'image/png', content: `data:image/png;base64,${Buffer.alloc(ARTIFACT_LIMITS.imageBytes).toString('base64')}` }
    expect(codec.validateResult(image)).toBe(true)
    expect(codec.validateResult({ ...image, content: `data:image/png;base64,${Buffer.alloc(ARTIFACT_LIMITS.imageBytes + 1).toString('base64')}` })).toBe(false)
    expect(codec.validateResult({ kind: 'data_url', mimeType: 'image/png', content: 'https://outside.example/image.png' })).toBe(false)
    expect(codec.validateResult({ kind: 'data_url', mimeType: 'image/png', content: 'data:image/svg+xml;base64,AAAA' })).toBe(false)
    expect(codec.validateResult({ kind: 'text', mimeType: 'text/plain', content: '\0'.repeat(ARTIFACT_LIMITS.textBytes) })).toBe(true)
    expect(codec.validateResult({ kind: 'text', mimeType: 'text/plain', content: 'x'.repeat(ARTIFACT_LIMITS.textBytes + 1) })).toBe(false)
  })
  it('bounds scan entries/supporting files and rejects private/absolute metadata, preserving undefined optional fields', () => {
    const codec = ARTIFACT_CODECS['artifacts:scan'], entry = { path: 'outputs/demo/index.html', title: 'demo', type: 'html', size: 1, updatedAt: 1, workpieceKey: undefined, files: ['outputs/demo/index.html'] }
    expect(codec.encodeResult([entry])).toEqual({ defined: true, value: [{ path: entry.path, title: 'demo', type: 'html', size: 1, updatedAt: 1, files: entry.files }] })
    expect(codec.validateResult([{ ...entry, path: '/private/index.html' }])).toBe(false)
    expect(codec.validateResult([{ ...entry, absolutePath: '/private/index.html' }])).toBe(false)
    expect(codec.validateResult([{ ...entry, files: ['../private/index.html'] }])).toBe(false)
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `outputs/${i}.html`, title: 'demo', type: 'html', size: 1, updatedAt: 1 }))
    expect(codec.validateResult(many)).toBe(true); expect(codec.validateResult([...many, { ...many[0]!, path: 'outputs/501.html' }])).toBe(false)
    expect(codec.validateResult([{ ...entry, size: -1 }])).toBe(false)
  })
})
