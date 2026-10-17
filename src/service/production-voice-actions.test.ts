import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as sourceModule from './production-service'
import {
  PRODUCTION_COMMAND_CODECS,
  validateProductionEventWire,
  type ProductionDesktopBindingOptions
} from './production-desktop-bindings'
import { isBootstrapResult, isRecord, type JsonValue } from '../shared/service-protocol'
import type { ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { ServicePeer, type OperationSchema } from './transport/peer'
import type { VoiceTranscriptInput, VoiceTranscriptLease } from './production-voice-actions'
import type { NativeVoiceEvent } from '../shared/voice-native-callbacks'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import { PiAdapter } from '../main/adapters/pi-adapter'
import type { ChatProvider } from '../main/chat/providers/types'

const cleanups: Array<() => Promise<void>> = []
const releases: Array<()=>void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
let stagedModule: typeof sourceModule | undefined
const cases = ['source', ...(process.env.TAURI_PRODUCTION_SERVICE_ENTRY ? ['staged'] : [])]
async function fixture(kind: string) {
  vi.resetModules()
  const module =
    kind === 'staged'
      ? stagedModule!
      : await import('./production-service')
  const root = mkdtempSync(join(tmpdir(), '21x-voice-actions-'))
  const descriptor: ProductionLaunchDescriptor = {
    version: 1,
    kind: 'production-private-launch',
    launchId: 'voice_actions_launch',
    profileId: 'voice-actions-profile',
    profileIntent: 'create-new',
    buildIdentity: 'production-voice-fixture',
    resourceManifestSha256: 'a'.repeat(64),
    paths: {
      resourceRoot: join(root, 'resources'),
      profileRoot: join(root, 'profile'),
      workspaceRoot: join(root, 'workspaces'),
      attachmentRoot: join(root, 'attachments'),
      reposRoot: join(root, 'repos'),
      tempRoot: join(root, 'temp')
    },
    capabilities: {
      externalUrls: 'unsupported',
      notifications: 'unsupported',
      energy: 'unsupported',
      ui: 'unsupported',
      voice: 'unsupported',
      configuredMcp: 'disabled',
      managedTaskMcp: 'disabled',
      connectors: 'disabled'
    }
  }
  mkdirSync(descriptor.paths.resourceRoot)
  let allowed = true,
    writes = true,
    adapterChoice: CodingAgentAdapter | undefined
  const check = () => allowed
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: check,
    canAccessTask: (_id, _caller, access) => allowed && (access === 'read' || writes),
    canAccessProject: (_id, _caller, access) => allowed && (access === 'read' || writes),
    canAccessAgent: (_id, _caller, access) => allowed && (access === 'read' || writes),
    canAccessSource: check,
    canAccessSession: check,
    canAccessGlobalCommander: check,
    canManageGlobalConfiguration: check,
    canQueryBackend: check,
    canCreateProject: check,
    canEditSettings: check,
    canAccessGlobalSkills: check,
    canChangeSkillScope: check,
    canReorderProjects: check,
    canReadSetting: check,
    canWriteSetting: check,
    canAccessSecret: check,
    canCreateSecret: check,
    canUseSecretEnvironment: check,
    canReadEnvironment: check,
    canAccessTerminal: check,
    canAccessMcpServer: check,
    canAccessCli: check,
    canUseTransport: check,
    canUseEnvironmentName: check,
    canAccessConnector: check,
    canUseSourcePlugin: check,
    canCreateInstance: check,
    canUsePiece: check,
    canBorrowSourceCredentials: check,
    canResolveUnsavedConfig: check,
    canManageMobile: check,
    canAccessMobileSession: check,
    canAccessMarketplace: check,
    canCreateMarketplace: check,
    canAccessPluginName: check,
    canAccessPlugin: check,
    canUseMarketplaceSource: check,
    canUsePluginAddress: check,
    canUsePluginSource: check,
    canAccessSkill: check,
    canCreateGlobalSkill: check,
    canCreateAgent: check,
    canCreateMcpServer: check,
    resolveTerminalDirectory: () => null
  }
  let session = 0
  const adapter = {
    initialize: vi.fn(async () => {}),
    createSession: vi.fn(async () => `synthetic_session_${++session}`),
    resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ type: 'busy' })),
    pollMessages: vi.fn(async () => []),
    abortPrompt: vi.fn(async () => {}),
    destroySession: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ available: true }))
  }
  const keys = new Map<string, Buffer>(),
    events: Array<{ operation: string; payload: JsonValue }> = []
  const schemas: Record<string, OperationSchema> = Object.fromEntries(
    Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [
      operation,
      {
        validatePayload: (value: unknown) => {
          try {
            return codec.validateArguments(codec.decodeArguments(value as JsonValue))
          } catch {
            return false
          }
        },
        validateResult: codec.validateWireResult
      }
    ])
  )
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  for (const operation of ['voice:startTurn', 'voice:confirm', 'voice:dismiss'])
    schemas[operation] = { validatePayload: isRecord, validateResult: isRecord }
  const deliver = (peer: ServicePeer, bytes: Uint8Array) => {
    for (let n = 0; n < bytes.length; n += 53) peer.receive(bytes.subarray(n, n + 53))
  }
  const host = new ServicePeer({
    role: 'host',
    engineEpoch: null,
    operations: schemas,
    eventSchemas: Object.fromEntries(
      Object.keys((await import('./production-desktop-bindings')).PRODUCTION_EVENT_CODECS).map((operation) => [
        operation,
        (value: unknown) => validateProductionEventWire(operation, value)
      ])
    ),
    write: async (bytes) => deliver(service.peer, bytes),
    onEvent: (event) => events.push({ operation: event.operation, payload: event.payload })
  })
  const provider: ChatProvider = {
    id: 'synthetic',
    model: 'synthetic',
    async *stream() {
      yield { type: 'message_end', stopReason: 'end_turn' }
    }
  }
  const service: sourceModule.ProductionService = new module.ProductionService(
    module.sealProductionServiceHost({
      descriptor,
      authority,
      caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' },
      unbridgedOwnerEvent: () => {},
      boundaries: {
        cliMcp: { homeDir: root, environment: {} },
        createAdapter: () => adapterChoice ?? (adapter as unknown as CodingAgentAdapter),
        createProvider: () => provider
      },
      constructBootstrap: (callbacks) => ({
        profileId: descriptor.profileId,
        paths: descriptor.paths,
        credentials: {
          mode: 'create',
          store: {
            create: async (id, key) => { keys.set(id, Buffer.from(key)) },
            load: async (id) => { const key=keys.get(id); if(!key)throw new Error('Synthetic key absent'); return Buffer.from(key) }
          }
        },
        managedTaskMcp: { disabled: true },
        connectors: { kind: 'disabled', reason: 'Synthetic actions need no connectors' },
        native: {
          agents: {
            renderer: { kind: 'unsupported' },
            notifications: { kind: 'unsupported' },
            energy: { kind: 'unsupported' },
            configuredMcp: 'disabled'
          },
          prepareRuntime: async () => {},
          drainOwnedProcesses: async () => ({ acknowledged: true }),
          openExternal: async () => {},
          notify: () => {},
          emit: callbacks.emitOwnerEvent,
          sendUiCommand: () => ({ ok: false, detail: 'No native voice availability' })
        }
      })
    }),
    { write: async (bytes) => deliver(host, bytes) }
  )
  cleanups.push(async () => {
    await service.close()
    host.disconnect()
    await host.waitForHandlers()
    rmSync(root, { recursive: true, force: true })
  })
  await host.request('engine.ping', {})
  await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
  const actual = service.getReadyServices()!,
    db = actual.db,
    manager = actual.agents,
    project = db.getProjects()[0]
  db.updateProject(project.id, { settings: { ...project.settings, captain_wakeups: { enabled: false } } })
  const caller = {
    principal: 'trusted-desktop-main' as const,
    engineEpoch: service.owner.snapshot().epoch,
    webviewId: 'main',
    origin: 'tauri://localhost',
    uiLeaseId: 'synthetic_document'
  }
  const actions = service.owner.createVoiceActions(authority),
    voiceEvents: NativeVoiceEvent[] = []
  const begin = (input: Partial<VoiceTranscriptInput> = {}) =>
    actions.begin({
      caller,
      projectId: project.id,
      mode: 'command',
      beforeEffect() {},
      publish: (event) => {
        voiceEvents.push(event)
      },
      ...input
    })
  const task = (title: string, assigned = true) => {
    const agent = db.getAgents()[0]
    db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 1 } })
    const row=db.createTask({ title, project_id: project.id })!
    if(assigned)db.updateTask(row.id,{agent_id:agent.id})
    return db.getTask(row.id)!
  }
  return {
    root,
    db,
    manager,
    project,
    actions,
    caller,
    begin,
    host,
    events,
    voiceEvents,
    adapter,
    task,
    service,
    authority,
    deny: () => {
      allowed = false
    },
    denyWrites: () => {
      writes = false
    },
    useAdapter: (value: CodingAgentAdapter) => {
      adapterChoice = value
    }
  }
}
const pair = (lease: VoiceTranscriptLease) => ({ turnId: lease.turnId, turnEpoch: lease.turnEpoch })

