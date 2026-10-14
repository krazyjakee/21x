import { describe, expect, it } from 'vitest'
import { ARTIFACT_NATIVE_CALLBACK_SCHEMAS, isArtifactClipboardReceipt, isArtifactClipboardResult, isPrivateArtifactCopy, isPrivateArtifactCopyCheck } from './artifact-native-callbacks'
const authorizationId = '12345678-1234-4234-9234-123456789abc'
const identity = (path: string, kind = 'directory') => ({ path, kind, dev: '1', ino: '2', size: '4096', nlink: kind === 'file' ? '1' : '2' })
const receipt = { version: 1, taskId: 'task_fixture', workspaceRoot: '/workspace', path: '/workspace/task_fixture/report.md', root: identity('/workspace'), ancestors: [identity('/workspace/task_fixture')], target: identity('/workspace/task_fixture/report.md', 'file') }
describe('private artifact clipboard contracts', () => {
  it('admits exact authorized file references and private fixed modes only', () => {
    const schema = ARTIFACT_NATIVE_CALLBACK_SCHEMAS['host.artifact.copyFile'], payload = { receipt, leaseId: 'document_fixture_1', authorizationId }
    expect(schema.validatePayload(payload)).toBe(true)
    for (const value of [{ ...payload, filePath: '/private' }, { ...payload, authorizationId: '../scope' }, { ...payload, leaseId: '' }, { receipt, leaseId: payload.leaseId }]) expect(schema.validatePayload(value)).toBe(false)
    expect(isArtifactClipboardResult({ mode: 'file' })).toBe(true); expect(isArtifactClipboardResult({ mode: 'unavailable' })).toBe(true)
    for (const value of [{ mode: 'image' }, { mode: 'path' }, { mode: 'file', path: '/private' }, {}]) expect(schema.validateResult(value)).toBe(false)
  })
  it('requires bounded single-link regular metadata and preserves the separate caller path grammar', () => {
    expect(isArtifactClipboardReceipt(receipt)).toBe(true)
    for (const target of [{ ...receipt.target, kind: 'directory' }, { ...receipt.target, nlink: '2' }, { ...receipt.target, size: String(64 * 1024 * 1024 + 1) }]) expect(isArtifactClipboardReceipt({ ...receipt, target })).toBe(false)
    const request = { taskId: 'task_fixture', relativePath: 'results/你好 report #1.png', leaseId: 'document_fixture_1' }
    expect(isPrivateArtifactCopy(request)).toBe(true)
    for (const relativePath of ['../secret', '/private', 'foo//bar', 'foo/./bar', 'foo\\bar']) expect(isPrivateArtifactCopy({ ...request, relativePath })).toBe(false)
    expect(isPrivateArtifactCopy({ ...request, receipt })).toBe(false)
    expect(isPrivateArtifactCopyCheck({ authorizationId })).toBe(true)
    expect(isPrivateArtifactCopyCheck({ authorizationId, taskId: 'task_fixture' })).toBe(false)
  })
})
