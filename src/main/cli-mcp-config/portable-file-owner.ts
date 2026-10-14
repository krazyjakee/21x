import { AsyncLocalStorage } from 'node:async_hooks'
import { constants, lstatSync, realpathSync, mkdirSync, openSync, fstatSync, readSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync, linkSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileSnapshot } from './file-store'

export const CLI_MCP_FILE_LIMITS = Object.freeze({ fileBytes: 256 * 1024, aggregateBytes: 512 * 1024 })
export interface CliMcpFilePrimitives {
  lstat(path:string):BigIntStats; realpath(path:string):string; mkdir(path:string):void
  open(path:string,flags:number,mode?:number):number; fstat(fd:number):BigIntStats
  read(fd:number,buffer:Buffer,offset:number,length:number,position:number):number
  write(fd:number,buffer:Buffer,offset:number,length:number,position:number):number
  fsync(fd:number):void; chmod(fd:number,mode:number):void; close(fd:number):void
  rename(from:string,to:string):void; link(from:string,to:string):void; unlink(path:string):void
}
export interface CliMcpFileOwnerOptions { homeDir:string; env:NodeJS.ProcessEnv; assertCurrent():void; fs?:Partial<CliMcpFilePrimitives> }
interface Identity { dev:bigint; ino:bigint; size:bigint; nlink:bigint; mode:bigint; mtime:bigint; ctime:bigint; directory:boolean }
interface Receipt { path:string; identity:Identity|null; hash:string }
interface Scope { active:boolean; beforeEffect():void; signal:AbortSignal; parent?:Scope }
interface Fd { fd:number; path:string; failed:boolean }
interface Temp { path:string; identity:Identity; preserve?:boolean; linked?:string }
function fail(code:string):never { throw new Error(code) }
const missing = (error:unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (value:string|Buffer):string => createHash('sha256').update(value).digest('hex')
const same = (a:Identity,b:Identity) => a.dev===b.dev && a.ino===b.ino && a.directory===b.directory
const exact = (a:Identity,b:Identity) => same(a,b) && a.size===b.size && a.nlink===b.nlink && a.mode===b.mode && a.mtime===b.mtime && a.ctime===b.ctime
function identity(value:BigIntStats):Identity {
  if (value.isSymbolicLink() || !value.isDirectory() && !value.isFile() || value.isFile() && value.nlink!==1n || [value.dev,value.ino,value.size,value.nlink,value.mode].some(n=>typeof n!=='bigint'||n<0n||n>18446744073709551615n) || value.size>BigInt(Number.MAX_SAFE_INTEGER)) fail('CLI_MCP_FILE_UNSAFE')
  return {dev:value.dev,ino:value.ino,size:value.size,nlink:value.nlink,mode:value.mode,mtime:value.mtimeNs,ctime:value.ctimeNs,directory:value.isDirectory()}
}
function pathValid(path:string):boolean { return typeof path==='string'&&isAbsolute(path)&&normalize(path)===path&&Buffer.byteLength(path)<=4096&&!/[\u0000-\u001f\u007f]/.test(path) }
/** Exact constructor-selected CLI config files only. No RPC can select paths. */
export class CliMcpFileOwner {
  readonly homeDir:string
  readonly paths:Readonly<{claudeConfig:string;claudeSettings:string;opencode:string;codex:string}>
  private readonly currentOwner:()=>void
  private readonly fs:CliMcpFilePrimitives
  private readonly dirs=new Map<string,Identity>()
  private readonly receipts=new WeakMap<FileSnapshot,Receipt>()
  private readonly fds=new Set<Fd>()
  private readonly temps=new Set<Temp>()
  private readonly scopes=new AsyncLocalStorage<Scope>()
  private closing=false
  private unavailable=false
  constructor(options:CliMcpFileOwnerOptions) {
    if (!options || !pathValid(options.homeDir)||typeof options.assertCurrent!=='function') fail('CLI_MCP_FILE_INVALID')
    this.homeDir=options.homeDir;this.currentOwner=options.assertCurrent;this.currentOwner()
    const defaults:CliMcpFilePrimitives={lstat:p=>lstatSync(p,{bigint:true}),realpath:realpathSync,mkdir:p=>{mkdirSync(p)},open:openSync,fstat:fd=>fstatSync(fd,{bigint:true}),read:readSync,write:writeSync,fsync:fsyncSync,chmod:fchmodSync,close:closeSync,rename:renameSync,link:linkSync,unlink:unlinkSync}
    for(const [key,value] of Object.entries(options.fs??{})) if(!Object.hasOwn(defaults,key)||typeof value!=='function') fail('CLI_MCP_FILE_INVALID')
    this.fs=Object.freeze({...defaults,...options.fs})
    const env={...options.env}
    for(const key of ['CODEX_HOME','XDG_CONFIG_HOME','OPENCODE_CONFIG']) if(env[key] && !pathValid(env[key]!)) {this.unavailable=true;delete env[key]}
    Object.freeze(env)
    const configRoot=env.XDG_CONFIG_HOME||join(this.homeDir,'.config'),json=join(configRoot,'opencode','opencode.json'),jsonc=join(configRoot,'opencode','opencode.jsonc')
    const exists=(p:string):boolean=>{try{this.fs.lstat(p);return true}catch(e){if(!missing(e))this.unavailable=true;return false}}
    this.paths=Object.freeze({claudeConfig:join(this.homeDir,'.claude.json'),claudeSettings:join(this.homeDir,'.claude','settings.json'),opencode:env.OPENCODE_CONFIG||(!exists(json)&&exists(jsonc)?jsonc:json),codex:join(env.CODEX_HOME||join(this.homeDir,'.codex'),'config.toml')})
    if(new Set(Object.values(this.paths)).size!==4) fail('CLI_MCP_FILE_INVALID')
    this.captureParents(this.homeDir)
    for(const path of Object.values(this.paths)) {if(!pathValid(path)){this.unavailable=true;continue}try{this.captureParents(dirname(path))}catch{this.unavailable=true}}
    this.currentOwner()
  }
  assertOwners(homeDir:string):void {if(this.closing||homeDir!==this.homeDir)fail('CLI_MCP_FILE_OWNER_LOST')}
  get inflightCount():number {return this.fds.size+this.temps.size}
  shutdown():void {this.closing=true}
  current():void {
    if(this.closing)fail('CLI_MCP_FILES_CLOSED')
    if(this.unavailable)fail('CLI_MCP_FILE_UNAVAILABLE')
    if([...this.fds].some(fd=>fd.failed))fail('CLI_MCP_FILE_CLOSE_PENDING')
    for(let scope=this.scopes.getStore();scope;scope=scope.parent){if(!scope.active||scope.signal.aborted)fail('CLI_MCP_REQUEST_RETIRED');scope.beforeEffect();if(!scope.active||scope.signal.aborted)fail('CLI_MCP_REQUEST_RETIRED')}
    this.currentOwner()
  }
  async withRequestGuard<T>(effect:()=>Promise<T>,beforeEffect:()=>void,signal:AbortSignal):Promise<T>{
    this.current();if(signal.aborted)fail('CLI_MCP_REQUEST_RETIRED');beforeEffect()
    const scope:Scope={active:true,beforeEffect,signal,parent:this.scopes.getStore()}
    return await this.scopes.run(scope,async()=>{try{const result=await effect();this.current();return result}finally{scope.active=false}})
  }
  private step<T>(effect:()=>T):T{this.current();try{const value=effect();this.current();return value}catch(error){this.current();throw error}}
  private captureParents(path:string):void {
    let depth=0
    for(let current=path;;current=dirname(current)){
      if(++depth>64)fail('CLI_MCP_FILE_UNSAFE')
      try {const found=identity(this.fs.lstat(current));if(!found.directory||this.fs.realpath(current)!==current)fail('CLI_MCP_FILE_UNSAFE');this.dirs.set(current,found)}catch(error){if(!missing(error))throw error}
      if(dirname(current)===current)break
    }
    if(!this.dirs.has(this.homeDir))fail('CLI_MCP_FILE_UNSAFE')
  }
  private parents(path:string,create=false):void {
    const chain:string[]=[];for(let p=dirname(path);;p=dirname(p)){chain.unshift(p);if(dirname(p)===p)break;if(chain.length>64)fail('CLI_MCP_FILE_UNSAFE')}
    for(const p of chain){let found:Identity
      try{found=identity(this.step(()=>this.fs.lstat(p)))}catch(error){if(!missing(error))throw error;if(this.dirs.has(p))fail('CLI_MCP_FILE_CHANGED');if(!create)return
        this.step(()=>this.fs.mkdir(p));found=identity(this.step(()=>this.fs.lstat(p)))}
      const old=this.dirs.get(p);if(!found.directory||old&&!same(old,found)||this.step(()=>this.fs.realpath(p))!==p)fail('CLI_MCP_FILE_CHANGED');this.dirs.set(p,found)
    }
  }
  private approved(path:string):void{if(!Object.values(this.paths).includes(path))fail('CLI_MCP_FILE_INVALID')}
  private stat(path:string):Identity|null{this.approved(path);this.parents(path);try{const found=identity(this.step(()=>this.fs.lstat(path)));if(found.directory)fail('CLI_MCP_FILE_UNSAFE');return found}catch(error){if(missing(error))return null;throw error}}
  preflight():void {this.current();let total=0;for(const path of Object.values(this.paths)){const info=this.stat(path);if(info){if(info.size>BigInt(CLI_MCP_FILE_LIMITS.fileBytes))fail('CLI_MCP_FILE_LIMIT');total+=Number(info.size)}}if(total>CLI_MCP_FILE_LIMITS.aggregateBytes)fail('CLI_MCP_FILE_LIMIT')}
  private publicationBudget(path:string,bytes:number):void {this.preflight();let total=bytes;for(const approved of Object.values(this.paths)){if(approved===path)continue;const info=this.stat(approved);if(info)total+=Number(info.size)}if(total>CLI_MCP_FILE_LIMITS.aggregateBytes)fail('CLI_MCP_FILE_LIMIT')}
  private open(path:string,flags:number,mode=0o600):Fd{this.current();const owned:Fd={fd:this.fs.open(path,flags,mode),path,failed:false};this.fds.add(owned);try{this.current();return owned}catch(error){this.release(owned);throw error}}
  private release(owned:Fd):void{try{this.fs.close(owned.fd);owned.failed=false;this.fds.delete(owned)}catch{owned.failed=true;fail('CLI_MCP_FILE_CLOSE_PENDING')}}
  private bytes(owned:Fd,size:number):Buffer{const bytes=Buffer.alloc(size+1);let offset=0;for(;;){const n=this.step(()=>this.fs.read(owned.fd,bytes,offset,bytes.length-offset,offset));if(!Number.isSafeInteger(n)||n<0||n>bytes.length-offset)fail('CLI_MCP_FILE_IO');if(!n)break;offset+=n;if(offset>size)fail('CLI_MCP_FILE_CHANGED')}if(offset!==size)fail('CLI_MCP_FILE_CHANGED');return bytes.subarray(0,offset)}
  readSnapshot(path:string):FileSnapshot{
    let owned:Fd|undefined
    try{this.preflight();const expected=this.stat(path)
      if(!expected){const result={path,exists:false,content:'',hash:'missing'};this.receipts.set(result,{path,identity:null,hash:'missing'});return result}
      owned=this.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));const initial=identity(this.step(()=>this.fs.fstat(owned!.fd)))
      if(!exact(initial,expected))fail('CLI_MCP_FILE_CHANGED')
      const bytes=this.bytes(owned,Number(initial.size)),final=identity(this.step(()=>this.fs.fstat(owned!.fd))),named=this.stat(path)
      if(!named||!exact(initial,final)||!exact(final,named))fail('CLI_MCP_FILE_CHANGED')
      const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(content.includes('\0'))fail('CLI_MCP_FILE_INVALID')
      const receipt=owned;owned=undefined;this.release(receipt);this.current()
      const result={path,exists:true,content,hash:hash(bytes)};this.receipts.set(result,{path,identity:final,hash:result.hash});return result
    }catch(error){if(error instanceof Error&&/^(CLI_MCP_|CANCELLED|DISCONNECTED|INVALID_REQUEST)/.test(error.message))throw error;this.current();return fail('CLI_MCP_FILE_IO')}finally{if(owned)this.release(owned)}
  }
  readAll():FileSnapshot[]{this.preflight();return Object.values(this.paths).map(path=>this.readSnapshot(path))}
  writeAtomic(path:string,content:string,expected:FileSnapshot):void{
    this.approved(path);const receipt=this.receipts.get(expected);if(!receipt||receipt.path!==path)fail('CLI_MCP_FILE_INVALID')
    if(typeof content!=='string'||content.includes('\0')||Buffer.byteLength(content)>CLI_MCP_FILE_LIMITS.fileBytes||Buffer.from(content).toString('utf8')!==content)fail('CLI_MCP_FILE_LIMIT')
    let owned:Fd|undefined,temp:Temp|undefined
    try{this.publicationBudget(path,Buffer.byteLength(content));this.parents(path,true);const fresh=this.readSnapshot(path),now=this.receipts.get(fresh)!
      if(receipt.hash!==now.hash||(receipt.identity===null?now.identity!==null:now.identity===null||!exact(receipt.identity,now.identity)))fail('CLI_MCP_FILE_CONFLICT')
      const tempPath=join(dirname(path),`.21x-cli-mcp-${randomUUID()}.tmp`);owned=this.open(tempPath,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600)
      temp={path:tempPath,identity:identity(this.step(()=>this.fs.fstat(owned!.fd)))};this.temps.add(temp)
      const bytes=Buffer.from(content);let offset=0
      while(offset<bytes.length){const n=this.step(()=>this.fs.write(owned!.fd,bytes,offset,bytes.length-offset,offset));if(!Number.isSafeInteger(n)||n<1||n>bytes.length-offset)fail('CLI_MCP_FILE_IO');offset+=n;temp.identity=identity(this.step(()=>this.fs.fstat(owned!.fd)))}
      this.step(()=>this.fs.chmod(owned!.fd,Number(receipt.identity?.mode??0o600n)&0o777));this.step(()=>this.fs.fsync(owned!.fd));temp.identity=identity(this.step(()=>this.fs.fstat(owned!.fd)))
      if(temp.identity.size!==BigInt(bytes.length)||!this.bytes(owned,bytes.length).equals(bytes)||!exact(temp.identity,identity(this.step(()=>this.fs.fstat(owned!.fd))))||!exact(temp.identity,identity(this.step(()=>this.fs.lstat(tempPath))))){temp.preserve=true;fail('CLI_MCP_FILE_CHANGED')}
      const closing=owned;owned=undefined;this.release(closing)
      const current=this.readSnapshot(path),currentReceipt=this.receipts.get(current)!
      if(current.hash!==receipt.hash||(receipt.identity===null?currentReceipt.identity!==null:currentReceipt.identity===null||!exact(receipt.identity,currentReceipt.identity)))fail('CLI_MCP_FILE_CONFLICT')
      this.publicationBudget(path,bytes.length);this.parents(path)
      const expectedIdentity=temp.identity
      if(receipt.identity)this.step(()=>this.fs.rename(tempPath,path))
      else{this.current();this.fs.link(tempPath,path);temp.linked=path;this.current();this.clean(temp)}
      this.temps.delete(temp);temp=undefined;this.current();const published=this.stat(path)
      if(!published||!same(published,expectedIdentity)||published.size!==expectedIdentity.size||published.mtime!==expectedIdentity.mtime||(published.mode&0o777n)!==(expectedIdentity.mode&0o777n))fail('CLI_MCP_FILE_CHANGED')
    }catch(error){if(error instanceof Error&&/^(CLI_MCP_|CANCELLED|DISCONNECTED|INVALID_REQUEST)/.test(error.message))throw error;this.current();return fail('CLI_MCP_FILE_IO')}finally{if(owned)this.release(owned);if(temp)this.clean(temp)}
  }
  private clean(temp:Temp):void{
    try{if([...this.fds].some(fd=>fd.path===temp.path))fail('CLI_MCP_FILE_CLOSE_PENDING');if(temp.preserve)fail('CLI_MCP_FILE_CHANGED')
      for(const [path,expected] of this.dirs){let relevant=false;for(let p=dirname(temp.path);;p=dirname(p)){if(p===path)relevant=true;if(dirname(p)===p)break}if(relevant&&!same(identity(this.fs.lstat(path)),expected))fail('CLI_MCP_FILE_CHANGED')}
      const info=this.fs.lstat(temp.path);if(!info.isFile()||info.isSymbolicLink()||info.dev!==temp.identity.dev||info.ino!==temp.identity.ino||info.size!==temp.identity.size||info.mtimeNs!==temp.identity.mtime)fail('CLI_MCP_FILE_CHANGED')
      if(temp.linked){const target=this.fs.lstat(temp.linked);if(info.nlink!==2n||target.dev!==info.dev||target.ino!==info.ino||!target.isFile()||target.isSymbolicLink())fail('CLI_MCP_FILE_CHANGED')}
      else if(info.nlink!==1n||info.ctimeNs!==temp.identity.ctime)fail('CLI_MCP_FILE_CHANGED')
      this.fs.unlink(temp.path);this.temps.delete(temp)
    }catch(error){if(missing(error)){this.temps.delete(temp);return}if(error instanceof Error&&error.message.startsWith('CLI_MCP_'))throw error;fail('CLI_MCP_FILE_IO')}
  }
  async close(timeoutMs=2000):Promise<void>{if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)fail('CLI_MCP_FILE_INVALID');this.shutdown();for(const fd of [...this.fds])try{this.release(fd)}catch{};if(this.fds.size)fail('CLI_MCP_FILE_CLOSE_PENDING');for(const temp of [...this.temps])this.clean(temp);if(this.inflightCount)fail('CLI_MCP_FILE_CLOSE_PENDING')}
}