for (const kind of cases)
  describe(`actual ${kind} production transcript action owner`, () => {
    beforeAll(async () => {
      if (kind === 'staged') stagedModule = await import(
        pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href
      ) as typeof sourceModule
    })
    it('creates and assigns through canonical task owners and the actual private peer, with no public voice registration', async () => {
      const f = await fixture(kind),
        turn = f.begin()
      const proposed = await turn.finalTranscript('create a task to fix login with high priority')
      expect(proposed.status).toBe('needs_confirmation')
      expect(f.db.getTasks()).toHaveLength(0)
      const accepted = await turn.confirm(pair(turn))
      expect(accepted.success).toBe(true)
      expect(await turn.confirm(pair(turn))).toMatchObject({ success: false })
      await f.service.peer.drain()
      const created = f.db.getTasks()[0]!
      expect(created).toMatchObject({ title: 'fix login', priority: 'high', project_id: f.project.id })
      expect(f.events.filter((event) => event.operation === 'task:created')).toHaveLength(1)
      const agent = f.db.getAgents()[0],
        next = f.begin({ selectedTaskId: created.id })
      expect((await next.finalTranscript(`assign this to ${agent.name}`)).status).toBe('executed')
      await f.service.peer.drain()
      expect(f.db.getTask(created.id)?.agent_id).toBe(agent.id)
      expect(
        f.events.filter(
          (event) =>
            event.operation === 'task:updated' && isRecord(event.payload) && event.payload.taskId === created.id
        )
      ).toHaveLength(1)
      for (const operation of ['voice:startTurn', 'voice:confirm', 'voice:dismiss'])
        await expect(f.host.request(operation, {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    })
    it('keeps fuzzy targets pinned, accepts only offered choices and refuses changed/foreign task scope', async () => {
      const f = await fixture(kind),
        first = f.task('Fix login service'),
        second = f.task('Fix login UI'),
        turn = f.begin()
      const proposed = await turn.finalTranscript('start task Fix login')
      expect(proposed).toMatchObject({ status: 'needs_confirmation', reason: 'ambiguous_task' })
      const foreign = f.db.createProject({ name: 'Foreign' })!,
        other = f.db.createTask({ title: 'Fix login', project_id: foreign.id })!
      expect(await turn.confirm(pair(turn), { taskId: other.id })).toMatchObject({ success: false })
      expect(f.manager.getStartQueue()).toEqual([])
      expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
      const pinned = f.begin()
      expect((await pinned.finalTranscript('start task Fix login service')).status).toBe('executed')
      await pinned.close()
      const stale = f.begin()
      expect((await stale.finalTranscript('start task Fix login')).status).toBe('needs_confirmation')
      f.db.updateTask(second.id, { title: 'Changed after confirmation' })
      expect(await stale.confirm(pair(stale), { taskId: second.id })).toMatchObject({ success: false })
      expect(f.db.getTask(first.id)?.project_id).toBe(f.project.id)
    })
    it('uses real admission, durable FIFO and project caps, with accepted queue ownership surviving turn disposal', async () => {
      const f = await fixture(kind),
        a = f.task('Occupant'),
        b = f.task('Waiting first'),
        c = f.task('Waiting second')
      const first = f.begin({ selectedTaskId: a.id })
      expect((await first.finalTranscript('start this')).status).toBe('executed')
      await expect.poll(() => f.adapter.sendPrompt.mock.calls.length, { timeout: 5000 }).toBe(1)
      const second = f.begin({ selectedTaskId: b.id })
      expect(await second.finalTranscript('start this')).toMatchObject({
        status: 'executed',
        message: 'Task queued through admission.'
      })
      const third = f.begin({ selectedTaskId: c.id })
      expect(await third.finalTranscript('start this')).toMatchObject({
        status: 'executed',
        message: 'Task queued through admission.'
      })
      expect(f.manager.getStartQueue().map((row) => row.taskId)).toEqual([b.id, c.id])
      expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM agent_start_queue WHERE state='queued'").get()).toMatchObject({
        n: 2
      })
      await second.close()
      await third.close()
      await f.manager.stopByTaskId(a.id)
      await expect.poll(() => f.adapter.sendPrompt.mock.calls.length, { timeout: 5000 }).toBe(2)
      expect(f.manager.findSessionByTaskId(b.id)).toBeTruthy()
      expect(f.manager.findSessionByTaskId(c.id)).toBeUndefined()
      const project = f.db.getProject(f.project.id)!
      f.db.updateProject(project.id, {
        settings: { ...project.settings, limits: { paused: true, max_concurrent_agents: 1, daily_session_cap: 1 } }
      })
      await f.manager.stopByTaskId(b.id)
      await f.manager.drainStartQueue()
      expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
      expect(f.manager.getStartQueue().find((row) => row.taskId === c.id)?.reason).toBe('project_paused')
      f.db.updateProject(project.id, {settings:{...project.settings,limits:{paused:false,max_concurrent_agents:1,daily_session_cap:1}}})
      await f.manager.drainStartQueue()
      expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
      expect(f.manager.getStartQueue().find((row) => row.taskId === c.id)?.reason).toBe('project_daily_cap')
      f.db.updateProject(project.id, {settings:{...project.settings,limits:{paused:false,max_concurrent_agents:1,daily_session_cap:10}}})
      await f.manager.drainStartQueue()
      await expect.poll(()=>f.adapter.sendPrompt.mock.calls.length,{timeout:5000}).toBe(3)
      expect(f.manager.findSessionByTaskId(c.id)).toBeTruthy()
    })
    it('requires visual confirmation, exact epoch and one consumption; dismiss/expiry/spoken yes cannot execute', async () => {
      const f = await fixture(kind),
        turn = f.begin()
      expect((await turn.finalTranscript('create a task to await confirmation')).status).toBe('needs_confirmation')
      expect(await turn.confirm({ ...pair(turn), turnEpoch: 'foreign' })).toMatchObject({ success: false })
      expect((await turn.finalTranscript('yes')).status).toBe('rejected')
      expect(f.db.getTasks()).toEqual([])
      expect(await turn.dismiss(pair(turn))).toEqual({ success: true })
      expect(await turn.confirm(pair(turn))).toMatchObject({ success: false })
      const expires = f.begin({ ttlMs: 30 })
      await expires.finalTranscript('create a task to expire')
      await new Promise((resolve) => setTimeout(resolve, 45))
      expect(await expires.confirm(pair(expires))).toMatchObject({ success: false })
      expect(f.db.getTasks()).toEqual([])
    })
    it('bounds live turns and transcript bytes, and atomically consumes dismissal before delayed publication', async () => {
      const f=await fixture(kind)
      const live=Array.from({length:16},()=>f.begin())
      expect(()=>f.begin()).toThrow()
      await Promise.all(live.map(turn=>turn.close()))
      const tooLarge=f.begin()
      expect((await tooLarge.finalTranscript('x'.repeat(65537))).status).toBe('rejected')
      expect(f.db.getTasks()).toHaveLength(0)
      let release!:()=>void, publications=0
      const held=new Promise<void>(resolve=>{release=resolve});releases.push(release)
      const turn=f.begin({async publish(event){if(event.type==='outcome' && event.outcome.status==='cancelled'){publications++;await held}}})
      await turn.finalTranscript('create a task to dismiss once')
      const first=turn.dismiss(pair(turn))
      expect(await turn.dismiss(pair(turn))).toEqual({success:false})
      release()
      expect(await first).toEqual({success:true})
      expect(publications).toBe(1)
      expect(f.db.getTasks()).toHaveLength(0)
    })
    it('uses the existing message delivery owner and reads the captured task transcript without starting a second writer', async () => {
      const f = await fixture(kind), task = f.task('Message owner')
      await f.begin({ selectedTaskId: task.id }).finalTranscript('start this')
      await expect.poll(() => f.adapter.sendPrompt.mock.calls.length).toBe(1)
      const reply = f.begin({ selectedTaskId: task.id })
      expect(await reply.finalTranscript('tell the agent keep the current scope')).toMatchObject({ status: 'executed', intent: 'reply_to_agent' })
      expect((await reply.finalTranscript('tell the agent replay')).status).toBe('rejected')
      expect(f.adapter.sendPrompt).toHaveBeenCalledTimes(2)
      f.db.upsertTranscriptParts(task.id, [{ id: 'voice-answer', role: 'assistant', content: 'Synthetic saved answer', partType: 'text' }])
      expect(await f.begin({ selectedTaskId: task.id }).finalTranscript('read the last answer')).toMatchObject({ status: 'executed', message: 'Synthetic saved answer' })
    })
    it('requires separate offered task and agent choices and rechecks revoked write grants', async () => {
      const f = await fixture(kind), a=f.task('Scope first'), b=f.task('Scope second')
      const agentA=f.db.createAgent({ name:'Worker one', config:{coding_agent:'pi'} })!, agentB=f.db.createAgent({ name:'Worker two', config:{coding_agent:'pi'} })!
      const turn=f.begin()
      expect((await turn.finalTranscript('assign task Scope to Worker')).status).toBe('needs_confirmation')
      const taskChoice=await turn.confirm(pair(turn),{taskId:b.id})
      expect(taskChoice).toMatchObject({success:false,outcome:{status:'needs_confirmation',reason:'ambiguous_agent'}})
      expect(taskChoice.outcome.status==='needs_confirmation' && taskChoice.outcome.candidates?.map(item=>item.id).sort()).toEqual([agentA.id,agentB.id].sort())
      expect(await turn.confirm(pair(turn),{agentName:agentB.name})).toMatchObject({success:true})
      expect(f.db.getTask(b.id)?.agent_id).toBe(agentB.id)
      expect(f.db.getTask(a.id)?.agent_id).not.toBe(agentB.id)
      const denied=f.begin()
      await denied.finalTranscript('create a task to refuse revoked grants')
      f.denyWrites()
      expect(await denied.confirm(pair(denied))).toMatchObject({success:false})
      expect(f.db.getTasks()).toHaveLength(2)
    })
    it('fences a delayed navigation publication and joins its raw recipient without retargeting', async () => {
      const f=await fixture(kind),task=f.task('Captured navigation')
      let release!:()=>void, entered=false
      const held=new Promise<void>(resolve=>{release=resolve});releases.push(release)
      const delivered:NativeVoiceEvent[]=[]
      const turn=f.begin({selectedTaskId:task.id,async publish(event,beforePublish){entered=true;await held;beforePublish();delivered.push(event)}})
      const pending=turn.finalTranscript('open canvas for this')
      await vi.waitFor(()=>expect(entered).toBe(true))
      const joining=turn.close()
      let joined=false;void joining.then(()=>{joined=true})
      await Promise.resolve()
      expect(joined).toBe(false)
      release()
      expect((await pending).status).toBe('rejected')
      await joining
      expect(delivered).toEqual([])
    })
    it('records raw focused-write ownership before a synchronous reentrant turn close', async () => {
      const f = await fixture(kind)
      let release!: () => void
      let entered = false, joined = false, wrote = false
      let joining!: Promise<void>
      const held = new Promise<void>((resolve) => { release = resolve })
      releases.push(release)
      const turn = f.begin({ mode: 'dictation', dictation: {
        assertCurrent() {},
        async write(_text, beforeWrite) {
          entered = true
          joining = turn.close()
          void joining.then(() => { joined = true })
          await held
          beforeWrite()
          wrote = true
        }
      } })
      const pending = turn.finalTranscript('Literal owned write')
      await vi.waitFor(() => expect(entered).toBe(true))
      await Promise.resolve()
      expect(joined).toBe(false)
      release()
      expect((await pending).status).toBe('rejected')
      await joining
      expect(wrote).toBe(false)
    })
    it('retains a held focused write after cancellation and refuses new work until acknowledged cleanup', async () => {
      const f=await fixture(kind)
      let release!:()=>void, entered=false, wrote=false
      const held=new Promise<void>(resolve=>{release=resolve});releases.push(release)
      const turn=f.begin({mode:'conversation',dictation:{assertCurrent(){}, async write(_text,beforeWrite){entered=true;await held;beforeWrite();wrote=true}}})
      const pending=turn.finalTranscript('start this is literal conversation text')
      await vi.waitFor(()=>expect(entered).toBe(true))
      await expect(f.actions.close(15)).rejects.toThrow('VOICE_ACTION_DRAIN_BLOCKED')
      expect(()=>f.begin()).toThrow()
      expect(wrote).toBe(false)
      release()
      expect((await pending).status).toBe('rejected')
      await f.actions.close()
      expect(wrote).toBe(false)
    })
    it('keeps dictation literal and navigation tied to the captured project/task and focused recipient', async () => {
      const f = await fixture(kind),
        task = f.task('Dictation target'),
        written: string[] = []
      let current = true
      const dictate = f.begin({
        mode: 'dictation',
        selectedTaskId: task.id,
        dictation: {
          assertCurrent() {
            if (!current) throw new Error('stale field')
          },
          async write(text, beforeWrite) {
            await Promise.resolve()
            beforeWrite()
            written.push(text)
          }
        }
      })
      expect(await dictate.finalTranscript('start this')).toMatchObject({ status: 'dictation', text: 'start this' })
      expect(written).toEqual(['start this'])
      expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
      const nav = f.begin({ selectedTaskId: task.id })
      expect((await nav.finalTranscript('open canvas for this')).status).toBe('executed')
      expect(f.voiceEvents.find((event) => event.type === 'navigate')).toMatchObject({
        turnId: nav.turnId,
        turnEpoch: nav.turnEpoch,
        destination: 'canvas',
        taskId: task.id
      })
      current = false
      const stale = f.begin({
        mode: 'dictation',
        dictation: {
          assertCurrent() {
            if (!current) throw new Error('replaced')
          },
          write: () => {
            throw new Error('Must not write')
          }
        }
      })
      expect((await stale.finalTranscript('create task malicious')).status).toBe('rejected')
      expect(written).toHaveLength(1)
    })
    it('rechecks Source intent and grants during real manager asynchronous startup and retains raw ownership through cancellation', async () => {
      const f = await fixture(kind),
        task = f.task('Withdraw while health pending')
      let allowed = true,
        release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      f.adapter.checkHealth.mockImplementation(async () => {
        await held
        return { available: true }
      })
      const turn = f.begin({
        selectedTaskId: task.id,
        beforeEffect() {
          if (!allowed) throw new Error('Withdrawn private canary')
        }
      })
      releases.push(release)
    const pending = turn.finalTranscript('start this')
      await vi.waitFor(() => expect(f.adapter.checkHealth).toHaveBeenCalled())
      allowed = false
      const joining = turn.close()
      let done = false
      void joining.then(() => {
        done = true
      })
      await Promise.resolve()
      expect(done).toBe(false)
      release()
      expect((await pending).status).toBe('rejected')
      await joining
      expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
      expect(f.adapter.createSession).not.toHaveBeenCalled()
      expect(JSON.stringify(f.voiceEvents)).not.toContain('canary')
    })
    it.each([false, true])('keeps exact live HITL scope with acknowledged abort=%s and refuses stale retargeting', async (acknowledgedAbort) => {
      const f = await fixture(kind),
        cli = join(f.root, 'controlled-pi.cjs'),
        receipt = join(f.root, 'pi-receipt.json')
      const node =
        process.env.TAURI_NODE_RUNTIME ??
        (!process.versions.electron ? process.execPath : join(process.cwd(), 'src-tauri/resources/node/node'))
      writeFileSync(
        cli,
        `#!${node}\n` + readFileSync(join(process.cwd(), 'test/fixtures/agent-rpc-process.cjs'), 'utf8').replace(
          "} else if (request.id) reply(request)",
          acknowledgedAbort ? "} else if (request.type === 'abort') { out({ type: 'agent_settled' }); reply(request) } else if (request.id) reply(request)" : "} else if (request.id) reply(request)"
        ),
        { mode: 0o700 }
      )
      const empty = join(f.root, 'empty-path')
      mkdirSync(empty)
      vi.stubEnv('HOME', f.root)
      vi.stubEnv('PATH', empty)
      vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
      vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1')
      vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', 'pi')
      vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receipt)
      const adapter = new PiAdapter()
      Object.assign(adapter, { piExecutablePath: cli })
      f.useAdapter(adapter)
      cleanups.push(() => adapter.closeOwnedSessions())
      const task = f.task('Exact scoped approval'),
        start = f.begin({ selectedTaskId: task.id })
      await start.finalTranscript('start this')
      await expect
        .poll(
          async () => {
            const found = f.manager.findSessionByTaskId(task.id)
            return (
              found && (await f.manager.getSessionRequestScope(found.sessionId, 'native-permission-211', 'permission'))
            )
          },
          { timeout: 5000 }
        )
        .toBeTruthy()
      const receiptData = JSON.parse(readFileSync(receipt, 'utf8'))
      expect(receiptData).toMatchObject({runtime:process.execPath,electron:!!process.versions.electron,path:empty,promptCount:1})
      const session = f.manager.findSessionByTaskId(task.id)!.sessionId
      const approval = {
        taskId: task.id,
        sessionId: session,
        requestId: 'native-permission-211',
        responseType: 'permission' as const
      }
      const accept = f.begin({ selectedTaskId: task.id, approval })
      expect(await accept.finalTranscript('approve')).toMatchObject({
        status: 'needs_confirmation',
        reason: 'destructive'
      })
      expect(await accept.confirm({ ...pair(accept), turnId: 'foreign' })).toMatchObject({ success: false })
      expect(await accept.confirm(pair(accept))).toMatchObject({ success: true })
      await expect
        .poll(() => f.manager.getSessionRequestScope(session, 'native-question-211', 'question'), { timeout: 5000 })
        .toBeTruthy()
      const stale = f.begin({ selectedTaskId: task.id, approval })
      expect(await stale.finalTranscript('reject')).toMatchObject({ status: 'rejected', reason: 'no_pending_approval' })
      const deny = f.begin({
        selectedTaskId: task.id,
        approval: { ...approval, requestId: 'native-question-211', responseType: 'question' }
      })
      expect((await deny.finalTranscript('deny')).status).toBe('needs_confirmation')
      expect(await deny.confirm(pair(deny))).toMatchObject(acknowledgedAbort
        ? { success: true, outcome: { status: 'executed', intent: 'reject_checkpoint' } }
        : { success: false, outcome: { status: 'rejected', reason: 'failed' } })
      if (!acknowledgedAbort) expect((await adapter.getStatus(session, { agentId: task.agent_id!, taskId: task.id, workspaceDir: f.root })).type).toBe('busy')
      expect(await deny.confirm(pair(deny))).toMatchObject({ success: false })
      await f.manager.stopByTaskId(task.id)
      expect(() => process.kill(receiptData.pid, 0)).toThrow()
    })
  })
