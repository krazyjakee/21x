import { describe, expect, it } from 'vitest'
import { isWorkspacePathReceipt, WORKSPACE_NATIVE_CALLBACK_SCHEMAS } from './workspace-native-callbacks'
import type { WorkspacePathIdentity, WorkspacePathReceipt } from './workspace-native-callbacks'

const identity = (path: string, kind: WorkspacePathIdentity['kind'] = 'directory'): WorkspacePathIdentity => ({ path, kind, dev: '1', ino: '2', size: '4096', nlink: kind === 'file' ? '1' : '2' })
const receipt = (): WorkspacePathReceipt => ({ version: 1, taskId: 'task_fixture', workspaceRoot: '/workspace', path: '/workspace/task_fixture/report.md', root: identity('/workspace'), ancestors: [identity('/workspace/task_fixture')], target: identity('/workspace/task_fixture/report.md', 'file') })
describe('private captured workspace file callbacks', () => {
  it('admits only the two exact captured receipt callbacks and empty acknowledgements', () => {
    expect(Object.keys(WORKSPACE_NATIVE_CALLBACK_SCHEMAS)).toEqual(['host.workspace.openPath', 'host.workspace.showItemInFolder'])
    for (const schema of Object.values(WORKSPACE_NATIVE_CALLBACK_SCHEMAS)) {
      expect(schema.validatePayload({ receipt: receipt() })).toBe(true)
      expect(schema.validatePayload({ receipt: receipt(), root: '/private' })).toBe(false)
      expect(schema.validatePayload({ filePath: '/private' })).toBe(false)
      expect(schema.validateResult({})).toBe(true)
      expect(schema.validateResult({ path: '/private' })).toBe(false)
    }
  })
  it('rejects authority injection and imprecise or malformed metadata', () => {
    const expected = receipt()
    for (const altered of [{ ...expected, grant: true }, { ...expected, version: 2 }, { ...expected, taskId: '../private' }, { ...expected, path: '/workspace\0/private' }, { ...expected, root: { ...expected.root, path: '/other' } }, { ...expected, target: { ...expected.target, path: '/other' } }, { ...expected, ancestors: [{ ...expected.ancestors[0], kind: 'file' }] }, { ...expected, target: { ...expected.target, nlink: '2' } }]) expect(isWorkspacePathReceipt(altered)).toBe(false)
    for (const value of [1, '-1', '01', '1.0', '1e3', '18446744073709551616', '0']) expect(isWorkspacePathReceipt({ ...expected, target: { ...expected.target, nlink: value } })).toBe(false)
    expect(isWorkspacePathReceipt({ ...expected, root: { ...expected.root, ino: '18446744073709551615' } })).toBe(true)
  })
  it('bounds path bytes, ancestors and complete receipts without creating a grant', () => {
    const expected = receipt()
    expect(isWorkspacePathReceipt({ ...expected, path: '/' + 'é'.repeat(4096) })).toBe(false)
    expect(isWorkspacePathReceipt({ ...expected, ancestors: Array.from({ length: 65 }, () => expected.ancestors[0]) })).toBe(false)
    const long = '/' + '"'.repeat(4000)
    expect(isWorkspacePathReceipt({ ...expected, ancestors: Array.from({ length: 64 }, () => identity(long)) })).toBe(false)
    expect(isWorkspacePathReceipt({ ...expected, root: { ...expected.root, size: '10', nlink: '3' } })).toBe(true)
  })
})
