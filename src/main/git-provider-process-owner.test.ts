import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn, type ChildProcess, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink, rename, lstat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitProviderProcessOwner, GIT_PROVIDER_PROCESS_LIMITS, type GitProviderProcessOwnerOptions } from './git-provider-process-owner'
import { GitHubManager } from './github-manager'
import { GitLabManager } from './gitlab-manager'
import { ForgejoManager } from './forgejo-manager'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : ['/usr/bin/node','/usr/local/bin/node'].find(existsSync))
let root: string, script: string, owners: GitProviderProcessOwner[], children: ChildProcess[]
let readiness: Map<ChildProcess, Promise<void>>
function track(child: ChildProcess): void {
  children.push(child)
  readiness.set(child, new Promise(resolve => { child.stdout?.once('data', () => resolve()); child.stderr?.once('data', () => resolve()) }))
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'git-provider-owner-'))); script = join(root, 'fixed.cjs'); owners = []; children = []; readiness = new Map()
  await mkdir(join(root, 'repos')); await mkdir(join(root, 'workspaces'))
  await writeFile(script, `const fs=require('node:fs');const mode=process.argv[2];const args=process.argv.slice(3);
if(mode==='hold'){process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)}
else if(mode==='delay'){process.stdout.write('done');setTimeout(()=>process.exit(0),200)}
else if(mode==='fail'){process.stderr.write(process.env.GH_TOKEN||'fixed fixture failure');process.exitCode=1}
else if(mode==='diff-one'){process.stdout.write('diff --git a/new.txt b/new.txt\\n+Actual local addition');process.stderr.write('fixture-private-diagnostic');process.exitCode=1}
else if(mode==='diff-two'){process.stdout.write('discard failed output');process.exitCode=2}
else if(mode==='overflow'){process.stdout.write('x'.repeat(200000))}
else if(mode==='path'){process.stdout.write(JSON.stringify({path:process.env.PATH??null}))}
else if(mode==='gh-pages'){const page=Number(new URL('https://fixture.invalid'+args.at(-1)).searchParams.get('page'));process.stdout.write(JSON.stringify(Array.from({length:page===1?100:1},(_,i)=>({number:(page-1)*100+i+1,title:'Fixture issue',pull_request:page===1&&i===0?{}:undefined}))))}
else if(mode==='gh-many'){process.stdout.write(JSON.stringify(Array.from({length:101},(_,i)=>({number:i+1}))))}
else if(mode==='glab-unauth'){if(args[0]==='--version')process.stdout.write('glab fixture');else{process.stderr.write('No configured login; fixture-private-provider');process.exitCode=1}}
else if(mode==='tea-unauthorized'){process.stderr.write('HTTP/1.1 401 Unauthorized');process.stdout.write(JSON.stringify({message:'fixture-private-provider raw rejection'}))}
else if(mode==='tea-write'){if(args[0]==='login')process.stdout.write(JSON.stringify([{name:'fixture',url:'https://forgejo.fixture.invalid',user:'fixture-user',default:true}]));else{fs.appendFileSync('accepted-mutations.jsonl',args[args.indexOf('--method')+1]+'\\n');process.stderr.write('HTTP/1.1 200 OK');process.stdout.write('{}')}}
else if(mode==='env'){process.stdout.write(JSON.stringify({provider:process.env.GH_TOKEN==='fixture-private-provider',model:!!process.env.OPENAI_API_KEY,task:!!process.env.TASK_API_TOKEN,askpass:!!process.env.GIT_ASKPASS,sshCommand:!!process.env.GIT_SSH_COMMAND,home:process.env.HOME,cwd:process.cwd(),pager:process.env.PAGER}));fs.writeFileSync('owned-receipt.txt','fixed receipt')}
else if(mode==='gh'){if(args[0]==='--version')process.stdout.write('gh fixture');else if(args[0]==='auth'){process.stderr.write('Logged in to github.com account inactive\\n - Active account: false\\nLogged in to github.com account fixture-user\\n - Active account: true\\n Token: fixture-private-provider');process.exitCode=1}else process.stdout.write(JSON.stringify([{name:'repo',full_name:'fixture-user/repo',default_branch:'main',clone_url:'https://github.com/fixture-user/repo.git',description:'Repository',private:false}]))}
else if(mode==='glab'){if(args[0]==='--version')process.stdout.write('glab fixture');else if(args[0]==='auth'){process.stdout.write('Logged in to gitlab.fixture.invalid as fixture-user');process.exitCode=1}else process.stdout.write(JSON.stringify([{path:'repo',path_with_namespace:'team/subgroup/repo',http_url_to_repo:'https://gitlab.fixture.invalid/team/subgroup/repo.git',default_branch:'main',visibility:'private'}]))}
else if(mode==='tea'){if(args[0]==='--version')process.stdout.write('tea fixture');else if(args[0]==='login')process.stdout.write(JSON.stringify([{name:'fixture',url:'https://forgejo.fixture.invalid',user:'fixture-user',default:true,token:'never project'}]));else{const endpoint=args.at(-1);process.stderr.write('HTTP/1.1 200 OK');process.stdout.write(JSON.stringify(endpoint==='/user'?{login:'fixture-user'}:[{name:'repo',full_name:'fixture-user/repo',default_branch:'main',clone_url:'https://forgejo.fixture.invalid/fixture-user/repo.git',private:false}]))}}
else { process.stdout.write('[]') }
`)
})
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const close = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await close }
  for (const owner of owners) await owner.close()
  await rm(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
function make(modes: Partial<Record<'gh'|'glab'|'tea'|'git', string>> = {}, changes: Partial<GitProviderProcessOwnerOptions> = {}) {
  const executables = Object.fromEntries(['gh','glab','tea','git'].map(program => [program, { file: node!, prefix: [script, modes[program as keyof typeof modes] ?? program] }]))
  const capture = ((file: string, args: string[], opts: object, callback: (...values: unknown[]) => void) => {
    const child = execFile(file, args, opts as ExecFileOptions, callback as never); track(child); return child
  }) as typeof execFile
  const owner = new GitProviderProcessOwner({ execFile: capture, home: root, cwd: root, environment: {}, assertCurrent() {}, commandTimeoutMs: 5000,
    worktreeRoots: [join(root,'repos'),join(root,'workspaces')], fixture: { executables }, ...changes })
  owners.push(owner); return owner
}
async function ready(): Promise<ChildProcess> {
  const deadline = Date.now() + 4000
  while (!children.length) { if (Date.now() > deadline) throw new Error('FIXTURE_DID_NOT_START'); await new Promise(resolve => setTimeout(resolve, 5)) }
  const child = children[0]
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([readiness.get(child), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('FIXTURE_NOT_READY')), 4000) })]) }
  finally { if (timer) clearTimeout(timer) }
  return child
}

