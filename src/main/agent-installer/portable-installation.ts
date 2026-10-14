import { spawn, type ChildProcess } from 'node:child_process'
import { constants, lstatSync, type BigIntStats, type Dir } from 'node:fs'
import { lstat, mkdir, open, opendir, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, delimiter } from 'node:path'
import { PortableAgentDetectionOwner, AGENT_DETECTION_ENV_KEYS } from './portable-detection'
import { AGENT_INSTALLER_DETECTION_KEYS, AGENT_INSTALLER_PUBLIC_ERRORS, isAgentInstallerDetection } from '../../shared/agent-installer-codecs'
import { ServiceProtocolError } from '../../shared/service-protocol'

export const PORTABLE_INSTALLATION_PLANS = Object.freeze({
  claudeCode: { package: '@anthropic-ai/claude-code', bin: 'claude', args: ['install','-g','@anthropic-ai/claude-code'] },
  opencode: { package: 'opencode-ai', bin: 'opencode', args: ['install','-g','opencode-ai'] },
  codex: { package: '@openai/codex', bin: 'codex', args: ['install','-g','@openai/codex'] },
  pi: { package: '@earendil-works/pi-coding-agent', bin: 'pi', args: ['install','-g','--ignore-scripts','@earendil-works/pi-coding-agent'] },
  pnpm: { package: 'pnpm', bin: 'pnpm', args: ['install','-g','pnpm'] }
})
for (const plan of Object.values(PORTABLE_INSTALLATION_PLANS)) { Object.freeze(plan.args); Object.freeze(plan) }
export const PORTABLE_INSTALLATION_LIMITS = Object.freeze({ operations: 1, outputBytes: 65536, manifestBytes: 65536, stepMs: 90000, operationMs: 150000, killGraceMs: 200 })
export interface PortableInstallationProgress { stage: string; output: string; percent: number }
export interface PortableInstallationControls {
  beforeEffect(): void
  signal: AbortSignal
  onProgress?(progress: PortableInstallationProgress): void
}
export interface PortableAgentInstallationOwnerOptions {
  home: string
  cwd: string
  environment: Readonly<NodeJS.ProcessEnv>
  detection: PortableAgentDetectionOwner
  nodeExecutable: string
  npm?: { cliPath: string; prefix: string }
  legacyPiConfigRoot?: string
  assertCurrent(): void
  /** Trusted real-I/O fixture boundary; never accepted from an RPC request. */
  spawn?: typeof spawn
  open?: typeof open
  stepTimeoutMs?: number
  operationTimeoutMs?: number
}
export class AgentInstallationError extends Error {
  constructor(readonly code: 'AGENT_INSTALLATION_CLOSED'|'AGENT_INSTALLATION_CANCELLED'|'AGENT_INSTALLATION_TIMEOUT'|'AGENT_INSTALLATION_BACKPRESSURE'|'AGENT_INSTALLATION_INVALID_OPTIONS'|'AGENT_INSTALLATION_CLOSE_FAILED') { super(code); this.name='AgentInstallationError' }
}
type Target = keyof typeof PORTABLE_INSTALLATION_PLANS
type Detection = Awaited<ReturnType<PortableAgentDetectionOwner['detect']>>
export interface PortableInstallationResult { success: boolean; error: string | null; newStatus: Detection }
type Receipt = { path: string; dev: bigint; ino: bigint; size: bigint; mtime: bigint; ctime: bigint; directory: boolean }
type Child = { process: ChildProcess; stop(): void }
const pathValue = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value)
const receipt = (path: string, stat: BigIntStats): Receipt => ({ path,dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeNs,ctime:stat.ctimeNs,directory:stat.isDirectory() })
const physical = (stat: BigIntStats, directory: boolean): boolean => !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
const same = (before: Receipt, stat: BigIntStats): boolean => physical(stat,before.directory) && before.dev === stat.dev && before.ino === stat.ino && (before.directory || before.size === stat.size && before.mtime === stat.mtimeNs && before.ctime === stat.ctimeNs)
const parsedVersion = (value: string): string | null => value.match(/\b[vV]?(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-(?:alpha|beta|rc|dev|next)(?:[.-]\d{1,6})?)?)(?=$|[\s,+)])/i)?.[1]??null
const phases = {
  starting: { stage:'starting',output:'Preparing CLI installation.',percent:5 },
  installing: { stage:'installing',output:'Installing the selected CLI.',percent:50 },
  verifying: { stage:'verifying',output:'Checking the installed CLI.',percent:90 },
  complete: { stage:'complete',output:'CLI installation complete.',percent:100 },
  error: { stage:'error',output:'CLI installation failed.',percent:100 }
} as const

