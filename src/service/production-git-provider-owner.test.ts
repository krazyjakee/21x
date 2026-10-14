import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProductionGitProviderOwner, productionForgejoCloneUrl } from './production-git-provider-owner'
import { GitProviderProcessOwner } from '../main/git-provider-process-owner'
import type { DatabaseManager } from '../main/database/manager'

const login = { name: 'fixture', url: 'https://forgejo.example.test', sshHost: 'ssh.forgejo.example.test:2222', user: 'fixture-user', isDefault: true }
const roots: string[] = [], owners: GitProviderProcessOwner[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('trusted production Git provider/worktree ownership', () => {
  it('restricts clone addresses to the selected login and repository without credential URLs', () => {
    const fullName = 'fixture/repo'
    expect(productionForgejoCloneUrl({ fullName, login })).toBe('https://forgejo.example.test/fixture/repo.git')
    for (const cloneUrl of ['git@forgejo.example.test:fixture/repo.git', 'ssh://git@ssh.forgejo.example.test:2222/fixture/repo.git']) expect(productionForgejoCloneUrl({ fullName, login, cloneUrl })).toBe(cloneUrl)
    for (const cloneUrl of ['file:///outside/repo', 'ext::arbitrary command', 'https://other.example.test/fixture/repo.git', 'https://user:private@forgejo.example.test/fixture/repo.git', 'https://forgejo.example.test/fixture/repo.git?token=private', 'git@other.example.test:fixture/repo.git', 'ssh://root@forgejo.example.test/fixture/repo.git', 'git@forgejo.example.test:other/repo.git']) expect(() => productionForgejoCloneUrl({ fullName, login, cloneUrl })).toThrow()
    expect(() => productionForgejoCloneUrl({ fullName: '../repo', login })).toThrow()
  })

  it('borrows a real captured process owner and confines worktree effects before spawning', async () => {
    const node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : ['/usr/bin/node', '/usr/local/bin/node'].find(existsSync))
    if (!node) throw new Error('STANDALONE_NODE_FIXTURE_REQUIRED')
    const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-production-git-'))); roots.push(root)
    const script = join(root, 'fixture.cjs'), profileRoot = join(root, 'profile'), reposRoot = join(root, 'repos'), workspaceRoot = join(root, 'workspaces'), tempRoot = join(root, 'temp')
    mkdirSync(profileRoot); mkdirSync(tempRoot)
    writeFileSync(script, `require('node:fs').writeFileSync('command-receipt.txt',JSON.stringify(process.argv.slice(2)));process.stdout.write('captured')`)
    const boundary = vi.fn<typeof execFile>(execFile)
    let current = true
    const owner = createProductionGitProviderOwner({ database: { getSetting: () => null } as unknown as DatabaseManager, profileRoot, reposRoot, workspaceRoot, tempRoot,
      assertCurrent() { if (!current) throw new Error('FIXTURE_OWNER_LOST') }, createProcess(options) {
        const actual = new GitProviderProcessOwner({ ...options, execFile: boundary as unknown as typeof execFile, environment: { PATH: root }, fixture: { executables: { git: { file: node, prefix: [script] } } } }); owners.push(actual); return actual
      } })
    owner.github.assertOwners(owner.processOwner); owner.gitlab.assertOwners(owner.processOwner); owner.forgejo.assertOwners(owner.processOwner)
    await expect(owner.exec('git', ['status'], { cwd: root })).rejects.toThrow('WORKTREE_PATH_UNAUTHORIZED')
    expect(boundary).not.toHaveBeenCalled()
    expect(await owner.exec('git', ['status'], { cwd: reposRoot })).toEqual({ stdout: 'captured', stderr: '' })
    expect(existsSync(join(reposRoot, 'command-receipt.txt'))).toBe(true)
    current = false
    expect(() => owner.assertPath(reposRoot)).toThrow('FIXTURE_OWNER_LOST')
    await expect(owner.processOwner.execWorktree('git', ['status'], { cwd: reposRoot })).rejects.toThrow('FIXTURE_OWNER_LOST')
    expect(boundary).toHaveBeenCalledOnce()
  })
})
