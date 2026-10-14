import type { DesktopCommandMap } from './desktop-operations'
import { CLI_IDS, MASKED_SECRET } from './cli-mcp-config'
import { hasExactKeys, isJsonValue, isRecord, ServiceProtocolError, type JsonValue } from './service-protocol'
import type { OptionalResult } from './host-services'
export const CLI_MCP_OPERATIONS=['cliMcp:snapshot','cliMcp:upsert','cliMcp:remove','cliMcp:setEnabled','cliMcp:setToolEnabled','cliMcp:probe'] as const
export type CliMcpOperation=typeof CLI_MCP_OPERATIONS[number]
export const CLI_MCP_LIMITS=Object.freeze({bytes:900000,servers:128,tools:128,recordKeys:128,values:16384})
type Check=(value:unknown)=>boolean
function fail(code:'INVALID_ARGUMENTS'|'INVALID_RESULT'):never{throw new ServiceProtocolError(code)}
const unicode=(value:string)=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value))===value
const text=(max:number):Check=>value=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&unicode(value)
const name:Check=value=>text(128)(value)&&!!(value as string).trim()&&!/[\u0000-\u001f\u007f]/.test(value as string)&&!['__proto__','constructor','prototype'].includes(value as string)
const cli:Check=value=>CLI_IDS.includes(value as never)
const fingerprint:Check=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const date:Check=value=>text(128)(value)&&Number.isFinite(Date.parse(value as string))
const bool:Check=value=>typeof value==='boolean'
const list=(check:Check,max:number):Check=>value=>Array.isArray(value)&&value.length<=max&&value.every(check)
const bytes:Check=value=>isJsonValue(value)&&new TextEncoder().encode(JSON.stringify(value)).byteLength<=CLI_MCP_LIMITS.bytes
const record=(value:unknown,kind:'env'|'header'):boolean=>isRecord(value)&&Object.keys(value).length<=128&&Object.entries(value).every(([key,value])=>name(key)&&text(16384)(value)&&(kind==='env'?/^[A-Za-z_][A-Za-z0-9_]*$/.test(key):!/[\r\n:]/.test(key)))
function definition(value:unknown,input=false):boolean{
 if(!isRecord(value)||!hasExactKeys(value,['transport'],['command','args','url','env','headers'])||!['stdio','http','sse'].includes(value.transport as string))return false
 if(value.command!==undefined&&!text(4096)(value.command)||value.args!==undefined&&!list(text(4096),128)(value.args)||value.url!==undefined&&!text(4096)(value.url)||value.env!==undefined&&!record(value.env,'env')||value.headers!==undefined&&!record(value.headers,'header'))return false
 if(!input)return true
 if(value.transport==='stdio')return typeof value.command==='string'&&!!value.command.trim()&&!/[\r\n]/.test(value.command)
 try{const url=new URL(value.url as string);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}
}
const ref=(value:unknown,extra:string[]=[],checks:Check[]=[]):boolean=>isRecord(value)&&hasExactKeys(value,['cli','name',...extra],['expectedFingerprint'])&&cli(value.cli)&&name(value.name)&&(value.expectedFingerprint===undefined||fingerprint(value.expectedFingerprint))&&extra.every((key,i)=>checks[i](value[key]))
const tools:Check=list(value=>isRecord(value)&&hasExactKeys(value,['name','description'])&&name(value.name)&&text(4096)(value.description),128)
const probe=(value:unknown,extended=false):boolean=>isRecord(value)&&hasExactKeys(value,['status','checkedAt'],['error','errorDetail','toolCount',...(extended?['tools','unresolvedReferences']:[])])&&['connected','failed'].includes(value.status as string)&&date(value.checkedAt)&&(value.error===undefined||text(4096)(value.error))&&(value.errorDetail===undefined||text(4096)(value.errorDetail))&&(value.toolCount===undefined||Number.isSafeInteger(value.toolCount)&&(value.toolCount as number)>=0&&(value.toolCount as number)<=128)&&(!extended||value.tools===undefined||tools(value.tools))&&(!extended||value.unresolvedReferences===undefined||list(name,128)(value.unresolvedReferences))
const server:Check=value=>isRecord(value)&&hasExactKeys(value,['cli','name','definition','enabled','disabledTools','maskedKeys','issues'],['enabledToolsOnly','tools','probe'])&&cli(value.cli)&&name(value.name)&&definition(value.definition)&&bool(value.enabled)&&list(name,128)(value.disabledTools)&&(value.enabledToolsOnly===undefined||list(name,128)(value.enabledToolsOnly))&&isRecord(value.maskedKeys)&&hasExactKeys(value.maskedKeys,['env','headers'])&&list(name,128)(value.maskedKeys.env)&&list(name,128)(value.maskedKeys.headers)&&list(text(4096),32)(value.issues)&&(value.tools===undefined||tools(value.tools))&&(value.probe===undefined||probe(value.probe))
const config:Check=value=>isRecord(value)&&hasExactKeys(value,['cli','label','files','fingerprint','capabilities','notes'],['error'])&&cli(value.cli)&&text(128)(value.label)&&list(file=>isRecord(file)&&hasExactKeys(file,['path','exists','role'])&&text(4096)(file.path)&&bool(file.exists)&&text(128)(file.role),2)(value.files)&&fingerprint(value.fingerprint)&&isRecord(value.capabilities)&&hasExactKeys(value.capabilities,['serverToggle','toolToggle','envReferenceSyntax'])&&['native','deny-rule','none'].includes(value.capabilities.serverToggle as string)&&['native','deny-rule','none'].includes(value.capabilities.toolToggle as string)&&text(128)(value.capabilities.envReferenceSyntax)&&list(text(4096),32)(value.notes)&&(value.error===undefined||text(4096)(value.error))
export const isCliMcpSnapshot:Check=value=>isRecord(value)&&hasExactKeys(value,['clis','servers','loadedAt'])&&Array.isArray(value.clis)&&value.clis.length===3&&value.clis.every(config)&&new Set(value.clis.map(row=>(row as {cli:string}).cli)).size===3&&list(server,128)(value.servers)&&date(value.loadedAt)&&bytes(value)
const apply:Check=value=>isRecord(value)&&hasExactKeys(value,['cli','ok','warnings'],['error','conflict'])&&cli(value.cli)&&bool(value.ok)&&list(text(4096),32)(value.warnings)&&(value.error===undefined||text(4096)(value.error))&&(value.conflict===undefined||isRecord(value.conflict)&&hasExactKeys(value.conflict,['cli','paths','expectedFingerprint','currentFingerprint'])&&cli(value.conflict.cli)&&list(text(4096),2)(value.conflict.paths)&&fingerprint(value.conflict.expectedFingerprint)&&fingerprint(value.conflict.currentFingerprint))
const mutation:Check=value=>isRecord(value)&&hasExactKeys(value,['results','snapshot'])&&list(apply,3)(value.results)&&isCliMcpSnapshot(value.snapshot)&&bytes(value)
const upsert:Check=value=>isRecord(value)&&hasExactKeys(value,['targets','name','definition'],['previousName','expectedFingerprints'])&&Array.isArray(value.targets)&&value.targets.length>=1&&value.targets.length<=3&&value.targets.every(cli)&&new Set(value.targets).size===value.targets.length&&name(value.name)&&!['__proto__','constructor','prototype'].includes((value.name as string).trim())&&(value.previousName===undefined||name(value.previousName))&&definition(value.definition,true)&&(value.expectedFingerprints===undefined||isRecord(value.expectedFingerprints)&&Object.entries(value.expectedFingerprints).every(([key,value])=>cli(key)&&fingerprint(value)))
const descriptors:Record<CliMcpOperation,{key?:'request'|'ref';argument:Check;result:Check}>={
 'cliMcp:snapshot':{argument:()=>true,result:isCliMcpSnapshot},'cliMcp:upsert':{key:'request',argument:upsert,result:mutation},
 'cliMcp:remove':{key:'ref',argument:ref,result:mutation},'cliMcp:setEnabled':{key:'ref',argument:value=>ref(value,['enabled'],[bool]),result:mutation},
 'cliMcp:setToolEnabled':{key:'ref',argument:value=>ref(value,['tool','enabled'],[name,bool]),result:mutation},'cliMcp:probe':{key:'ref',argument:ref,result:value=>probe(value,true)}
}
export interface CliMcpCodec<K extends CliMcpOperation>{encodeArguments(args:DesktopCommandMap[K]['apiArguments']):JsonValue;decodeArguments(payload:JsonValue):DesktopCommandMap[K]['apiArguments'];validateArguments(args:unknown):boolean;encodeResult(value:unknown):OptionalResult<JsonValue>;decodeResult(value:JsonValue|undefined):DesktopCommandMap[K]['result'];validateResult(value:unknown):boolean;validateWireResult(value:unknown):boolean}
function codec<K extends CliMcpOperation>(operation:K):CliMcpCodec<K>{const d=descriptors[operation],validateArguments=(value:unknown)=>Array.isArray(value)&&value.length===(d.key?1:0)&&(!d.key||d.argument(value[0]))&&bytes(value)
 return {validateArguments,validateResult:value=>d.result(value)&&bytes(value),encodeArguments(args){if(!validateArguments(args))return fail('INVALID_ARGUMENTS');return d.key?{[d.key]:args[0] as unknown as JsonValue}:{}},decodeArguments(payload){if(!isRecord(payload)||!hasExactKeys(payload,d.key?[d.key]:[])||!bytes(payload))return fail('INVALID_ARGUMENTS');const args=d.key?[payload[d.key]]:[];if(!validateArguments(args))return fail('INVALID_ARGUMENTS');return args as DesktopCommandMap[K]['apiArguments']},encodeResult(value){if(!d.result(value)||!bytes(value))return fail('INVALID_RESULT');return {defined:true,value:value as JsonValue}},decodeResult(value){if(!d.result(value)||!bytes(value))return fail('INVALID_RESULT');return value as unknown as DesktopCommandMap[K]['result']},validateWireResult(value){return isRecord(value)&&hasExactKeys(value,['defined','value'])&&value.defined===true&&d.result(value.value)&&bytes(value.value)}}}
