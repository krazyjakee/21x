import { ProductionWorkspaceProcessOwner } from './production-workspace-process-owner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import { SyncManager } from '../main/sync-manager'
import { PluginRegistry } from '../main/plugins/registry'
import { WorktreeManager, WORKTREE_PORTABLE_LIMITS } from '../main/worktree-manager-core'
import { WorktreeDirectoryAuthority } from '../main/worktree-directory-authority'
import { WorkspaceCleanupSchedulerCore, createBoundedWorkspaceCleanupStore } from '../main/workspace-cleanup-scheduler-core'
import { WorkspaceFileOwner } from '../main/workspace-file-owner'
import { GitProviderProcessOwner } from '../main/git-provider-process-owner'
import { GitHubManager } from '../main/github-manager'
import { GitLabManager } from '../main/gitlab-manager'
import { ForgejoManager } from '../main/forgejo-manager'
import { WORKTREE_RUNTIME_CODECS, WORKTREE_RUNTIME_OPERATIONS, WORKTREE_RUNTIME_LIMITS, type WorktreeRuntimeCodec, type WorktreeRuntimeOperation } from '../shared/worktree-runtime-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { WorktreeRuntimeBackend, type WorktreeRuntimeBackendOptions } from './worktree-runtime-backend'

class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); killed = false; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null
  kill = vi.fn(() => { this.killed = true; return true })
  constructor(readonly callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) { super() }
  finish(stdout: string) { this.callback(null, stdout, ''); this.stdout.destroy(); this.stderr.destroy(); this.exitCode = 0; this.emit('exit', 0, null); this.emit('close', 0, null) }
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'worktree-runtime-fixture', webviewId: 'main', origin: 'app://worktree-runtime' }
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, sync: SyncManager, processOwner: GitProviderProcessOwner, worktrees: WorktreeManager, files: WorkspaceFileOwner, cleanup: WorkspaceCleanupSchedulerCore, backend: WorktreeRuntimeBackend, options: WorktreeRuntimeBackendOptions
let root: string, workspaceRoot: string, reposRoot: string, projectId: string, allowed: boolean, ownerValid: boolean, global: boolean, repoAllowed: boolean
let afterOpen: (() => Promise<void>) | null, releases: Array<() => void>, commands: Array<{ file: string; args: readonly string[] }>, children: Child[]
beforeEach(() => {
  db = createPortableTestDb(); workspaceRoot = dirname(db.getWorkspaceDir('fixture')); root = dirname(workspaceRoot); reposRoot = join(root, 'repos'); mkdirSync(reposRoot); const home = join(root, 'git-home'); mkdirSync(home)
  projectId = db.getDefaultProject()!.id; allowed = ownerValid = global = repoAllowed = true; afterOpen = null; releases = []; commands = []; children = []
  const current = (): void => { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }
  const execute = (file: string, args: readonly string[], _opts: unknown, callback: Child['callback']): ChildProcess => {
    const child = new Child(callback); children.push(child); commands.push({ file, args })
    queueMicrotask(() => child.finish(file === 'gh' && args[0] === 'api' ? JSON.stringify([{ name: 'repo', full_name: 'team/repo', default_branch: 'main', clone_url: 'https://github.com/team/repo.git', private: true }]) : args.includes('ls-files') ? 'result.txt\0' : ''))
    return child as unknown as ChildProcess
  }
  processOwner = new GitProviderProcessOwner({ execFile: execute as unknown as typeof execFile, home, cwd: root, environment: { PATH: '/synthetic-only' }, assertCurrent: current, worktreeRoots: [workspaceRoot, reposRoot] })
  const github = new GitHubManager({ process: processOwner }), gitlab = new GitLabManager({ process: processOwner }), forgejo = new ForgejoManager(key => db.getSetting(key), { process: processOwner })
  const paths = new WorktreeDirectoryAuthority([reposRoot, workspaceRoot], current)
  worktrees = new WorktreeManager({ reposRoot, workspaceRoot, portableLimits: WORKTREE_PORTABLE_LIMITS, emitProgress: vi.fn(), assertPath: path => paths.assertPath(path), exec: (file, args, opts) => processOwner.execWorktree(file, args, { cwd: String(opts?.cwd ?? reposRoot), maxBuffer: opts?.maxBuffer, timeout: opts?.timeout, allowDiffExitOne: opts?.allowDiffExitOne }) }); worktrees.setForgejoManager(forgejo)
  files = new WorkspaceFileOwner({ workspaceRoot, assertCurrent: current, fs: { open: async (path, flags) => { const handle = await open(path, flags); await afterOpen?.(); return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() } } } })
  manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false }); sync = new SyncManager(db, new PluginRegistry())
  db.setSetting('workspace_nodemodules_gc_enabled', 'false')
  cleanup = new WorkspaceCleanupSchedulerCore(db, worktrees, { workspacesRoot: workspaceRoot, listWorkspaceDirs: () => { throw new Error('Ambient listing forbidden') }, portablePolicy: { beforeEffect: current, store: createBoundedWorkspaceCleanupStore(db, current) } })
  options = { database: db, manager, sync, processOwner, worktrees, files, github, gitlab, forgejo, cleanup, workspaceRoot, reposRoot, engineEpoch: caller.engineEpoch, assertAvailable: current, assertWorktreeRuntimeOwners(value) { current(); for (const key of ['database','manager','sync','processOwner','worktrees','files','github','gitlab','forgejo','cleanup','workspaceRoot','reposRoot'] as const) if (value[key] !== options[key]) throw new ServiceProtocolError('DISCONNECTED') }, isTrustedDesktop: value => value.origin === caller.origin && value.webviewId === caller.webviewId, canManageGlobalConfiguration: () => global, canAccessTask: () => allowed, canAccessProject: () => allowed, canAccessAgent: () => allowed, canAccessSource: () => allowed, canAccessRepository: () => repoAllowed, beforeWorkspaceMutation() { current(); if (files.inflightCount) throw new ServiceProtocolError('BACKPRESSURE') } }
  backend = new WorktreeRuntimeBackend(options); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const release of releases) release(); allowed = ownerValid = global = repoAllowed = true
  await backend.close(); await cleanup.close(); await worktrees.close(); await processOwner.close(); await files.close(); await sync.close(); vi.restoreAllMocks(); await manager.stopAllSessions(); await manager.stopServer(); db.close(); rmSync(root, { recursive: true, force: true })
})
async function call<K extends WorktreeRuntimeOperation>(op: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = WORKTREE_RUNTIME_CODECS[op] as WorktreeRuntimeCodec<K>, encoded = await backend.registry.invoke(op, codec.encodeArguments(args), identity, signal); expect(codec.validateWireResult(encoded)).toBe(true); return codec.decodeResult((encoded as { value?: JsonValue }).value)
}
function task(repos: string[] = []) { return db.createTask({ title: 'Actual task workspace', project_id: projectId, repos })! }
describe('actual protected worktree/SQLite/file/lifecycle owners', () => {
  it('bounds the full stored task before the actual lifecycle lease getter materializes legacy text', async () => {
    const value = task(), description = 'L'.repeat(128001)
    db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run(description, value.id)
    const getter = vi.spyOn(db, 'getTask')
    await expect(call('worktree:setup', [value.id, [], '', 'github'])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect(getter).not.toHaveBeenCalled(); expect(commands).toEqual([])
    expect(existsSync(join(workspaceRoot, value.id))).toBe(false)
    expect((db.db.prepare('SELECT description FROM tasks WHERE id=?').get(value.id) as { description: string }).description).toBe(description)
  })
  it('registers six existing operations and uses real plain workspace setup, inventory, previews and cleanup', async () => {
    const value = task(); expect(Object.keys(backend.operationSchemas(caller))).toEqual([...WORKTREE_RUNTIME_OPERATIONS])
    const path = await call('worktree:setup', [value.id, [], '', 'github']); expect(path).toBe(join(workspaceRoot, value.id)); writeFileSync(join(path, 'result.txt'), 'actual result')
    expect(await call('worktree:files', [value.id, []])).toEqual([{ repo: 'Task workspace', allFiles: ['result.txt'], workspace: true }])
    expect(await call('worktree:changes', [value.id, []])).toEqual([{ repo: 'Task workspace', diff: '', allFiles: ['result.txt'], workspace: true }])
    expect(await call('worktree:readFile', [value.id, null, 'result.txt'])).toEqual({ content: 'actual result', size: 13, binary: false, truncated: false })
    expect(await call('worktree:cleanup', [value.id, [], '', false])).toBeUndefined(); expect(existsSync(path)).toBe(true)
    await call('worktree:cleanup', [value.id, [], '', true]); expect(existsSync(path)).toBe(false); expect(db.getTask(value.id)).toBeDefined(); expect(commands).toEqual([])
  })
  it('uses actual Git process owner for saved repo inventory and refuses foreign roots/repos/providers', async () => {
    const value = task(['team/repo']); mkdirSync(join(db.getWorkspaceDir(value.id), 'repo')); writeFileSync(join(workspaceRoot, value.id, 'repo', 'result.txt'), 'saved')
    expect(await call('worktree:files', [value.id, [{ fullName: 'team/repo' }]])).toContainEqual({ repo: 'team/repo', allFiles: ['result.txt'] }); expect(commands.some(command => command.file === 'git')).toBe(true)
    const count = commands.length
    await expect(call('worktree:files', [value.id, [{ fullName: 'foreign/repo' }]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('worktree:setup', [value.id, [{ fullName: 'team/repo', defaultBranch: 'main' }], 'team', 'gitlab'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    repoAllowed = false; await expect(call('worktree:files', [value.id, [{ fullName: 'team/repo' }]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(commands).toHaveLength(count)
  })
  it('preserves binary and oversized preview metadata without silently truncating text', async () => {
    const value = task(), path = db.getWorkspaceDir(value.id); writeFileSync(join(path, 'binary.bin'), Buffer.from([1, 0, 2])); writeFileSync(join(path, 'large.txt'), 'x'.repeat(WORKTREE_RUNTIME_LIMITS.previewBytes + 1))
    expect(await call('worktree:readFile', [value.id, null, 'binary.bin'])).toEqual({ content: '', size: 3, binary: true, truncated: false })
    expect(await call('worktree:readFile', [value.id, null, 'large.txt'])).toEqual({ content: '', size: 131073, binary: false, truncated: true }); expect(await call('worktree:readFile', [value.id, null, 'missing'])).toBeNull()
    const privatePath = join(root, 'private'); writeFileSync(privatePath, 'private bytes'); await symlink(privatePath, join(path, 'link'))
    await expect(call('worktree:readFile', [value.id, null, 'link'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(readFileSync(privatePath, 'utf8')).toBe('private bytes')
  })
  it('preserves literal member paths and requires all current group/anchor grants', async () => {
    const first = task(), second = task(), agent = db.createAgent({ name: 'Actual group owner' })!, group = db.createTaskGroup({ title: 'Actual group', task_ids: [first.id, second.id], agent_id: agent.id })
    const memberPath = db.getWorkspaceDir(first.id), anchorPath = db.getWorkspaceDir(group.execution_task_id)
    writeFileSync(join(memberPath, 'result.txt'), 'literal member'); writeFileSync(join(anchorPath, 'result.txt'), 'different anchor')
    expect(await call('worktree:readFile', [first.id, null, 'result.txt'])).toMatchObject({ content: 'literal member' })
    options.canAccessTask = id => id !== second.id
    await expect(call('worktree:readFile', [first.id, null, 'result.txt'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(readFileSync(join(memberPath, 'result.txt'), 'utf8')).toBe('literal member'); expect(readFileSync(join(anchorPath, 'result.txt'), 'utf8')).toBe('different anchor')
  })
  it.each(['grant','task','repository','owner'] as const)('fences %s changes after the real file descriptor is accepted', async kind => {
    const value = task(), path = db.getWorkspaceDir(value.id); writeFileSync(join(path, 'result.txt'), 'preserved')
    const gate = held(), entered = held(); releases.push(gate.release); afterOpen = async () => { entered.release(); await gate.promise }
    const pending = call('worktree:readFile', [value.id, null, 'result.txt']), failure = pending.catch(error => error); await entered.promise
    if (kind === 'grant') allowed = false
    if (kind === 'task') db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('replacement', value.id)
    if (kind === 'repository') db.addProjectRepo(projectId, { provider: 'github', org: 'changed', name: 'repo' })
    if (kind === 'owner') ownerValid = false
    gate.release(); expect((await failure).code).toBe(kind === 'owner' ? 'DISCONNECTED' : 'INVALID_REQUEST'); expect(readFileSync(join(path, 'result.txt'), 'utf8')).toBe('preserved')
  })
  it('retains accepted file work and borrowed owners after cancellation/shutdown timeout', async () => {
    const value = task(), path = db.getWorkspaceDir(value.id); writeFileSync(join(path, 'result.txt'), 'retained')
    const gate = held(), entered = held(); releases.push(gate.release); afterOpen = async () => { entered.release(); await gate.promise }
    const pending = call('worktree:readFile', [value.id, null, 'result.txt']), failure = pending.catch(error => error); await entered.promise
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1); expect(files.inflightCount).toBe(1)
    gate.release(); expect((await failure).code).toBe('CANCELLED'); await backend.close(); files.assertOwners(workspaceRoot); expect(db.db.open).toBe(true)
  })
  it('refuses busy task mutations and unavailable nonempty global cleanup, preserving exact bytes', async () => {
    const value = task(), path = db.getWorkspaceDir(value.id); writeFileSync(join(path, 'keep'), 'keep')
    db.db.prepare("UPDATE tasks SET status='agent_working' WHERE id=?").run(value.id)
    await expect(call('worktree:cleanup', [value.id, [], '', true])).rejects.toMatchObject({ code: 'BACKPRESSURE' }); expect(existsSync(path)).toBe(true)
    db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(value.id)
    await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' }); expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('keep')
    global = false; await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('uses the exact retained observer through real manual lifecycle and filesystem removal', async () => {
    const value = task(), path = db.getWorkspaceDir(value.id), actions: string[] = []
    db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(value.id)
    const observer = new ProductionWorkspaceProcessOwner(workspaceRoot, async request => {
      actions.push(request.action)
      if (request.action === 'acquire') {
        expect(manager.hasTaskStartOwnership(value.id)).toBe(false)
        await expect(manager.requestSession('synthetic-agent', value.id)).rejects.toThrow('lifecycle change')
        return { status: 'idle', leaseId: '8bac4cd9-4ef5-4a20-b109-89d28df6857b' }
      }
      if (request.action === 'release') { expect(existsSync(path)).toBe(false); return { released: true } }
      return { status: 'idle' }
    })
    options.assertIdleWorkspace = (id, selected) => observer.assertIdleWorkspace(id, selected)
    options.runWorkspaceCleanupMutation = (ids, effect, current, signal) => observer.run(ids, effect, current, signal)
    expect(await call('workspace:runCleanupNow', [])).toEqual({ cleaned: 1, errors: [], nodeModulesCleaned: 0 })
    expect(actions).toEqual(['acquire', 'check', 'check', 'release']); expect(db.getTask(value.id)).toBeDefined(); await observer.close()
  })
  it.each([['WORKSPACE_CLEANUP_PROCESS_NOT_IDLE', 'BACKPRESSURE'], ['WORKSPACE_CLEANUP_PROCESS_OBSERVATION_UNAVAILABLE', 'UNKNOWN_OPERATION'], ['WORKSPACE_BUSY', 'BACKPRESSURE']] as const)('maps actual owned refusal %s to %s while preserving bytes', async (failure, code) => {
    const value = task(), path = db.getWorkspaceDir(value.id); writeFileSync(join(path, 'keep'), 'owned bytes')
    db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(value.id)
    options.assertIdleWorkspace = async () => { throw new Error(failure) }
    await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code })
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('owned bytes')
  })
  it('refuses cleanup while the actual source mutation lease is retained', async () => {
    const source = db.createTaskSource({ name: 'Cleanup source fixture', plugin_id: 'fixture', mcp_server_id: null, config: {}, project_id: projectId })!
    const value = task(), path = db.getWorkspaceDir(value.id), gate = held(), entered = held(); releases.push(gate.release)
    db.db.prepare("UPDATE tasks SET status='completed',updated_at='2020-01-01T00:00:00Z',source_id=? WHERE id=?").run(source.id, value.id)
    const current = sync.runSourceMutation(source.id, async () => { entered.release(); await gate.promise })
    await entered.promise; options.assertIdleWorkspace = vi.fn(async () => {})
    try {
      await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
      expect(options.assertIdleWorkspace).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(true)
    } finally { gate.release(); await current }
  })
  it('returns truthful empty global cleanup and refuses pre-materialization/receipt capacity excess', async () => {
    expect(await call('workspace:runCleanupNow', [])).toEqual({ cleaned: 0, errors: [], nodeModulesCleaned: 0 })
    const value = task(); db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('x'.repeat(65536), value.id)
    const full = vi.spyOn(db, 'getTasks').mockImplementation(() => { throw new Error('Full deserialize forbidden') })
    await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(full).not.toHaveBeenCalled(); expect(db.db.prepare('SELECT length(title) AS size FROM tasks WHERE id=?').get(value.id)).toEqual({ size: 65536 })
    db.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Restored', value.id)
    const insert = db.db.prepare('INSERT INTO tasks(id,title,project_id,created_at,updated_at) VALUES(?,?,?,?,?)')
    db.db.transaction(() => { for (let i = 0; i < 2500; i++) insert.run(`receipts-${i}`, 'Short', projectId, '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z') })()
    await expect(call('workspace:runCleanupNow', [])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(existsSync(workspaceRoot)).toBe(true)
  })
  it('refuses stale epochs and mismatched captured owners before filesystem/CLI effects', async () => {
    const value = task(); await expect(call('worktree:setup', [value.id, [], '', 'github'], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('worktree:files', [value.id, []], undefined, { ...caller, origin: 'https://foreign.example' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    ownerValid = false; expect(() => new WorktreeRuntimeBackend(options)).toThrow(); expect(existsSync(join(workspaceRoot, value.id))).toBe(false); expect(commands).toEqual([])
  })
})
