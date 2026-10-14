import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { open as realOpen } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { PortableAgentDetectionOwner } from './portable-detection'
import { PortableAgentInstallationOwner, PORTABLE_INSTALLATION_PLANS, type PortableAgentInstallationOwnerOptions, type PortableInstallationProgress } from './portable-installation'
import { AGENT_INSTALLER_PUBLIC_ERRORS } from '../../shared/agent-installer-codecs'
import { ServiceProtocolError } from '../../shared/service-protocol'

type Fixture = { root: string; owner: PortableAgentInstallationOwner; detection: PortableAgentDetectionOwner; releases: Array<() => void>; revoke(): void; controls(signal?: AbortSignal): import('./portable-installation').PortableInstallationControls }
const fixtures: Fixture[]=[]
afterEach(async()=>{for(const f of fixtures.splice(0)){for(const release of f.releases)release();await f.owner.close();await f.detection.close();rmSync(f.root,{recursive:true,force:true})}vi.restoreAllMocks()})
function standaloneNode(): string {
  if(process.env.TAURI_NODE_RUNTIME)return realpathSync(process.env.TAURI_NODE_RUNTIME)
  if(!process.versions.electron)return realpathSync(process.execPath)
  for(const candidate of ['/usr/bin/node','/usr/local/bin/node'])if(existsSync(candidate))return realpathSync(candidate)
  throw new Error('Real standalone Node is required for installer fixtures')
}
async function fixture(mode='install', overrides: Partial<PortableAgentInstallationOwnerOptions>={}) {
  const root=mkdtempSync(join(tmpdir(),'21x-cli-install-')),home=join(root,'home'),cwd=join(root,'profile'),bin=join(root,'fixture-bin'),prefix=join(cwd,'agent-cli'),node=standaloneNode()
  for(const path of [home,cwd,bin])mkdirSync(path,{recursive:true})
  const npmCli=join(root,'npm-cli.js'), receiptPath=join(root,'receipt.json')
  const installer=`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1];
fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({args,keys:Object.keys(process.env),home:process.env.HOME,piRoot:process.env.PI_CODING_AGENT_DIR??null,pid:process.pid}));
const mode=${JSON.stringify(mode)};
if(mode==='hold'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
else if(mode==='overflow'){process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)}
else if(mode==='failure'){process.stderr.write('private-key/path/details');process.exitCode=1}
else if(mode==='nothing'){process.stdout.write('private-key/path/details')}
else{
const packages=${JSON.stringify(Object.fromEntries(Object.entries(PORTABLE_INSTALLATION_PLANS).map(([key,plan])=>[plan.package,{key,bin:plan.bin}])))};
const name=args.find(value=>Object.hasOwn(packages,value)),plan=packages[name],version=plan.key==='pi'?'0.80.5':'1.2.3';
const directory=path.join(prefix,'lib','node_modules',name),entry=path.join(directory,'cli.js');fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name,version,bin:{[plan.bin]:'cli.js'},unknown:{preserved:true}}));
const code='#!'+${JSON.stringify(node)}+'\\n'+
'const fs=require("node:fs"),path=require("node:path");const args=process.argv.slice(2);'+
'if(args[0]==="--version")process.stdout.write("'+(mode==='version-mismatch'?'1.2.4':version)+'\\\\n");'+
'else if(args[0]==="install"&&args[1]==="npm:pi-mcp-adapter"&&'+JSON.stringify(mode!=='adapter-missing')+'){const dir=path.join(process.env.PI_CODING_AGENT_DIR,"npm","node_modules","pi-mcp-adapter");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"pi-mcp-adapter",version:"1.0.0"}));fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,"settings.json"),JSON.stringify({packages:["npm:pi-mcp-adapter"]}));}'+
'else if(args[0]==="--help")process.stdout.write("'+(mode==='adapter-missing'?'No adapter flag':'--mcp-config <path>')+'\\\\n");';
fs.writeFileSync(entry,code,{mode:0o755});const link=path.join(prefix,'bin',plan.bin);try{fs.unlinkSync(link)}catch{}fs.symlinkSync(entry,link);
process.stdout.write('private-key/path/details');}
`
  writeFileSync(npmCli,installer,{mode:0o600})
  symlinkSync(node,join(bin,'node'))
  for(const command of ['npm','git','gh','glab','tea','rtk'])writeFileSync(join(bin,command),`#!${node}\nif(process.argv[2]==='prefix')process.stdout.write(${JSON.stringify(prefix)});else process.stdout.write('1.2.3\\n')\n`,{mode:0o755})
  const environment={PATH:bin,HOME:home},detection=new PortableAgentDetectionOwner({home,cwd,environment,preferredPaths:[join(prefix,'bin'),bin],probeTimeoutMs:2000})
  let granted=true
  const current=()=>{if(!granted)throw new ServiceProtocolError('INVALID_REQUEST')}
  const owner=new PortableAgentInstallationOwner({home,cwd,environment,detection,nodeExecutable:node,npm:{cliPath:npmCli,prefix},assertCurrent:()=>{},...overrides})
  const progress:PortableInstallationProgress[]=[],releases:Array<()=>void>=[]
  const f={root,home,cwd,bin,prefix,node,npmCli,receiptPath,detection,owner,progress,releases,revoke:()=>{granted=false},controls:(signal=new AbortController().signal)=>({signal,beforeEffect:current,onProgress:(value:PortableInstallationProgress)=>progress.push(value)})}
  fixtures.push(f);return f
}
describe.skipIf(!['linux','darwin'].includes(process.platform))('real controlled Node/npm installer ownership',()=>{
  it.each(['claudeCode','opencode','codex','pnpm'] as const)('installs fixed %s plan and verifies real managed manifest and version probes',async name=>{
    const f=await fixture(), originalPath=process.env.PATH, beforeHome=JSON.stringify(process.env.HOME)
    const result=await f.owner.install(name,f.controls())
    expect(result).toMatchObject({success:true,error:null,newStatus:{[name]:{installed:true,version:'1.2.3'}}})
    const receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'))
    expect(receipt.args.slice(0,3)).toEqual(PORTABLE_INSTALLATION_PLANS[name].args)
    expect(receipt.args).toEqual([...PORTABLE_INSTALLATION_PLANS[name].args,'--prefix',f.prefix,'--cache',join(f.prefix,'.npm-cache'),'--registry','https://registry.npmjs.org/','--userconfig','/dev/null','--globalconfig','/dev/null','--no-audit','--no-fund'])
    expect(receipt.keys).not.toEqual(expect.arrayContaining(['TASK_API_TOKEN','GH_TOKEN','OPENAI_API_KEY','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']))
    expect(f.progress.map(row=>row.stage)).toEqual(['starting','installing','verifying','complete']);expect(JSON.stringify(f.progress)).not.toContain('private-key')
    expect(process.env.PATH).toBe(originalPath);expect(JSON.stringify(process.env.HOME)).toBe(beforeHome)
    expect(f.owner.childCount).toBe(0)
  })
  it('owns Pi registration and verifies managed adapter without touching user global settings',async()=>{
    const f=await fixture(), result=await f.owner.install('pi',f.controls())
    expect(result).toMatchObject({success:true,error:null,newStatus:{pi:{installed:true,supported:true,version:'0.80.5'}}})
    expect(f.owner.piConfigRoot).toBe(join(f.prefix,'.pi-agent'))
    expect(readFileSync(join(f.prefix,'.pi-agent','settings.json'),'utf8')).toContain('npm:pi-mcp-adapter')
    expect(existsSync(join(f.home,'.pi','agent','settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(f.receiptPath,'utf8')).args.slice(0,4)).toEqual(['install','-g','--ignore-scripts','@earendil-works/pi-coding-agent'])
    const next=new PortableAgentInstallationOwner({home:f.home,cwd:f.cwd,environment:{PATH:[join(f.prefix,'bin'),f.bin].join(delimiter)},detection:f.detection,nodeExecutable:f.node,npm:{cliPath:f.npmCli,prefix:f.prefix},assertCurrent:()=>{}})
    try{expect(await next.verifyManagedPiRuntime(f.controls())).toBe(join(f.prefix,'.pi-agent'));expect(next.piConfigRoot).toBe(join(f.prefix,'.pi-agent'))}finally{await next.close()}
    const override=new PortableAgentInstallationOwner({home:f.home,cwd:f.cwd,environment:{PATH:f.bin},detection:f.detection,nodeExecutable:f.node,npm:{cliPath:f.npmCli,prefix:f.prefix},legacyPiConfigRoot:join(f.home,'original-custom-pi'),assertCurrent:()=>{}})
    try{expect(override.canInstall('pi')).toBe(false);expect(await override.verifyManagedPiRuntime(f.controls())).toBeNull();expect(await override.install('pi',f.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable})}finally{await override.close()}
    expect(f.progress.filter(row=>row.stage==='installing')).toHaveLength(1)
  })
  it('refuses unknown/unsupported plans and missing capability without an installer child',async()=>{
    const spawn=vi.fn(realSpawn) as unknown as typeof realSpawn,f=await fixture('install',{spawn})
    expect(f.owner.canInstall('git')).toBe(false)
    expect(await f.owner.install('git',f.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unsupported,newStatus:{git:{installed:true}}});expect(spawn).not.toHaveBeenCalled()
    await expect(async()=>f.owner.install('foreign-package',f.controls())).rejects.toMatchObject({code:'AGENT_INSTALLATION_INVALID_OPTIONS'})
    const noNpm=new PortableAgentInstallationOwner({home:f.home,cwd:f.cwd,environment:{PATH:f.bin},detection:f.detection,nodeExecutable:f.node,assertCurrent:()=>{}})
    try{expect(noNpm.canInstall('codex')).toBe(false);expect(await noNpm.install('codex',f.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable})}finally{await noNpm.close()}
  })
  it('refuses existing external Pi/config and preserves CLI MCP and unknown saved fields',async()=>{
    const f=await fixture(),legacy=join(f.home,'.pi','agent');mkdirSync(legacy,{recursive:true})
    const saved='{"unknown":"keep","packages":["npm:user-extension"],"auth":"private"}';writeFileSync(join(legacy,'settings.json'),saved)
    mkdirSync(join(f.home,'.codex'),{recursive:true});writeFileSync(join(f.home,'.codex','config.toml'),'# Keep comments\n[mcp_servers.user]\ncommand="private"\n')
    expect(await f.owner.install('pi',f.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable});expect(existsSync(f.receiptPath)).toBe(false)
    expect(readFileSync(join(legacy,'settings.json'),'utf8')).toBe(saved)
    expect(await f.owner.install('codex',f.controls())).toMatchObject({success:true});expect(readFileSync(join(f.home,'.codex','config.toml'),'utf8')).toContain('# Keep comments')
    const f2=await fixture();writeFileSync(join(f2.bin,'pi'),`#!${f2.node}\nprocess.stdout.write('0.80.5\\n')\n`,{mode:0o755})
    expect(await f2.owner.install('pi',f2.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.unavailable});expect(existsSync(f2.receiptPath)).toBe(false)
  })
  it.each(['nothing','failure','overflow'])('does not claim %s installer success or expose raw errors',async mode=>{
    const f=await fixture(mode,{stepTimeoutMs:1000}),result=await f.owner.install('codex',f.controls())
    expect(result.success).toBe(false);expect(result.error).toBe(mode==='nothing'?AGENT_INSTALLER_PUBLIC_ERRORS.notDetected:AGENT_INSTALLER_PUBLIC_ERRORS.failed)
    expect(JSON.stringify(result)).not.toContain('private-key');expect(JSON.stringify(f.progress)).not.toContain('private-key')
    expect(f.owner.childCount).toBe(0)
  })
  it('refuses mismatched managed version, missing Pi adapter and malformed restart manifests',async()=>{
    const mismatch=await fixture('version-mismatch')
    expect(await mismatch.owner.install('codex',mismatch.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.notDetected,newStatus:{codex:{installed:true,version:'1.2.4'}}})
    const pi=await fixture('adapter-missing')
    expect(await pi.owner.install('pi',pi.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.adapterMissing})
    expect(pi.owner.piConfigRoot).toBeNull()
    const fresh=await fixture();expect(await fresh.owner.verifyManagedPiRuntime(fresh.controls())).toBeNull()
    const packageRoot=join(fresh.prefix,'lib','node_modules',PORTABLE_INSTALLATION_PLANS.pi.package);mkdirSync(packageRoot,{recursive:true})
    writeFileSync(join(packageRoot,'package.json'),'x'.repeat(1024*1024))
    await expect(fresh.owner.verifyManagedPiRuntime(fresh.controls())).rejects.toMatchObject({code:'AGENT_INSTALLATION_INVALID_OPTIONS'})
    expect(fresh.owner.childCount).toBe(0);expect(fresh.owner.piConfigRoot).toBeNull()
  })
  it('keeps real quiet child ownership through timeout/shutdown and preserves an unrelated process',async()=>{
    const f=await fixture('hold',{stepTimeoutMs:3000}),other=realSpawn(f.node,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true})
    const otherClosed=new Promise<void>(resolve=>other.once('close',()=>resolve()))
    try{
      const pending=f.owner.install('codex',f.controls()),failure=expect(pending).rejects.toMatchObject({code:'AGENT_INSTALLATION_CANCELLED'})
      await vi.waitFor(()=>expect(existsSync(f.receiptPath)).toBe(true));expect(f.owner.childCount).toBe(1)
      await expect(f.owner.close(5)).rejects.toMatchObject({code:'AGENT_INSTALLATION_TIMEOUT'});expect(f.owner.inflightCount).toBeGreaterThan(0)
      await failure;await f.owner.close();expect(f.owner.childCount).toBe(0);expect(other.exitCode).toBeNull()
    }finally{other.kill('SIGTERM');await otherClosed}
  })
  it('waits child and both pipe closes after errors/ignored cancellation instead of releasing at kill',async()=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>false),pid:undefined}) as unknown as ChildProcess
    const spawn=vi.fn(()=>child) as unknown as typeof realSpawn,f=await fixture('install',{spawn})
    const abort=new AbortController(),pending=f.owner.install('codex',f.controls(abort.signal)),failure=expect(pending).rejects.toMatchObject({code:'AGENT_INSTALLATION_CANCELLED'})
    f.releases.push(()=>{child.emit('close',1);child.stdout?.emit('close');child.stderr?.emit('close')})
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(1));child.emit('error',new Error('private diagnostics'));abort.abort()
    await expect(f.owner.close(5)).rejects.toMatchObject({code:'AGENT_INSTALLATION_TIMEOUT'});child.emit('close',1);expect(f.owner.childCount).toBe(1)
    child.stdout?.emit('close');expect(f.owner.childCount).toBe(1);child.stderr?.emit('close');await failure;await f.owner.close();expect(f.owner.childCount).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it('checks revoked authority after raw installation and does not begin a new verification phase',async()=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>false),pid:undefined}) as unknown as ChildProcess
    const spawn=vi.fn(()=>child) as unknown as typeof realSpawn,f=await fixture('install',{spawn}),pending=f.owner.install('codex',f.controls()),failure=expect(pending).rejects.toMatchObject({code:'INVALID_REQUEST'})
    f.releases.push(()=>{child.emit('close',0);child.stdout?.emit('close');child.stderr?.emit('close')})
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(1));f.revoke();child.emit('close',0);child.stdout?.emit('close');child.stderr?.emit('close');await failure
    expect(f.progress.map(row=>row.stage)).toEqual(['starting','installing']);expect(spawn).toHaveBeenCalledTimes(1)
  })
  it('refuses changed programs/linked managed paths before child effects and joins late opened descriptors',async()=>{
    const f=await fixture();writeFileSync(f.npmCli,'changed owner program')
    expect(await f.owner.install('codex',f.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.failed});expect(existsSync(f.receiptPath)).toBe(false)
    const linked=await fixture();mkdirSync(join(linked.root,'foreign'));symlinkSync(join(linked.root,'foreign'),linked.prefix)
    expect(await linked.owner.install('codex',linked.controls())).toMatchObject({success:false,error:AGENT_INSTALLER_PUBLIC_ERRORS.failed});expect(existsSync(linked.receiptPath)).toBe(false)
    let closes=0
    const open=(async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);fault.revoke();return new Proxy(handle,{get(target,key){if(key==='close')return async()=>{closes++;await target.close()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}) as typeof realOpen
    const fault=await fixture('install',{open});await expect(fault.owner.install('codex',fault.controls())).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(closes).toBe(1);expect(fault.owner.inflightCount).toBe(0)
  })
  it('retains a failed exact descriptor close and refuses duplicate work until a drain retry succeeds',async()=>{
    let closes=0
    const open=(async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);return new Proxy(handle,{get(target,key){if(key==='close')return async()=>{closes++;if(closes===1)throw new Error('private close failure');await target.close()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}) as typeof realOpen
    const f=await fixture('install',{open});await expect(f.owner.install('codex',f.controls())).rejects.toMatchObject({code:'AGENT_INSTALLATION_CLOSE_FAILED'});expect(f.owner.inflightCount).toBe(1)
    await expect(async()=>f.owner.install('codex',f.controls())).rejects.toMatchObject({code:'AGENT_INSTALLATION_BACKPRESSURE'});await f.owner.close();expect(f.owner.inflightCount).toBe(0);expect(closes).toBe(2)
  })
  it('joins the same blocked descriptor-close retry through repeated public deadlines',async()=>{
    let closes=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve})
    const open=(async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);return new Proxy(handle,{get(target,key){if(key==='close')return async()=>{closes++;if(closes===1)throw new Error('close refused');await held;await target.close()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}) as typeof realOpen
    const f=await fixture('install',{open});f.releases.push(release)
    await expect(f.owner.install('codex',f.controls())).rejects.toMatchObject({code:'AGENT_INSTALLATION_CLOSE_FAILED'})
    await expect(f.owner.close(5)).rejects.toMatchObject({code:'AGENT_INSTALLATION_TIMEOUT'})
    await expect(f.owner.close(5)).rejects.toMatchObject({code:'AGENT_INSTALLATION_TIMEOUT'});expect(closes).toBe(2);expect(f.owner.inflightCount).toBe(1)
    release();await f.owner.close();expect(closes).toBe(2);expect(f.owner.inflightCount).toBe(0)
  })
})