/** Fixed package plans through selected standalone Node, with private managed
 * npm paths. Accepted processes and pipes remain owned until actual close. */
export class PortableAgentInstallationOwner {
  readonly home: string
  readonly cwd: string
  private readonly options: Readonly<PortableAgentInstallationOwnerOptions>
  private readonly environment: Readonly<NodeJS.ProcessEnv>
  private readonly node: Receipt | null
  private readonly npm: Receipt | null
  private readonly roots: Receipt[]
  private readonly spawnChild: typeof spawn
  private readonly work = new Set<Promise<unknown>>()
  private readonly children = new Set<Child>()
  private readonly requests = new Set<AbortController>()
  private readonly handles = new Set<FileHandle>()
  private readonly directories = new Set<Dir>()
  private readonly closes = new Map<FileHandle | Dir, Promise<void>>()
  private closing = false
  private verifiedPiRoot: string | null = null
  constructor(options: PortableAgentInstallationOwnerOptions) {
    if (!options || !pathValue(options.home) || !pathValue(options.cwd) || !pathValue(options.nodeExecutable) || !(options.detection instanceof PortableAgentDetectionOwner) || options.npm && (!pathValue(options.npm.cliPath) || options.npm.prefix !== join(normalize(options.cwd),'agent-cli')) || options.legacyPiConfigRoot !== undefined && !pathValue(options.legacyPiConfigRoot)) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    for (const [value,max] of [[options.stepTimeoutMs,PORTABLE_INSTALLATION_LIMITS.stepMs],[options.operationTimeoutMs,PORTABLE_INSTALLATION_LIMITS.operationMs]]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 10 || value > max!)) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    this.home=normalize(options.home); this.cwd=normalize(options.cwd)
    this.options=Object.freeze({...options,npm:options.npm ? Object.freeze({...options.npm}) : undefined})
    const environment: NodeJS.ProcessEnv={}
    if (!options.environment || typeof options.environment !== 'object' || Array.isArray(options.environment)) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    for (const [key,value] of Object.entries(options.environment)) {
      if (!AGENT_DETECTION_ENV_KEYS.includes(key as never) || value !== undefined && (typeof value !== 'string' || value.length > 32768 || /[\u0000-\u001f]/.test(value))) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
      if (value !== undefined) environment[key]=value
    }
    const paths=(environment.PATH??'').split(delimiter).filter(pathValue).map(normalize)
    environment.PATH=[...new Set([dirname(options.nodeExecutable),...(options.npm ? [join(options.npm.prefix,'bin')] : []),...paths])].join(delimiter)
    environment.HOME=this.home
    this.environment=Object.freeze(environment); this.spawnChild=options.spawn??spawn
    this.roots=[this.capture(this.home,true),this.capture(this.cwd,true)]
    this.node=this.optionalFile(options.nodeExecutable); this.npm=options.npm ? this.optionalFile(options.npm.cliPath) : null
    this.assertOwners({detection:options.detection,home:this.home,cwd:this.cwd})
  }
  get inflightCount(): number { return this.work.size+this.handles.size+this.directories.size }
  get childCount(): number { return this.children.size }
  get piConfigRoot(): string | null { this.current(); return this.verifiedPiRoot }
  /** Startup read proof, not a stored success flag or package-install replay. */
  verifyManagedPiRuntime(controls: PortableInstallationControls): Promise<string | null> {
    this.current(controls)
    if (this.requests.size || this.work.size || this.handles.size || this.directories.size) throw new AgentInstallationError('AGENT_INSTALLATION_BACKPRESSURE')
    if (!this.canInstall('pi')) return Promise.resolve(null)
    const controller=new AbortController(), cancel=()=>controller.abort(); controls.signal.addEventListener('abort',cancel,{once:true}); if (controls.signal.aborted) cancel()
    this.requests.add(controller); let active=true,timedOut=false
    const timer=setTimeout(()=>{timedOut=true;controller.abort()},this.options.operationTimeoutMs??PORTABLE_INSTALLATION_LIMITS.operationMs)
    const owned:PortableInstallationControls={signal:controller.signal,beforeEffect:()=>{if(!active)throw new AgentInstallationError('AGENT_INSTALLATION_CLOSED');controls.beforeEffect()}}
    const raw=(async()=>{
      try {
        await this.verifyRoots(owned)
        const prefix=this.options.npm!.prefix, manifest=join(prefix,'lib','node_modules',PORTABLE_INSTALLATION_PLANS.pi.package,'package.json')
        try {await this.step(owned,()=>lstat(manifest,{bigint:true}))} catch(error) {this.current(owned);if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
        const installed=await this.managedEntry('pi',owned)
        const adapterPath=join(prefix,'.pi-agent','npm','node_modules','pi-mcp-adapter','package.json')
        try {await this.step(owned,()=>lstat(adapterPath,{bigint:true}))} catch(error) {this.current(owned);if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
        const adapter=await this.readManifest(adapterPath,owned)
        if(adapter.name!=='pi-mcp-adapter'||typeof adapter.version!=='string')throw new Error('INSTALL_PI_ADAPTER_REFUSED')
        const version=await this.run(installed.entry,['--version'],owned,true)
        if(parsedVersion(version)!==installed.version)throw new Error('INSTALL_VERSION_MISMATCH')
        const help=await this.run(installed.entry,['--help'],owned,true)
        if(!/(?:^|\s)--mcp-config(?:[=\s]|$)/.test(help))throw new Error('INSTALL_PI_ADAPTER_MISSING')
        const status=await this.detect(owned)
        if(!status.pi?.supported||status.pi.version!==installed.version)return null
        this.current(owned);this.verifiedPiRoot=join(prefix,'.pi-agent');return this.verifiedPiRoot
      }catch(error){if(timedOut)throw new AgentInstallationError('AGENT_INSTALLATION_TIMEOUT');if(error instanceof AgentInstallationError||error instanceof ServiceProtocolError)throw error;throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')}
    })()
    this.work.add(raw);void raw.finally(()=>{active=false;clearTimeout(timer);controls.signal.removeEventListener('abort',cancel);this.requests.delete(controller);this.work.delete(raw)}).catch(()=>{});return raw
  }
  assertOwners(owners: { detection: PortableAgentDetectionOwner; home: string; cwd: string }): void {
    if (owners.detection !== this.options.detection || owners.home !== this.home || owners.cwd !== this.cwd) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    this.current(); this.options.detection.assertOwners({home:this.home,cwd:this.cwd})
  }
  canInstall(name: string): boolean {
    this.current()
    return ['linux','darwin'].includes(process.platform) && Object.hasOwn(PORTABLE_INSTALLATION_PLANS,name) && this.node !== null && this.npm !== null && !!this.options.npm && (name!=='pi' || this.options.legacyPiConfigRoot===undefined || normalize(this.options.legacyPiConfigRoot)===join(this.options.npm.prefix,'.pi-agent'))
  }
  private capture(path: string, directory: boolean): Receipt {
    const stat=lstatSync(path,{bigint:true})
    if (!physical(stat,directory)) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    return receipt(path,stat)
  }
  private optionalFile(path: string): Receipt | null { try { return this.capture(path,false) } catch { return null } }
  private current(controls?: PortableInstallationControls): void {
    if (controls?.signal.aborted) throw new AgentInstallationError('AGENT_INSTALLATION_CANCELLED')
    if (this.closing) throw new AgentInstallationError('AGENT_INSTALLATION_CLOSED')
    this.options.assertCurrent(); controls?.beforeEffect()
  }
  private async step<T>(controls: PortableInstallationControls, operation: () => Promise<T>): Promise<T> {
    this.current(controls); const value=await operation(); this.current(controls); return value
  }
  private async verifyRoots(controls: PortableInstallationControls): Promise<void> {
    for (const root of this.roots) if (!same(root,await this.step(controls,()=>lstat(root.path,{bigint:true})))) throw new Error('INSTALL_ROOT_CHANGED')
  }
  private async ancestors(path: string, controls: PortableInstallationControls): Promise<Receipt[]> {
    const result: Receipt[]=[]; let cursor=dirname(path)
    while (true) {
      const stat=await this.step(controls,()=>lstat(cursor,{bigint:true})); if (!physical(stat,true)) throw new Error('INSTALL_PATH_REFUSED')
      result.push(receipt(cursor,stat)); const parent=dirname(cursor); if (parent===cursor) break; cursor=parent
      if (result.length>64) throw new Error('INSTALL_PATH_REFUSED')
    }
    return result
  }
  private async file(path: string, controls: PortableInstallationControls): Promise<Receipt> {
    await this.ancestors(path,controls); const stat=await this.step(controls,()=>lstat(path,{bigint:true}))
    if (!physical(stat,false)) throw new Error('INSTALL_FILE_REFUSED')
    return receipt(path,stat)
  }
  private async readManifest(path: string, controls: PortableInstallationControls): Promise<Record<string,unknown>> {
    const parents=await this.ancestors(path,controls), before=await this.file(path,controls)
    if (before.size>BigInt(PORTABLE_INSTALLATION_LIMITS.manifestBytes)) throw new Error('INSTALL_MANIFEST_REFUSED')
    this.current(controls)
    const handle=await (this.options.open??open)(path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW||0)); this.handles.add(handle)
    try {
      this.current(controls)
      const opened=await this.step(controls,()=>handle.stat({bigint:true})); if (!same(before,opened)) throw new Error('INSTALL_FILE_CHANGED')
      if (!same(before,await this.step(controls,()=>lstat(path,{bigint:true})))) throw new Error('INSTALL_FILE_CHANGED')
      for (const parent of parents) if (!same(parent,await this.step(controls,()=>lstat(parent.path,{bigint:true})))) throw new Error('INSTALL_PATH_CHANGED')
      const bytes=Buffer.alloc(Number(before.size)+1)
      try {
        const read=await this.step(controls,()=>handle.read(bytes,0,bytes.length,0))
        if (read.bytesRead!==Number(before.size) || !same(before,await this.step(controls,()=>handle.stat({bigint:true}))) || !same(before,await this.step(controls,()=>lstat(path,{bigint:true})))) throw new Error('INSTALL_FILE_CHANGED')
        for (const parent of parents) if (!same(parent,await this.step(controls,()=>lstat(parent.path,{bigint:true})))) throw new Error('INSTALL_PATH_CHANGED')
        const value: unknown=JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8'))
        if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('INSTALL_MANIFEST_REFUSED')
        return value as Record<string,unknown>
      } finally { bytes.fill(0) }
    } finally { await this.releaseHandle(handle) }
  }
  private releaseHandle(handle: FileHandle): Promise<void> { return this.release(handle,()=>this.handles.delete(handle)) }
  private releaseDirectory(handle: Dir): Promise<void> { return this.release(handle,()=>this.directories.delete(handle)) }
  private release(handle: FileHandle | Dir, forget: () => unknown): Promise<void> {
    const pending=this.closes.get(handle);if(pending)return pending
    const raw=Promise.resolve().then(()=>handle.close()).then(()=>{forget()},()=>{throw new AgentInstallationError('AGENT_INSTALLATION_CLOSE_FAILED')})
    this.closes.set(handle,raw);void raw.finally(()=>this.closes.delete(handle)).catch(()=>{});return raw
  }
  private async managedEntry(name: Target, controls: PortableInstallationControls): Promise<{ entry: Receipt; version: string }> {
    const plan=PORTABLE_INSTALLATION_PLANS[name], root=join(this.options.npm!.prefix,'lib','node_modules',plan.package)
    const manifest=await this.readManifest(join(root,'package.json'),controls)
    if (manifest.name!==plan.package || typeof manifest.version!=='string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|dev|next)(?:[.-]\d{1,6})?)?$/.test(manifest.version)) throw new Error('INSTALL_MANIFEST_REFUSED')
    const bin=typeof manifest.bin==='string' ? manifest.bin : manifest.bin && typeof manifest.bin==='object' && !Array.isArray(manifest.bin) ? (manifest.bin as Record<string,unknown>)[plan.bin] : undefined
    if (typeof bin!=='string' || bin.length>512 || isAbsolute(bin) || !bin.replace(/^\.\//,'').split(/[\\/]/).every(part=>part && part!=='.' && part!=='..' && /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('INSTALL_BIN_REFUSED')
    const entry=await this.file(join(root,bin),controls)
    if (entry.size>16n*1024n*1024n) throw new Error('INSTALL_BIN_REFUSED')
    return {entry,version:manifest.version}
  }
  private async piAllowed(initial: Detection, controls: PortableInstallationControls): Promise<boolean> {
    let managed=false
    try { await this.managedEntry('pi',controls); managed=true } catch (error) { this.current(controls); if (error instanceof ServiceProtocolError || error instanceof AgentInstallationError) throw error }
    if (initial.pi?.installed && !managed) return false
    const legacy=this.options.legacyPiConfigRoot??join(this.home,'.pi','agent')
    if (legacy===join(this.options.npm!.prefix,'.pi-agent')) return managed
    try {
      await this.ancestors(join(legacy,'settings.json'),controls)
      const stat=await this.step(controls,()=>lstat(legacy,{bigint:true})); if (!physical(stat,true)) return false
      // Only names; neither credentials nor preferences are parsed/copied.
      this.current(controls); const directory=await opendir(legacy); this.directories.add(directory)
      try { this.current(controls); const entry=await this.step(controls,()=>directory.read()); if (entry && !managed) return false }
      finally { await this.releaseDirectory(directory) }
    } catch (error) { this.current(controls); if ((error as NodeJS.ErrnoException).code!=='ENOENT') return false }
    return true
  }
  private progress(phase: keyof typeof phases, controls: PortableInstallationControls): void { this.current(controls); controls.onProgress?.({...phases[phase]}); this.current(controls) }
  private async detect(controls: PortableInstallationControls): Promise<Detection> {
    await this.verifyRoots(controls)
    const status=await this.step(controls,()=>this.options.detection.detect(controls.signal,{beforeEffect:()=>this.current(controls)}))
    if (!isAgentInstallerDetection(status)) throw new Error('INSTALL_DETECTION_REFUSED')
    return status
  }
  install(agentName: string, controls: PortableInstallationControls): Promise<PortableInstallationResult> {
    this.current(controls)
    if (!AGENT_INSTALLER_DETECTION_KEYS.includes(agentName as never)) throw new AgentInstallationError('AGENT_INSTALLATION_INVALID_OPTIONS')
    if (this.requests.size || this.work.size || this.handles.size || this.directories.size) throw new AgentInstallationError('AGENT_INSTALLATION_BACKPRESSURE')
    const controller=new AbortController(), cancel=()=>controller.abort(); controls.signal.addEventListener('abort',cancel,{once:true}); if (controls.signal.aborted) cancel()
    this.requests.add(controller); let timedOut=false, active=true
    const timer=setTimeout(()=>{timedOut=true;controller.abort()},this.options.operationTimeoutMs??PORTABLE_INSTALLATION_LIMITS.operationMs)
    const owned: PortableInstallationControls={signal:controller.signal,beforeEffect:()=>{if (!active) throw new AgentInstallationError('AGENT_INSTALLATION_CLOSED'); controls.beforeEffect()},onProgress:controls.onProgress}
    const raw=(async()=>{
      try {
        const initial=await this.detect(owned)
        if (!Object.hasOwn(PORTABLE_INSTALLATION_PLANS,agentName)) return {success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unsupported,newStatus:initial}
        if (!this.canInstall(agentName)) return {success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable,newStatus:initial}
        const name=agentName as Target
        if (name==='pi' && !await this.piAllowed(initial,owned)) return {success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable,newStatus:initial}
        this.progress('starting',owned)
        let error: string | null=null, verifiedVersion: string | null=null
        try {
          await this.verifyRoots(owned)
          const prefix=this.options.npm!.prefix
          try { const stat=await this.step(owned,()=>lstat(prefix,{bigint:true})); if (!physical(stat,true)) throw new Error('INSTALL_PREFIX_REFUSED') }
          catch (error) { this.current(owned); if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; await this.step(owned,()=>mkdir(prefix,{mode:0o700})); await this.verifyRoots(owned) }
          if (!this.roots.some(root=>root.path===prefix)) this.roots.push(receipt(prefix,await this.step(owned,()=>lstat(prefix,{bigint:true}))))
          const packageName=PORTABLE_INSTALLATION_PLANS[name].package
          const scopedParents=packageName.startsWith('@') ? [join(prefix,'lib','node_modules',packageName.split('/')[0])] : []
          for (const path of [join(prefix,'bin'),join(prefix,'lib'),join(prefix,'lib','node_modules'),...scopedParents,join(prefix,'.npm-cache'),join(prefix,'.pi-agent'),join(prefix,'lib','node_modules',packageName)]) {
            try { const stat=await this.step(owned,()=>lstat(path,{bigint:true})); if (!physical(stat,true)) throw new Error('INSTALL_PREFIX_REFUSED') }
            catch (cause) { this.current(owned); if ((cause as NodeJS.ErrnoException).code!=='ENOENT') throw cause }
          }
          const npmArgs=[...PORTABLE_INSTALLATION_PLANS[name].args,'--prefix',prefix,'--cache',join(prefix,'.npm-cache'),'--registry','https://registry.npmjs.org/','--userconfig','/dev/null','--globalconfig','/dev/null','--no-audit','--no-fund']
          this.progress('installing',owned)
          await this.run(this.npm!,npmArgs,owned)
          let installed: Awaited<ReturnType<PortableAgentInstallationOwner['managedEntry']>>
          try { installed=await this.managedEntry(name,owned) } catch (cause) { this.current(owned); if (cause instanceof ServiceProtocolError || cause instanceof AgentInstallationError) throw cause; error=AGENT_INSTALLER_PUBLIC_ERRORS.notDetected; throw cause }
          const version=await this.run(installed.entry,['--version'],owned,name==='pi')
          const observed=parsedVersion(version)
          if (observed!==installed.version) { error=AGENT_INSTALLER_PUBLIC_ERRORS.notDetected; throw new Error('INSTALL_VERSION_MISMATCH') }
          verifiedVersion=observed
          if (name==='pi') {
            const status=await this.detect(owned)
            if (!status.pi?.supported) { error=AGENT_INSTALLER_PUBLIC_ERRORS.piUnsupported; throw new Error('INSTALL_PI_UNSUPPORTED') }
            await this.run(installed.entry,['install','npm:pi-mcp-adapter'],owned,true)
            const help=await this.run(installed.entry,['--help'],owned,true)
            if (!/(?:^|\s)--mcp-config(?:[=\s]|$)/.test(help)) { error=AGENT_INSTALLER_PUBLIC_ERRORS.adapterMissing; throw new Error('INSTALL_PI_ADAPTER_MISSING') }
            const adapter=await this.readManifest(join(prefix,'.pi-agent','npm','node_modules','pi-mcp-adapter','package.json'),owned)
            if (adapter.name!=='pi-mcp-adapter' || typeof adapter.version!=='string') { error=AGENT_INSTALLER_PUBLIC_ERRORS.adapterMissing; throw new Error('INSTALL_PI_ADAPTER_MISSING') }
          }
        } catch (cause) {
          this.current(owned)
          if (cause instanceof ServiceProtocolError || cause instanceof AgentInstallationError) throw cause
          error??=AGENT_INSTALLER_PUBLIC_ERRORS.failed
        }
        this.progress('verifying',owned); const newStatus=await this.detect(owned)
        if (!error && (!newStatus[name]?.installed || newStatus[name]?.version!==verifiedVersion || name==='pi' && !newStatus.pi?.supported)) error=AGENT_INSTALLER_PUBLIC_ERRORS.notDetected
        this.progress(error ? 'error' : 'complete',owned)
        if (!error && name==='pi') this.verifiedPiRoot=join(this.options.npm!.prefix,'.pi-agent')
        return {success:error===null,error,newStatus}
      } catch (error) {
        if (timedOut) throw new AgentInstallationError('AGENT_INSTALLATION_TIMEOUT')
        throw error
      }
    })()
    this.work.add(raw)
    void raw.finally(()=>{active=false;clearTimeout(timer);controls.signal.removeEventListener('abort',cancel);this.requests.delete(controller);this.work.delete(raw)}).catch(()=>{})
    return raw
  }
  private async run(script: Receipt, args: readonly string[], controls: PortableInstallationControls, pi=false): Promise<string> {
    await this.verifyRoots(controls)
    for (const file of [this.node!,script]) {
      await this.ancestors(file.path,controls)
      if (!same(file,await this.step(controls,()=>lstat(file.path,{bigint:true})))) throw new Error('INSTALL_PROGRAM_CHANGED')
    }
    const prefix=this.options.npm!.prefix, env: NodeJS.ProcessEnv={...this.environment}
    env.npm_config_prefix=prefix;env.npm_config_cache=join(prefix,'.npm-cache');env.npm_config_registry='https://registry.npmjs.org/';env.npm_config_userconfig='/dev/null';env.npm_config_globalconfig='/dev/null';env.npm_config_update_notifier='false'
    if (pi) env.PI_CODING_AGENT_DIR=join(prefix,'.pi-agent')
    this.current(controls)
    return new Promise<string>((resolve,reject)=>{
      let child: ChildProcess
      try { child=this.spawnChild(this.node!.path,[script.path,...args],{cwd:this.cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']}) }
      catch { reject(new Error('INSTALL_PROCESS_FAILED'));return }
      const ownedPid=child.pid
      let failure=false,closed=false,stdoutClosed=!child.stdout,stderrClosed=!child.stderr,code:number|null=null,bytes=0,stopping=false
      const output: Buffer[]=[]; let escalation: ReturnType<typeof setTimeout>|undefined
      const stop=()=>{if(stopping)return;stopping=true; const kill=(signal:NodeJS.Signals)=>{try { if(process.platform!=='win32' && ownedPid && child.exitCode===null && child.signalCode===null) process.kill(-ownedPid,signal);else child.kill(signal) } catch {try{child.kill(signal)}catch{/* exact child close remains owned */}}};kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),PORTABLE_INSTALLATION_LIMITS.killGraceMs)}
      const owned:Child={process:child,stop};this.children.add(owned)
      const abort=()=>stop();controls.signal.addEventListener('abort',abort,{once:true});if(controls.signal.aborted)stop()
      const timer=setTimeout(()=>{failure=true;stop()},this.options.stepTimeoutMs??PORTABLE_INSTALLATION_LIMITS.stepMs)
      const finish=()=>{
        if(!closed || !stdoutClosed || !stderrClosed)return
        clearTimeout(timer);if(escalation)clearTimeout(escalation);controls.signal.removeEventListener('abort',abort);this.children.delete(owned)
        try {this.current(controls);if(failure || code!==0)throw new Error('INSTALL_PROCESS_FAILED');resolve(Buffer.concat(output).toString('utf8'))}catch(error){reject(error)}finally{for(const chunk of output)chunk.fill(0)}
      }
      const data=(keep:boolean)=>(chunk:Buffer|string)=>{const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=value.length;if(bytes>PORTABLE_INSTALLATION_LIMITS.outputBytes){failure=true;stop();return}if(keep&&!stopping)output.push(Buffer.from(value))}
      child.stdout?.on('data',data(true));child.stderr?.on('data',data(false))
      const failed=()=>{failure=true;stop()};child.on('error',failed);child.stdout?.on('error',failed);child.stderr?.on('error',failed)
      child.stdout?.once('close',()=>{stdoutClosed=true;finish()});child.stderr?.once('close',()=>{stderrClosed=true;finish()});child.once('close',value=>{closed=true;code=value;finish()})
    })
  }
  shutdown(): void {this.closing=true;for(const controller of this.requests)controller.abort();for(const child of this.children)child.stop()}
  async close(timeoutMs=2000): Promise<void> {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)throw new RangeError('Invalid CLI installation shutdown deadline')
    this.shutdown();let timer:ReturnType<typeof setTimeout>|undefined
    try {await Promise.race([(async()=>{while(this.work.size)await Promise.allSettled([...this.work]);for(const handle of [...this.handles])await this.releaseHandle(handle);for(const handle of [...this.directories])await this.releaseDirectory(handle)})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AgentInstallationError('AGENT_INSTALLATION_TIMEOUT')),timeoutMs)})])}
    finally{if(timer)clearTimeout(timer)}
  }
}
