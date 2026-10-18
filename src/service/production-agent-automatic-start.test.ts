import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { START_QUEUE_MAX_RETRIES } from '../main/sessions/start-queue-store'
import { ProductionAgentBackend } from './production-agent-backend'
import { PRODUCTION_AGENT_CODECS } from '../shared/production-agent-codecs'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
let clock = 0
let db: ReturnType<typeof createPortableTestDb>, manager: AgentManager, backend: ProductionAgentBackend, adapter: FakeAdapter
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'automatic-start-proof', webviewId: 'main', origin: 'app://automatic-start-proof' }
beforeEach(() => {
 clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock)
 db = createPortableTestDb(); adapter = new FakeAdapter()
 const host: AgentManagerHost = { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => false }
 manager = new AgentManager(db, host)
 backend = new ProductionAgentBackend({ database: db, manager, engineEpoch: caller.engineEpoch, assertAvailable() { if(!db.db.open) throw new Error('Closed fixture') }, isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin, canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true })
 vi.spyOn(console,'log').mockImplementation(()=>{}); vi.spyOn(console,'warn').mockImplementation(()=>{}); vi.spyOn(console,'error').mockImplementation(()=>{})
})
afterEach(async () => { await backend.close(); await manager.stopAllSessions(); const root=dirname(dirname(db.getWorkspaceDir('fixture'))); db.close(); rmSync(root,{recursive:true,force:true}); vi.restoreAllMocks() })
async function start(agentId:string, taskId:string) {
 const codec=PRODUCTION_AGENT_CODECS['agentSession:start']; const wire=await backend.registry.invoke('agentSession:start',codec.encodeArguments([agentId,taskId]),caller,new AbortController().signal)
 expect(codec.validateWireResult(wire)).toBe(true);return codec.decodeResult((wire as {value?:JsonValue}).value)
}
function fixture(assigned=true) {
 const agent=db.createAgent({name:'Controlled automatic agent',is_default:true,config:{coding_agent:'pi',max_parallel_sessions:1}})!
 const task=db.createTask({title:'Original automatic task'})!; if(assigned)db.updateTask(task.id,{agent_id:agent.id});return {agent,task}
}
it('classifies retained exact start of an existing null-agent task as Source triage without an explicit-user startTask call',async()=>{
 const f=fixture(false), result=await start(f.agent.id,f.task.id)
 expect(result.sessionId).not.toBe('');expect(manager.getSession(result.sessionId)?.isTriageSession).toBe(true);expect(db.getTask(f.task.id)?.agent_id).toBeNull();expect(adapter.createSession).toHaveBeenCalledOnce();expect(adapter.sendPrompt).toHaveBeenCalledOnce()
})
it('retains a real admission queue and refuses automatic restart of its cancelled recovery before adapter effects',async()=>{
 const f=fixture();await start(f.agent.id,f.task.id);const second=db.createTask({title:'Queued exact target'})!;db.updateTask(second.id,{agent_id:f.agent.id});expect(await start(f.agent.id,second.id)).toMatchObject({sessionId:'',queued:true})
 await backend.registry.invoke('agentSession:stopByTaskId',PRODUCTION_AGENT_CODECS['agentSession:stopByTaskId'].encodeArguments([second.id]),caller,new AbortController().signal)
 const before=db.getTask(second.id);expect(manager.getStartRecoveryState(second.id)?.state).toBe('cancelled');await expect(start(f.agent.id,second.id)).rejects.toMatchObject({code:'INTERNAL_ERROR'});expect(adapter.createSession).toHaveBeenCalledOnce();expect(adapter.sendPrompt).toHaveBeenCalledOnce();expect(db.getTask(second.id)).toEqual(before)
})
it('refuses automatic exact start after the actual Source retry budget is exhausted',async()=>{
 const f=fixture();adapter.createSession.mockRejectedValue(new Error('Controlled provider startup refusal'));await expect(start(f.agent.id,f.task.id)).rejects.toMatchObject({code:'INTERNAL_ERROR'})
 expect(manager.getStartRecoveryState(f.task.id)?.state).toBe('retrying')
 for(let i=0;i<START_QUEUE_MAX_RETRIES;i++) {
   clock=Date.parse(manager.getStartRecoveryState(f.task.id)!.nextRetryAt!)+1
   await vi.waitFor(()=>{ manager.drainStartQueue(); expect(manager.getStartRecoveryState(f.task.id)?.retryCount).toBe(i+2) })
 }
 expect(manager.getStartRecoveryState(f.task.id)?.state).toBe('failed');const before=db.getTask(f.task.id), attempts=adapter.createSession.mock.calls.length
 await expect(start(f.agent.id,f.task.id)).rejects.toMatchObject({code:'INTERNAL_ERROR'});expect(adapter.createSession).toHaveBeenCalledTimes(START_QUEUE_MAX_RETRIES+1);expect(adapter.createSession.mock.calls).toHaveLength(attempts);expect(adapter.sendPrompt).not.toHaveBeenCalled();expect(db.getTask(f.task.id)).toEqual(before)
})

it('refuses automatic exact start after an acknowledged real Stop without clearing recovery or re-creating a provider',async()=>{
 const f=fixture();await start(f.agent.id,f.task.id);await backend.registry.invoke('agentSession:stopByTaskId',PRODUCTION_AGENT_CODECS['agentSession:stopByTaskId'].encodeArguments([f.task.id]),caller,new AbortController().signal)
 expect(manager.getStartRecoveryState(f.task.id)?.state).toBe('cancelled');const before=db.getTask(f.task.id);await expect(start(f.agent.id,f.task.id)).rejects.toMatchObject({code:'INTERNAL_ERROR'});expect(adapter.createSession).toHaveBeenCalledOnce();expect(adapter.sendPrompt).toHaveBeenCalledOnce();expect(db.getTask(f.task.id)).toEqual(before)
})