export const CLI_MCP_CODECS=Object.fromEntries(CLI_MCP_OPERATIONS.map(operation=>[operation,codec(operation)])) as {[K in CliMcpOperation]:CliMcpCodec<K>}
/** Only declared public fields; raw parse/provider errors are never reflected. */
export function projectCliMcpResult(operation:CliMcpOperation,value:unknown):JsonValue{
 const clean=(value:unknown):unknown=>Array.isArray(value)?value.map(clean):isRecord(value)?Object.fromEntries(Object.entries(value).filter(([,value])=>value!==undefined).map(([key,value])=>[key,clean(value)])):value
 const result=clean(value)
 if(!isRecord(result))return fail('INVALID_RESULT')
 const fixedProbe=(value:Record<string,unknown>)=>{if(value.error!==undefined)value.error='The MCP connection could not be checked.';if(value.errorDetail!==undefined)value.errorDetail='The probe failed or is unavailable.'}
 if(operation==='cliMcp:probe')fixedProbe(result)
 const snapshot=operation==='cliMcp:snapshot'?result:result.snapshot
 if(isRecord(snapshot)){
   if(Array.isArray(snapshot.clis))for(const cli of snapshot.clis)if(isRecord(cli)&&cli.error!==undefined)cli.error='The CLI configuration could not be read.'
   if(Array.isArray(snapshot.servers))for(const server of snapshot.servers)if(isRecord(server)){
     if(isRecord(server.definition)&&typeof server.definition.url==='string'){
       try {const url=new URL(server.definition.url);if(url.username||url.password||url.search||url.hash){url.username='';url.password='';url.search='';url.hash='';server.definition.url=url.href;server.issues=['The saved URL contains private parameters; editing this entry is unavailable.']}}
       catch {server.definition.url='';server.issues=['The saved server URL is invalid.']}
     }
     if(Array.isArray(server.issues)&&server.issues.length)server.issues=['The saved server has unsupported or invalid configuration.'];if(isRecord(server.probe))fixedProbe(server.probe)
   }
 }
 if(Array.isArray(result.results))for(const row of result.results)if(isRecord(row)){
   if(row.error!==undefined)row.error='The CLI configuration change could not be applied.'
   if(Array.isArray(row.warnings)&&row.warnings.length>32)row.warnings=[...row.warnings.slice(0,31),'Additional configuration notes were omitted.']
 }
 if(!CLI_MCP_CODECS[operation].validateResult(result))return fail('INVALID_RESULT')
 return result as JsonValue
}
export {MASKED_SECRET}