describe.skipIf(!node)('captured actual CLI process owner (fixed synthetic Node programs)', () => {
  it('revokes inherited callbacks after a nested request completes and joins each actual child receipt', async () => {
    const owner = make({ gh: 'delay' }), gate = deferred<void>()
    let inherited!: Promise<unknown>, accepted!: Promise<unknown>, nestedFinished = false
    await owner.withRequestGuard(async () => {
      await owner.withRequestGuard(async () => {
        accepted = owner.exec('gh', ['--version'])
        inherited = (async () => { await gate.promise; return owner.exec('gh', ['--version']) })()
      }, () => {})
      nestedFinished = true; expect(owner.childCount).toBe(0); expect(await accepted).toEqual({ stdout: 'done', stderr: '' })
    }, () => {})
    expect(nestedFinished).toBe(true)
    const refused = expect(inherited).rejects.toMatchObject({ code: 'GIT_PROVIDER_CANCELLED' })
    gate.resolve(); await refused; expect(children).toHaveLength(1)
  })
  it('retires only the known physical task directory after cleanup and permits legitimate recreation', async () => {
    const workspace = join(root, 'workspaces', 'task-one'), repo = join(workspace, 'repo'), owner = make()
    await mkdir(workspace); await mkdir(repo)
    const physical = await lstat(workspace, { bigint: true }), receipt = { dev: physical.dev.toString(), ino: physical.ino.toString() }
    await owner.execWorktree('git', ['status'], { cwd: workspace }); await owner.execWorktree('git', ['status'], { cwd: repo })
    expect(() => owner.retireWorktreeDirectory(workspace, { ...receipt, ino: '0' })).toThrow('CWD_REFUSED')
    await rename(workspace, join(root, 'workspaces', 'old-task'))
    owner.retireWorktreeDirectory(workspace, receipt)
    await mkdir(workspace); await mkdir(repo)
    expect((await owner.execWorktree('git', ['status'], { cwd: repo })).stdout).toBe('[]')
    expect(() => owner.retireWorktreeDirectory(workspace, receipt)).toThrow('CWD_REFUSED')
  })
  it('accepts only the exact untracked diff exit-one receipt and discards its diagnostics', async () => {
    const owner = make({ git: 'diff-one' }), args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'new.txt']
    const options = { cwd: join(root, 'workspaces'), allowDiffExitOne: true as const }
    expect(await owner.execWorktree('git', args, options)).toEqual({ stdout: 'diff --git a/new.txt b/new.txt\n+Actual local addition', stderr: '' })
    expect(owner.childCount).toBe(0); expect(children[0].stdout?.closed).toBe(true); expect(children[0].stderr?.closed).toBe(true)
    await expect(owner.execWorktree('git', ['status'], options)).rejects.toMatchObject({ code: 'GIT_PROVIDER_INVALID_OPTIONS' })
    await expect(owner.execWorktree('gh', args, options)).rejects.toMatchObject({ code: 'GIT_PROVIDER_INVALID_OPTIONS' })
    for (const file of ['/etc/passwd', '../outside', 'C:\\outside', 'safe/../outside']) await expect(owner.execWorktree('git', [...args.slice(0, -1), file], options)).rejects.toMatchObject({ code: 'GIT_PROVIDER_INVALID_OPTIONS' })
    await expect(owner.execWorktree('git', args, { cwd: options.cwd })).rejects.toMatchObject({ code: 'GIT_PROVIDER_COMMAND_FAILED' })
    await expect(make({ git: 'diff-two' }).execWorktree('git', args, options)).rejects.toMatchObject({ code: 'GIT_PROVIDER_COMMAND_FAILED' })
  })
  it('preserves private provider env only for its actual child, with approved roots and no parent mutation', async () => {
    const parentPath = process.env.PATH
    const owner = make({ gh: 'env' }, { environment: { GH_TOKEN: 'fixture-private-provider', PATH: root, HOME: '/incorrect-host-home' } })
    const output = JSON.parse((await owner.exec('gh', ['--version'])).stdout)
    expect(output).toEqual({ provider: true, model: false, task: false, askpass: false, sshCommand: false, home: root, cwd: root, pager: '' })
    expect(await readFile(join(root, 'owned-receipt.txt'), 'utf8')).toBe('fixed receipt')
    expect(process.env.PATH).toBe(parentPath); expect(owner.childCount).toBe(0)
    expect(() => make({}, { environment: { TASK_API_TOKEN: 'never inherit' } })).toThrow('INVALID_OPTIONS')
    expect(() => make({}, { environment: { GIT_SSH_COMMAND: 'unapproved program' } })).toThrow('INVALID_OPTIONS')
  })
  it('removes empty PATH components without allowing implicit cwd lookup or changing parent PATH', async () => {
    const parentPath = process.env.PATH, directory = join(root, 'repos')
    const owner = make({ gh: 'path' }, { environment: { PATH: [root, '', directory, root, ''].join(delimiter) } })
    expect(JSON.parse((await owner.exec('gh', ['--version'])).stdout)).toEqual({ path: [root, directory].join(delimiter) })
    expect(() => make({}, { environment: { PATH: ['.', root].join(delimiter) } })).toThrow('INVALID_OPTIONS')
    const noPath = make({ gh: 'path' }, { environment: { PATH: delimiter } })
    expect(JSON.parse((await noPath.exec('gh', ['--version'])).stdout)).toEqual({ path: null })
    const boundary = vi.fn(execFile)
    const missing = make({}, { execFile: boundary as unknown as typeof execFile, fixture: undefined, environment: { PATH: delimiter } })
    await expect(missing.exec('gh', ['--version'])).rejects.toMatchObject({ code: 'GIT_PROVIDER_CLI_MISSING' })
    expect(boundary).not.toHaveBeenCalled(); expect(process.env.PATH).toBe(parentPath)
  })
  it('waits for actual child and both pipes when a controlled callback arrives first', async () => {
    const accepted = deferred<void>()
    const boundary = ((file: string, args: string[], opts: object, callback: (error: ExecFileException | null, out: string, err: string) => void) => {
      const child = execFile(file, args, opts as ExecFileOptions, () => {}); track(child)
      child.stdout?.once('data', () => { callback(null, 'accepted', ''); accepted.resolve() })
      return child
    }) as typeof execFile
    const owner = make({ gh: 'delay' }, { execFile: boundary })
    let settled = false
    const work = owner.exec('gh', ['--version']).then(value => { settled = true; return value })
    await accepted.promise; expect(settled).toBe(false); expect(owner.childCount).toBe(1)
    expect(await work).toEqual({ stdout: 'accepted', stderr: '' }); expect(owner.childCount).toBe(0)
    expect(children[0].stdout?.closed).toBe(true); expect(children[0].stderr?.closed).toBe(true)
  })
  it('retains a late callback after actual process/pipe close through a shutdown deadline', async () => {
    const closed = deferred<void>(), receipt = deferred<void>()
    const boundary = ((file: string, args: string[], opts: object, callback: (...values: unknown[]) => void) => {
      const child = execFile(file, args, opts as ExecFileOptions, (...values) => { closed.resolve(); void receipt.promise.then(() => callback(...values)) }); track(child); return child
    }) as typeof execFile
    const owner = make({}, { execFile: boundary }), work = owner.exec('gh', ['--version']).catch(cause => cause)
    try {
      await closed.promise
      expect(owner.childCount).toBe(1)
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
      receipt.resolve(); expect((await work).code).toBe('GIT_PROVIDER_CLOSED')
      await owner.close(); expect(owner.inflightCount).toBe(0)
    } finally { receipt.resolve(); await work }
  })
  it.skipIf(process.platform === 'win32')('kills only its registered child and retains ignored SIGTERM until actual close', async () => {
    const unrelated = spawn(node!, [script, 'hold'], { env: {}, stdio: ['ignore','pipe','pipe'] })
    children.push(unrelated); unrelated.stdout?.resume(); unrelated.stderr?.resume()
    // Exclude the unrelated child from the owned readiness helper.
    children.splice(children.indexOf(unrelated), 1)
    try {
      const owner = make({ gh: 'hold' }), work = owner.exec('gh', ['--version']).catch(cause => cause)
      await ready()
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
      expect(owner.childCount).toBe(1); expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull()
      await owner.close(1000); expect((await work).code).toBe('GIT_PROVIDER_CLOSED')
      expect(unrelated.exitCode).toBeNull(); expect(owner.childCount).toBe(0)
    } finally { children.push(unrelated) }
  })
  it('joins accepted Promise.all siblings when one command fails before another child completes', async () => {
    const owner = make({ gh: 'fail', glab: 'hold' }, { environment: { GH_TOKEN: 'fixture-private-provider' } })
    let callbackFailed = false, settled = false
    const work = owner.withRequestGuard(() => Promise.all([
      owner.exec('gh', ['--version']).catch(cause => { callbackFailed = true; throw cause }), owner.exec('glab', ['--version']),
    ]), () => {}).catch(cause => { settled = true; return cause })
    const deadline = Date.now() + 4000
    while (!callbackFailed) { if (Date.now() > deadline) throw new Error('FIXTURE_FAILED_TO_FINISH'); await new Promise(resolve => setTimeout(resolve, 5)) }
    expect(settled).toBe(false)
    const sibling = children.find(child => child.spawnargs.includes('hold'))!
    expect(sibling).toBeDefined(); sibling.kill('SIGKILL')
    expect((await work).message).toBe('GIT_PROVIDER_COMMAND_FAILED')
    expect(owner.childCount).toBe(0); expect(owner.inflightCount).toBe(0)
  })
  it('bounds concurrency, queue, output and deadlines; no raw diagnostics escape', async () => {
    const overflow = make({ gh: 'overflow' })
    await expect(overflow.exec('gh', ['--version'], { maxBuffer: 1024 })).rejects.toMatchObject({ code: 'GIT_PROVIDER_OUTPUT_LIMIT' })
    const failed = make({ gh: 'fail' }, { environment: { GH_TOKEN: 'fixture-private-provider' } })
    const failure = await failed.exec('gh', ['--version']).catch(cause => cause)
    expect(JSON.stringify(failure)).not.toMatch(/fixture-private-provider|stderr|stdout/)
    expect(failure.message).toBe('GIT_PROVIDER_COMMAND_FAILED')
    const timeout = make({ gh: 'hold' }, { commandTimeoutMs: 50 })
    await expect(timeout.exec('gh', ['--version'])).rejects.toMatchObject({ code: 'GIT_PROVIDER_TIMEOUT' })
    const busy = make({ gh: 'hold' }, { maxConcurrency: 1 })
    const requests = Array.from({ length: GIT_PROVIDER_PROCESS_LIMITS.queued + 1 }, () => busy.exec('gh', ['--version']).catch(cause => cause))
    await expect(busy.exec('gh', ['--version'])).rejects.toMatchObject({ code: 'GIT_PROVIDER_BUSY' })
    await busy.close(); await Promise.all(requests); expect(busy.childCount).toBe(0)
  })
  it('rechecks revoked caller guards after actual results and refuses every subsequent command', async () => {
    let allowed = true
    const owner = make({ gh: 'delay' }), acquired = deferred<void>()
    const boundary = vi.spyOn(owner, 'exec')
    const work = owner.withRequestGuard(async () => {
      acquired.resolve(); await owner.exec('gh', ['--version']); return owner.exec('gh', ['auth','status','--hostname','github.com'])
    }, () => { if (!allowed) throw new Error('FIXTURE_GRANT_REPLACED') }).catch(cause => cause)
    await acquired.promise; await ready(); allowed = false
    expect((await work).message).toBe('FIXTURE_GRANT_REPLACED')
    expect(boundary).toHaveBeenCalledTimes(1); expect(owner.childCount).toBe(0)
  })
  it('allows worktree execution only inside exact supplied physical roots and rejects swapped/linked paths', async () => {
    const owner = make({ git: 'env' })
    await expect(owner.execWorktree('git', ['status'], { cwd: root })).rejects.toThrow('CWD_REFUSED')
    expect(owner.childCount).toBe(0)
    const cwd = join(root, 'repos')
    const result = JSON.parse((await owner.execWorktree('git', ['status'], { cwd })).stdout)
    expect(result.cwd).toBe(cwd); expect(await readFile(join(cwd, 'owned-receipt.txt'), 'utf8')).toBe('fixed receipt')
    await rename(cwd, join(root, 'previous-repos')); await mkdir(cwd)
    await expect(owner.execWorktree('git', ['status'], { cwd })).rejects.toThrow('CWD_REFUSED')
    const link = join(root, 'workspaces', 'linked'); await symlink(join(root, 'previous-repos'), link, 'dir')
    await expect(owner.execWorktree('git', ['status'], { cwd: link })).rejects.toThrow('CWD_REFUSED')
    await expect(owner.execWorktree('git', ['status'], { cwd: join(root,'workspaces'), env: { GIT_SSH_COMMAND: 'no' } as never })).rejects.toThrow('CWD_REFUSED')
  })
  it('drives actual managers/auth parsing through fixed real CLI children without exporting fixture secrets', async () => {
    const owner = make({}, { environment: { GH_TOKEN: 'fixture-private-provider' } })
    const github = new GitHubManager({ process: owner }), gitlab = new GitLabManager({ process: owner }), forgejo = new ForgejoManager(() => null, { process: owner })
    github.assertOwners(owner); gitlab.assertOwners(owner); forgejo.assertOwners(owner)
    expect(await github.checkGhCli()).toEqual({ installed: true, authenticated: true, username: 'fixture-user' })
    expect(await github.fetchUserRepos()).toHaveLength(1)
    expect(await gitlab.checkGlabCli()).toEqual({ installed: true, authenticated: true, username: 'fixture-user' })
    expect((await gitlab.fetchOrgRepos('team/subgroup'))[0].fullName).toBe('team/subgroup/repo')
    const tea = await forgejo.checkTeaCli()
    expect(tea).toMatchObject({ installed: true, authenticated: true, username: 'fixture-user', code: 'ready' })
    expect(JSON.stringify(tea)).not.toMatch(/never project|fixture-private-provider|token/)
    expect((await forgejo.fetchUserRepos())[0].fullName).toBe('fixture-user/repo')
    expect(owner.childCount).toBe(0)
  })
  it('uses explicit bounded Github pages, filters pull requests, and refuses oversized pages', async () => {
    const owner = make({ gh: 'gh-pages' }), manager = new GitHubManager({ process: owner })
    const issues = await manager.fetchIssues('fixture-user', 'repo')
    expect(issues).toHaveLength(100)
    expect(issues.at(-1)?.number).toBe(101)
    expect(children.map(child => child.spawnargs.at(-1))).toEqual([
      '/repos/fixture-user/repo/issues?per_page=100&state=open&page=1',
      '/repos/fixture-user/repo/issues?per_page=100&state=open&page=2',
    ])
    expect(children.every(child => !child.spawnargs.includes('--paginate'))).toBe(true)
    const tooMany = make({ gh: 'gh-many' })
    await expect(new GitHubManager({ process: tooMany }).fetchIssues('fixture-user', 'repo')).rejects.toThrow('INVALID_RESULT')
    expect(tooMany.childCount).toBe(0)
  })
  it('preserves unauthenticated GitLab status and returns fixed Forgejo HTTP failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const glab = make({ glab: 'glab-unauth' })
    expect(await new GitLabManager({ process: glab }).checkGlabCli()).toEqual({ installed: true, authenticated: false })
    expect(log).not.toHaveBeenCalled()
    const tea = make({ tea: 'tea-unauthorized' }), manager = new ForgejoManager(() => null, { process: tea })
    const login = { name: 'fixture', url: 'https://forgejo.fixture.invalid', sshHost: '', user: 'fixture-user', isDefault: true }
    await expect(manager.api(login, '/user')).rejects.toMatchObject({ code: 'unauthorized', httpStatus: 401, message: 'The configured tea login was rejected.' })
    expect(tea.childCount).toBe(0)
  })
  it('preserves an accepted Forgejo mutation after grant loss without issuing labels or replaying it', async () => {
    let allowed = true
    const boundary = ((file: string, args: string[], opts: object, callback: (...values: unknown[]) => void) => {
      const child = execFile(file, args, opts as ExecFileOptions, (...values) => {
        if (args.includes('PATCH')) allowed = false
        callback(...values)
      }); track(child); return child
    }) as typeof execFile
    const owner = make({ tea: 'tea-write' }, { execFile: boundary }), manager = new ForgejoManager(() => null, { process: owner })
    await expect(owner.withRequestGuard(() => manager.updateIssue('fixture-user', 'repo', 1, { title: 'Accepted fixture change', labels: ['next'] }), () => {
      if (!allowed) throw new Error('FIXTURE_GRANT_REPLACED')
    })).rejects.toThrow('FIXTURE_GRANT_REPLACED')
    expect(await readFile(join(root, 'accepted-mutations.jsonl'), 'utf8')).toBe('PATCH\n')
    expect(children).toHaveLength(2); expect(owner.childCount).toBe(0)
  })
  it('refuses portable Forgejo clone without a host capability and uses the exact supplied capability', async () => {
    const owner = make({ git: 'env' }), unavailable = new ForgejoManager(() => null, { process: owner })
    await expect(unavailable.cloneBare('fixture-user/repo', join(root, 'repos', 'repo.git'))).rejects.toThrow('INVALID_OPTIONS')
    expect(children).toHaveLength(0)
    const cloneBare = vi.fn(async ({ barePath }: { barePath: string }) => {
      await mkdir(barePath)
      await owner.execWorktree('git', ['status'], { cwd: barePath })
    })
    const manager = new ForgejoManager(() => null, { process: owner, cloneBare })
    const barePath = join(root, 'repos', 'repo.git')
    await manager.cloneBare('fixture-user/repo', barePath, 'https://forgejo.fixture.invalid/fixture-user/repo.git')
    expect(cloneBare).toHaveBeenCalledExactlyOnceWith({ fullName: 'fixture-user/repo', barePath, cloneUrl: 'https://forgejo.fixture.invalid/fixture-user/repo.git', login: { name: 'fixture', url: 'https://forgejo.fixture.invalid', user: 'fixture-user', sshHost: '', isDefault: true } })
    expect(await readFile(join(barePath, 'owned-receipt.txt'), 'utf8')).toBe('fixed receipt')
  })
})
