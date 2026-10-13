import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeManager } from './worktree-manager-core'

const command = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: command.execFile }))
afterEach(() => { vi.restoreAllMocks(); command.execFile.mockReset() })

describe('portable worktree host and command lifetime', () => {
  it('uses the trusted workspace root for actual files and refuses new work after close', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-host-'))
    const workspaceRoot = join(root, 'workspaces')
    mkdirSync(join(workspaceRoot, 'fixture-task'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'fixture-task', 'result.txt'), 'fixture result')
    const owner = new WorktreeManager({ reposRoot: join(root, 'repos'), workspaceRoot, emitProgress: vi.fn() })
    try {
      expect(owner.readTaskFile('fixture-task', null, 'result.txt')?.content).toBe('fixture result')
      expect(owner.readTaskFile('fixture-task', null, '../outside.txt')).toBeNull()
      await owner.close()
      expect(() => owner.readTaskFile('fixture-task', null, 'result.txt')).toThrow('OWNER_CLOSING')
      await expect(owner.getTaskFiles('fixture-task', [])).rejects.toThrow('OWNER_CLOSING')
    } finally { await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('retains a raw git cleanup callback and prevents fallback filesystem removal after shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-worktree-drain-'))
    const reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces')
    mkdirSync(join(reposRoot, 'fixture-org', 'fixture-repo.git'), { recursive: true })
    const taskDir = join(workspaceRoot, 'fixture-task', 'fixture-repo')
    mkdirSync(taskDir, { recursive: true }); writeFileSync(join(taskDir, 'retain.txt'), 'retain')
    let finish!: (error: Error | null, stdout?: string, stderr?: string) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    command.execFile.mockImplementation((_file, _args, _options, callback) => { finish = callback; entered() })
    const owner = new WorktreeManager({ reposRoot, workspaceRoot, emitProgress: vi.fn() })
    const work = owner.cleanupTaskWorkspace('fixture-task', [{ fullName: 'fixture-org/fixture-repo' }], 'fixture-org')
    const failed = expect(work).rejects.toThrow('OWNER_CLOSING')
    try {
      await started
      await expect(owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
      expect(readFileSync(join(taskDir, 'retain.txt'), 'utf8')).toBe('retain')
      finish(new Error('controlled git refusal'))
      await failed
      await owner.close()
      expect(readFileSync(join(taskDir, 'retain.txt'), 'utf8')).toBe('retain')
      expect(command.execFile).toHaveBeenCalledOnce()
    } finally { finish?.(new Error('fixture finished')); await failed; await owner.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
