import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProductionService, sealProductionServiceHost } from '../src/service/production-service'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from '../src/service/production-desktop-bindings'
import { ServicePeer, type OperationSchema } from '../src/service/transport/peer'
import { encodeServiceFrame } from '../src/service/transport/framing'
import { PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from '../src/shared/production-bootstrap'
import { UI_NATIVE_CALLBACK_SCHEMAS } from '../src/shared/ui-native-callbacks'
import { ATTACHMENT_NATIVE_CALLBACK_SCHEMAS, isPrivateAttachmentDownload, type AttachmentPathReceipt } from '../src/shared/attachment-native-callbacks'
import { TASK_ATTACHMENT_CODECS, TASK_ATTACHMENT_LIMITS } from '../src/shared/task-attachment-codecs'
import { TERMINAL_DESKTOP_LIMITS } from '../src/shared/terminal-desktop-codecs'
import { SERVICE_LIMITS, isBootstrapResult, isRecord, ServiceProtocolError, type JsonValue } from '../src/shared/service-protocol'
import { TRANSCRIPT_PAGE_LIMITS, type TranscriptPage } from '../src/shared/transcript-page'
import { createProjection, applyPartsToProjection } from '../src/shared/transcript/projection'
import { hydrateTranscriptProjection, type TranscriptPageReader } from '../src/renderer/src/lib/transcript-pagination'
import { createNodePty, terminalProcessCwd } from '../src/main/terminal-process'
import type { TerminalProcessHost } from '../src/main/terminal-service-core'
import { TaskAttachmentFileOwner } from '../src/main/task-attachment-file-owner'
import type { FileAttachmentRecord } from '../src/main/database/types'

/** Fixed workload, not a benchmark with caller-controlled unbounded allocations. */
export const PAYLOAD_RECOVERY_FIXTURE = Object.freeze({ version: 1, transcriptParts: 1024, partChars: 4096,
  largeToolChars: 400_000, terminals: 4, terminalLines: 256, terminalLineChars: 1024,
  fragmentBytes: 79, attachmentBytes: TASK_ATTACHMENT_LIMITS.imageBytes, deadlineMs: 15_000 })
export interface ProofCounter { name: string; expected: number; actual: number; comparison: 'equal' | 'atMost' | 'atLeast' }
export function assertProofCounter(counter: ProofCounter): void {
  const { expected, actual, comparison, name } = counter
  if (!Number.isFinite(actual) || (comparison === 'equal' ? actual !== expected : comparison === 'atMost' ? actual > expected : actual < expected)) {
    throw new Error(`PAYLOAD_PROOF ${name}: expected ${comparison} ${expected}, actual ${actual}`)
  }
}
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const tick = (): Promise<void> => new Promise(done => setTimeout(done, 5))
async function until(label: string, ready: () => boolean): Promise<void> {
  const end = Date.now() + PAYLOAD_RECOVERY_FIXTURE.deadlineMs
  while (!ready()) { if (Date.now() > end) throw new Error(`PAYLOAD_PROOF deadline: ${label}`); await tick() }
}
function deferred() { let resolveGate!: () => void; const promise = new Promise<void>(done => { resolveGate = done }); return { promise, release: () => resolveGate() } }

export interface PayloadRecoveryReport {
  version: 1
  scope: string
  fixture: typeof PAYLOAD_RECOVERY_FIXTURE
  provenance: { platform: string; architecture: string; node: string; electron: string | null; webview: null; sources: Record<string, string>; artifacts: Record<string, string> }
  counters: ProofCounter[]
  memory: { startRss: number; peakSampledRss: number; peakSampledHeap: number; note: string }
  epochs: string[]
  cleanup: { ownerClosed: boolean; nativeExits: number; profileRemoved: boolean }
  remaining: string[]
}

/** Runs source ProductionService's actual private peer and singleton owners under
 * pinned staged Node/SQLite/node-pty. The host callback is deliberately controlled;
 * this is not a packaged stdio, native Save dialog or installed WebView proof. */
export async function runProductionPayloadRecoveryProof(): Promise<PayloadRecoveryReport> {
  const pins = JSON.parse(readFileSync(resolve('scripts/tauri-runtime.json'), 'utf8')) as { nodeVersion: string; nativeDependencies: Record<string, string> }
  if (process.versions.electron || process.version !== `v${pins.nodeVersion}` || process.platform !== 'linux' ||
      !process.env.TAURI_NODE_RUNTIME || realpathSync(process.execPath) !== realpathSync(process.env.TAURI_NODE_RUNTIME)) {
    throw new Error('PAYLOAD_PROOF requires pinned staged standalone Node on Linux; use test:tauri --terminal-proofs')
  }
  const artifacts: Record<string, string> = {}
  for (const [name, variable] of [['better-sqlite3', 'TAURI_SQLITE_MODULE'], ['node-pty', 'TAURI_NODE_PTY_MODULE']] as const) {
    const selected = process.env[variable]
    if (!selected || realpathSync(selected) !== realpathSync(resolve('src-tauri/resources/service/node_modules', name))) throw new Error(`PAYLOAD_PROOF missing staged ${name}`)
    const path = join(selected, 'package.json'), bytes = readFileSync(path), metadata = JSON.parse(bytes.toString())
    if (metadata.name !== name || metadata.version !== pins.nativeDependencies[name]) throw new Error(`PAYLOAD_PROOF wrong staged ${name}`)
    artifacts[`${name}/package.json`] = digest(bytes)
    const addon = name === 'node-pty' ? join(selected, 'build/Release/pty.node') : join(selected, 'prebuilds', `${process.platform}-${process.arch}.node`)
    artifacts[`${name}/native-addon`] = digest(readFileSync(addon))
  }
  artifacts.node = digest(readFileSync(process.execPath))
  const sourcePaths = ['scripts/production-payload-recovery-proof.ts', 'scripts/production-payload-recovery-proof.test.ts',
    'src/service/production-service.ts', 'src/service/production-owner.ts', 'src/service/production-desktop-bindings.ts',
    'src/service/transport/peer.ts', 'src/service/transport/framing.ts', 'src/service/task-attachment-backend.ts',
    'src/main/task-attachment-file-owner.ts', 'src/main/terminal-service-core.ts', 'src/main/terminal-process.ts',
    'src/service/terminal-backend.ts', 'src/main/database/manager.ts', 'src/renderer/src/lib/transcript-pagination.ts',
    'src/shared/transcript/projection.ts', 'src/shared/service-protocol.ts', 'src/shared/transcript-page.ts',
    'src/shared/task-attachment-codecs.ts', 'src/shared/terminal-desktop-codecs.ts', 'scripts/tauri-runtime.json']
  const sources = Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(resolve(path)))]))
  const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-payload-recovery-'))), keys = new Map<string, Buffer>()
  mkdirSync(join(root, 'resources'))
  const ptyRoot = realpathSync(process.env.TAURI_NODE_PTY_MODULE!), pty = createRequire(join(ptyRoot, 'package.json'))(ptyRoot) as typeof import('node-pty')
  const sqliteRoot = realpathSync(process.env.TAURI_SQLITE_MODULE!), SQLite = createRequire(join(sqliteRoot, 'package.json'))(sqliteRoot) as typeof import('better-sqlite3')
  const receipts: Array<{ exited: boolean; kills: number }> = []
  let maxRead = 0, maxWrite = 0, fdCount = 0, maxFds = 0, sampleHeap = 0, sampleRss = process.memoryUsage().rss
  let maxQueueBytes = 0, maxQueueFrames = 0, maxPending = 0, fragments = 0, maxFrame = 0, terminalEvents = 0, maxTerminalEvent = 0
  let pageBytes = 0, maxPageParts = 0, snapshotPages = 0, deltaPages = 0, downloaded = 0, heldReply: ReturnType<typeof deferred> | null = null
  let downloadEntered = false, downloadGate: ReturnType<typeof deferred> | null = null, lease: string | null = 'document_payload_1'
  let inspectionOpen = false
  const received = new Map<string, { bytes: number; tail: string; partial: string; rows: number; sequenceErrors: number; markers: Set<string> }>()
  const counters: ProofCounter[] = [], epochs: string[] = []
  const report: PayloadRecoveryReport = { version: 1, scope: 'source-production-private-peer-real-linux-pty-controlled-native-attachment-callback',
    fixture: PAYLOAD_RECOVERY_FIXTURE, provenance: { platform: process.platform, architecture: process.arch, node: process.version, electron: process.versions.electron ?? null, webview: null, sources, artifacts },
    counters, memory: { startRss: sampleRss, peakSampledRss: sampleRss, peakSampledHeap: 0, note: 'Sampled process memory includes Vitest/runtime. Logical page/frame/FD/tail bounds are asserted; RSS is diagnostic, not a constant-memory claim.' },
    epochs, cleanup: { ownerClosed: false, nativeExits: 0, profileRemoved: false }, remaining: [
      'Installed supported OS/architecture/WebView runs, actual native Save dialog/copy, native host process-tree drain and packaged stdio load proof.',
      'Terminal getBuffer is a bounded volatile tail; saturation retires its owner and cannot recover discarded output losslessly.',
      'Audio/binary ServiceStreams foundation has no production Rust consumer; this proof uses existing domain payload paths.',
      '#202 closure dependency remains open; source readiness does not close #207 or pass migration gates.' ] }
  const connection: { service: ProductionService | null; host: ServicePeer | null } = { service: null, host: null }
  let startup = true
  const sample = (): void => {
    const memory = process.memoryUsage(); sampleRss = Math.max(sampleRss, memory.rss); sampleHeap = Math.max(sampleHeap, memory.heapUsed)
    for (const peer of [connection.host, connection.service?.peer]) if (peer) {
      maxQueueBytes = Math.max(maxQueueBytes, peer.queuedByteCount); maxQueueFrames = Math.max(maxQueueFrames, peer.queuedFrameCount); maxPending = Math.max(maxPending, peer.pendingCount)
    }
  }
  const check = (name: string, expected: number, actual: number, comparison: ProofCounter['comparison'] = 'equal'): void => {
    const row = { name, expected, actual, comparison }; counters.push(row); assertProofCounter(row)
  }
  const terminalProcessHost: TerminalProcessHost = { resolveShell: () => '/bin/bash', getCwd: terminalProcessCwd, create(options) {
    const receipt = { exited: false, kills: 0 }; receipts.push(receipt)
    const handle = createNodePty({ ...options, onExit: (pid, code, signal) => { receipt.exited = true; options.onExit(pid, code, signal) } }, {
      spawn: (shell, _args, settings) => pty.spawn(shell, ['--noprofile', '--norc'], { ...settings,
        env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', PS1: '', HISTFILE: '/dev/null' } }) })
    return { ...handle, kill: () => { receipt.kills++; handle.kill() } }
  } }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => {
    maxFrame = Math.max(maxFrame, bytes.length)
    // Include one-byte header/UTF8 splits and larger bounded fragments.
    peer.receive(bytes.subarray(0, 1)); fragments++
    for (let at = 1; at < bytes.length; at += PAYLOAD_RECOVERY_FIXTURE.fragmentBytes) { peer.receive(bytes.subarray(at, at + PAYLOAD_RECOVERY_FIXTURE.fragmentBytes)); fragments++ }
    sample()
  }
  const start = async (load: boolean): Promise<void> => {
    const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: `launch_payload_${load ? '002' : '001'}`, profileId: 'payload-disposable',
      profileIntent: load ? 'load-authenticated-copy' : 'create-new', buildIdentity: 'source-payload-fixture-v1', resourceManifestSha256: 'a'.repeat(64),
      paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
      capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'host', attachmentDownloads: 'host', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
    const trusted = (): boolean => true
    // Finite existing policy keys, scoped to this sealed disposable host. No
    // Proxy/wildcard authority is exposed to renderer arguments.
    const authority: ProductionDesktopBindingOptions['authority'] = {
      isTrustedDesktop: trusted, canAccessTask: trusted, canAccessSource: trusted, canAccessProject: trusted, canAccessAgent: trusted,
      canAccessSession: trusted, canAccessGlobalCommander: trusted, canManageGlobalConfiguration: trusted, canQueryBackend: trusted,
      canCreateProject: trusted, canEditSettings: trusted, canAccessGlobalSkills: trusted, canChangeSkillScope: trusted, canReorderProjects: trusted,
      canReadSetting: trusted, canWriteSetting: trusted, canAccessSecret: trusted, canCreateSecret: trusted, canUseSecretEnvironment: trusted,
      canReadEnvironment: trusted, canAccessTerminal: trusted, canAccessMcpServer: trusted, canAccessCli: trusted, canUseTransport: trusted,
      canUseEnvironmentName: trusted, canAccessConnector: trusted, canUseSourcePlugin: trusted, canCreateInstance: trusted, canUsePiece: trusted,
      canBorrowSourceCredentials: trusted, canResolveUnsavedConfig: trusted, canManageMobile: trusted, canAccessMobileSession: trusted,
      canAccessMarketplace: trusted, canCreateMarketplace: trusted, canAccessPluginName: trusted, canAccessPlugin: trusted,
      canUseMarketplaceSource: trusted, canUsePluginAddress: trusted, canUsePluginSource: trusted, canAccessSkill: trusted,
      canCreateGlobalSkill: trusted, canCreateAgent: trusted, canCreateMcpServer: trusted,
      resolveTerminalDirectory: () => ({ cwd: descriptor.paths.workspaceRoot, root: descriptor.paths.workspaceRoot }) }
    const schemas: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [operation, {
      validatePayload: value => { try { return codec.validateArguments(codec.decodeArguments(value as JsonValue)) } catch { return false } }, validateResult: codec.validateWireResult }]))
    schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
    schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
    schemas['engine.attachment.download'] = { validatePayload: isPrivateAttachmentDownload, validateResult: TASK_ATTACHMENT_CODECS['attachments:download'].validateWireResult }
    schemas['engine.attachment.download.check'] = { validatePayload: isRecord, validateResult: value => isRecord(value) && value.authorized === true }
    schemas['host.production.prepare'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.prepare'], handle: () => ({ launchId: descriptor.launchId, ready: true, processTree: 'supervised' }) }
    schemas['host.production.drain'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.drain'], handle: () => ({ launchId: descriptor.launchId, acknowledged: true }) }
    schemas['host.ui.snapshot'] = { ...UI_NATIVE_CALLBACK_SCHEMAS['host.ui.snapshot'], handle: () => lease ? { available: true, leaseId: lease } : { available: false } }
    schemas['host.attachment.download'] = { ...ATTACHMENT_NATIVE_CALLBACK_SCHEMAS['host.attachment.download'], handle: async payload => {
      const request = payload as unknown as { receipt: AttachmentPathReceipt; leaseId: string; authorizationId: string }
      downloadEntered = true
      await downloadGate?.promise
      if (!lease || request.leaseId !== lease) throw new ServiceProtocolError('STALE_EPOCH')
      await connection.host!.request('engine.attachment.download.check', { authorizationId: request.authorizationId })
      // The real native copier is intentionally not replaced by a JS copier.
      // Receipt validation/authorization is covered; installed copy remains open.
      downloaded++; return {}
    } }
    const currentService = new ProductionService(sealProductionServiceHost({ descriptor, authority,
      caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: () => {},
      boundaries: { cliMcp: { homeDir: root, environment: {} }, terminalProcessHost,
        createAdapter: () => { throw new Error('PAYLOAD_PROOF unexpected provider session') },
        createProvider: () => { throw new Error('PAYLOAD_PROOF unexpected remote provider') },
        taskAttachmentFiles: options => new TaskAttachmentFileOwner({ ...options, fs: { open: async (path, flags, mode) => {
          const fd = await open(path, flags, mode); fdCount++; maxFds = Math.max(maxFds, fdCount)
          return { stat: () => fd.stat({ bigint: true }), sync: () => fd.sync(),
            read: (buffer, offset, length, position) => { maxRead = Math.max(maxRead, length); return fd.read(buffer, offset, length, position) },
            write: (buffer, offset, length, position) => { maxWrite = Math.max(maxWrite, length); return fd.write(buffer, offset, length, position) },
            close: async () => { await fd.close(); fdCount-- } }
        } } }) },
      constructBootstrap: callbacks => ({ profileId: descriptor.profileId, paths: descriptor.paths,
        credentials: { mode: load ? 'load' : 'create', store: { create: async (id, key) => { if (keys.has(id)) throw new Error('duplicate fixture key'); keys.set(id, Buffer.from(key)) }, load: async id => { const key = keys.get(id); if (!key) throw new Error('missing fixture key'); return Buffer.from(key) } } },
        connectors: { kind: 'disabled', reason: 'Synthetic load profile' }, managedTaskMcp: { disabled: true },
        native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
          prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent, ui: callbacks.ui,
          downloadAttachment: callbacks.downloadAttachment, openExternal: callbacks.openExternal, notify: callbacks.notify,
          sendUiCommand: () => ({ ok: false, detail: 'No fixture UI' }) } })
    }), { write: async bytes => {
      if (heldReply && JSON.parse(new TextDecoder().decode(bytes)).kind === 'response') { const gate = heldReply; heldReply = null; await gate.promise }
      deliver(connection.host!, bytes)
    } })
    connection.service = currentService
    connection.host = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
      eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, value => validateProductionEventWire(operation, value)])),
      write: async bytes => deliver(currentService.peer, bytes), onEvent: event => {
        if (event.operation !== 'terminal:data' || !isRecord(event.payload)) return
        const id = String(event.payload.id), data = String(event.payload.data), state = received.get(id) ?? { bytes: 0, tail: '', partial: '', rows: 0, sequenceErrors: 0, markers: new Set<string>() }
        terminalEvents++; maxTerminalEvent = Math.max(maxTerminalEvent, Buffer.byteLength(data)); state.bytes += Buffer.byteLength(data)
        const text = state.tail + data
        const lines = (state.partial + data).split('\n'); state.partial = lines.pop()!.slice(-2048)
        for (const line of lines) {
          const normalized = line.replace(/\r$/, '')
          if (/^PAYLOAD_(?:READY|DONE)_[0-9]+$/.test(normalized)) state.markers.add(normalized)
          if (/^[0-9]+$/.test(normalized) && normalized.length === PAYLOAD_RECOVERY_FIXTURE.terminalLineChars) {
            if (normalized !== String(state.rows).padStart(PAYLOAD_RECOVERY_FIXTURE.terminalLineChars, '0')) state.sequenceErrors++
            state.rows++
          }
        }
        state.tail = text.slice(-2048); received.set(id, state)
      } })
    await connection.host.request('engine.ping', {})
    await connection.host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
    epochs.push(connection.host.engineEpoch!); sample()
  }
  const command = async (operation: keyof typeof PRODUCTION_COMMAND_CODECS, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    const codec = PRODUCTION_COMMAND_CODECS[operation]
    const result = await connection.host!.request(operation, codec.encodeArguments(args as never), { signal })
    return codec.decodeResult((result as { value?: JsonValue }).value)
  }
  try {
    await start(false); startup = false
    const services = connection.service!.getReadyServices()!, task = services.db.createTask({ title: 'Synthetic payload recovery' })!
    for (let offset = 0; offset < PAYLOAD_RECOVERY_FIXTURE.transcriptParts; offset += 32) {
      services.db.upsertTranscriptParts(task.id, Array.from({ length: 32 }, (_, index) => ({ id: `part_${offset + index}`, role: 'assistant', content: '雪'.repeat(PAYLOAD_RECOVERY_FIXTURE.partChars), receivedAt: offset + index + 1 })))
    }
    services.db.upsertTranscriptParts(task.id, [{ id: 'large_tool', role: 'assistant', content: 'Large saved tool', tool: { name: 'read', output: 'x'.repeat(PAYLOAD_RECOVERY_FIXTURE.largeToolChars) } }])
    const projection = createProjection()
    let raced = false
    const read: TranscriptPageReader = async (id, page, options) => {
      const result = await command('agentSession:getTranscriptPage', [id, page], options.signal) as TranscriptPage
      pageBytes = Math.max(pageBytes, Buffer.byteLength(JSON.stringify(result)))
      maxPageParts = Math.max(maxPageParts, result.parts.length)
      if (page.mode === 'snapshot') snapshotPages++; else deltaPages++
      if (!raced) {
        raced = true
        // Update an unread row so it moves beyond the fixed snapshot watermark,
        // and deliver newer then older observations to the actual projection.
        const old = services.db.getTranscriptEventPart(task.id, 'part_900')!.part!
        services.db.upsertTranscriptParts(task.id, [{ id: 'part_900', role: 'assistant', content: 'racing revision' }, { id: 'race_append', role: 'assistant', content: 'racing append' }])
        const current = services.db.getTranscriptEventPart(task.id, 'part_900')!.part!
        applyPartsToProjection(projection, [current, old, current], current.rev)
      }
      sample(); return result
    }
    await hydrateTranscriptProjection(read, task.id, projection)
    check('hydrated unique parts after revision race', PAYLOAD_RECOVERY_FIXTURE.transcriptParts + 2, projection.parts.size)
    check('projection sorted uniqueness', projection.parts.size, new Set(projection.sorted.map(part => part.partId)).size)
    check('newest racing revision retained', 1, Number(projection.parts.get('part_900')?.content === 'racing revision'))
    let mismatches = 0
    for (let index = 0; index < PAYLOAD_RECOVERY_FIXTURE.transcriptParts; index++) {
      const id = `part_${index}`, durable = services.db.getTranscriptEventPart(task.id, id)!.part!, projected = projection.parts.get(id)
      if (!projected || projected.rev !== durable.rev || projected.seq !== durable.seq || projected.content !== durable.content) mismatches++
    }
    check('indexed durable identity/revision/content mismatches', 0, mismatches)
    check('snapshot pages', 2, snapshotPages, 'atLeast'); check('delta pages', 1, deltaPages, 'atLeast')
    check('largest page JSON bytes', TRANSCRIPT_PAGE_LIMITS.bytes, pageBytes, 'atMost')
    check('largest page part count', TRANSCRIPT_PAGE_LIMITS.parts, maxPageParts, 'atMost')
    check('stored full large tool characters', PAYLOAD_RECOVERY_FIXTURE.largeToolChars,
      Number((services.db.db.prepare("SELECT length(json_extract(tool,'$.output')) AS size FROM transcript_parts WHERE task_id=? AND part_id='large_tool'").get(task.id) as { size: number }).size))

    // Mount cancellation after the actual page reply has been produced but
    // before delivery. The late frame cannot populate an unmounted projection.
    const unmount = new AbortController(), retiredProjection = createProjection(), replyGate = deferred(); heldReply = replyGate
    const cancelled = hydrateTranscriptProjection(read, task.id, retiredProjection, { signal: unmount.signal }).then(() => 'resolved', error => (error as ServiceProtocolError).code)
    await until('page reply held', () => heldReply === null); unmount.abort(); replyGate.release()
    check('unmounted hydration cancelled', 1, Number(await cancelled === 'CANCELLED'))
    await tick(); check('late page never applied after unmount', 0, retiredProjection.parts.size)

    const image = Buffer.alloc(PAYLOAD_RECOVERY_FIXTURE.attachmentBytes, 0x5a); Buffer.from([137,80,78,71,13,10,26,10]).copy(image)
    const saved = await command('chatImages:saveToTask', [task.id, [{ name: 'payload.png', mimeType: 'image/png', data: image.toString('base64') }]]) as FileAttachmentRecord[]
    const savedBytes = readFileSync(join(root, 'attachments', task.id, `${saved[0].id}-${saved[0].filename}`))
    check('attachment published exact byte digest', 1, Number(digest(savedBytes) === digest(image)))
    await connection.host!.request('engine.attachment.download', { taskId: task.id, attachmentId: saved[0].id, leaseId: lease! })
    check('authorized native download callbacks', 1, downloaded)
    // Hold the raw callback, cancel its public reply, then retire the document.
    downloadEntered = false; downloadGate = deferred(); const cancel = new AbortController()
    const uncertain = connection.host!.request('engine.attachment.download', { taskId: task.id, attachmentId: saved[0].id, leaseId: lease! }, { signal: cancel.signal }).then(() => 'resolved', error => (error as ServiceProtocolError).code)
    await until('raw native attachment callback entered', () => downloadEntered); cancel.abort(); lease = null; downloadGate.release()
    check('attachment reply cancellation', 1, Number(await uncertain === 'CANCELLED'))
    await until('attachment FD released after late callback', () => fdCount === 0)
    check('retired callback does not accept another download', 1, downloaded)
    check('attachment read syscall bytes', 65536, maxRead, 'atMost'); check('attachment write syscall bytes', 65536, maxWrite, 'atMost')
    check('attachment active descriptors', 1, maxFds, 'atMost')

    // All shells are actual staged node-pty handles. Only shell startup policy
    // differs from production: no profiles, keys, remote provider or history.
    for (let index = 0; index < PAYLOAD_RECOVERY_FIXTURE.terminals; index++) {
      await command('terminal:create', [`payload:${index}`, 120, 30])
      await command('terminal:write', [`payload:${index}`, `stty -echo; printf '\\nPAYLOAD_READY_${index}\\n'\r`])
    }
    await until('parallel PTYs ready', () => Array.from({ length: PAYLOAD_RECOVERY_FIXTURE.terminals }, (_, i) => received.get(`payload:${i}`)?.markers.has(`PAYLOAD_READY_${i}`)).every(Boolean))
    await Promise.all(Array.from({ length: PAYLOAD_RECOVERY_FIXTURE.terminals }, (_, index) => command('terminal:write', [`payload:${index}`,
      `for ((i=0;i<${PAYLOAD_RECOVERY_FIXTURE.terminalLines};i++)); do printf '%0${PAYLOAD_RECOVERY_FIXTURE.terminalLineChars}d\\n' "$i"; done; printf 'PAYLOAD_DONE_${index}\\n'\r`])))
    await until('parallel PTY payload delivery', () => Array.from({ length: PAYLOAD_RECOVERY_FIXTURE.terminals }, (_, i) => received.get(`payload:${i}`)?.markers.has(`PAYLOAD_DONE_${i}`)).every(Boolean))
    for (let index = 0; index < PAYLOAD_RECOVERY_FIXTURE.terminals; index++) {
      const id = `payload:${index}`, before = services.terminals.identity(id)!, attached = await command('terminal:create', [id, 120, 30]) as { pid: number }
      check(`terminal ${index} reconnect keeps native PID`, before.pid, attached.pid)
      const buffer = await command('terminal:getBuffer', [id, 500]) as { lines: string[] }
      check(`terminal ${index} bounded recovery tail`, TERMINAL_DESKTOP_LIMITS.bufferBytes, Buffer.byteLength(JSON.stringify(buffer)), 'atMost')
      check(`terminal ${index} completion in recovery tail`, 1, Number(buffer.lines.join('\n').includes(`PAYLOAD_DONE_${index}`)))
      check(`terminal ${index} minimum delivered bytes`, PAYLOAD_RECOVERY_FIXTURE.terminalLines * PAYLOAD_RECOVERY_FIXTURE.terminalLineChars, received.get(id)!.bytes, 'atLeast')
      check(`terminal ${index} exact sequential payload lines`, PAYLOAD_RECOVERY_FIXTURE.terminalLines, received.get(id)!.rows)
      check(`terminal ${index} duplicate or out-of-order payload lines`, 0, received.get(id)!.sequenceErrors)
    }
    check('parallel native PTY spawns', PAYLOAD_RECOVERY_FIXTURE.terminals, receipts.length)
    check('terminal event byte bound', TERMINAL_DESKTOP_LIMITS.eventBytes, maxTerminalEvent, 'atMost')
    check('terminal event deliveries', PAYLOAD_RECOVERY_FIXTURE.terminals, terminalEvents, 'atLeast')
    // Make one actual durable mutation uncertain at the reply boundary. Neither
    // old peer nor replacement may automatically replay it.
    const mutationGate = deferred(); heldReply = mutationGate
    const mutationAbort = new AbortController()
    const mutation = command('db:createTask', [{ title: 'Uncertain mutation sentinel' }], mutationAbort.signal).then(() => 'resolved', error => (error as ServiceProtocolError).code)
    await until('accepted mutation reply held', () => heldReply === null)
    mutationAbort.abort(); mutationGate.release()
    check('uncertain mutation reply cancelled', 1, Number(await mutation === 'CANCELLED'))
    await connection.service!.close(); connection.host!.disconnect(); await connection.host!.waitForHandlers()
    check('all native PTYs exited before profile reopen', receipts.length, receipts.filter(value => value.exited).length)
    await start(true)
    check('replacement epoch differs', 1, Number(epochs[0] !== epochs[1]))
    const replacement = connection.service!.getReadyServices()!, restored = createProjection()
    await hydrateTranscriptProjection(read, task.id, restored)
    check('durable parts rehydrated after epoch replacement', projection.parts.size, restored.parts.size)
    let restoredMismatches = 0
    for (const [id, previous] of projection.parts) {
      const current = restored.parts.get(id)
      if (!current || current.rev !== previous.rev || current.content !== previous.content || current.seq !== previous.seq) restoredMismatches++
    }
    check('replacement projection identity/revision/content mismatches', 0, restoredMismatches)
    // Stale traffic cannot mutate the replacement owner, even with a fresh ID.
    // Refusal can retire the peer and begin asynchronous owner shutdown. Await
    // that exact drain before inspecting durable effects; never race a query on
    // the live owner connection against onDisconnect's close or add an epoch.
    connection.service!.peer.receive(encodeServiceFrame({ kind: 'request', protocolVersion: 1, engineEpoch: epochs[0], requestId: 'host:999999', operation: 'db:createTask', payload: { data: { title: 'Forbidden stale epoch' } } }))
    await connection.service!.close(); connection.host!.disconnect(); await connection.host!.waitForHandlers()
    check('replacement owner stopped before durable inspection', 1, Number(connection.service!.owner.snapshot().phase === 'stopped'))
    check('replacement writer closed before durable inspection', 0, Number(replacement.db.db.open))
    const durableInspection = new SQLite(join(root, 'profile', '21x.db'), { readonly: true, fileMustExist: true })
    inspectionOpen = true
    try {
      check('uncertain mutation committed exactly once without replay', 1,
        Number((durableInspection.prepare('SELECT COUNT(*) AS count FROM tasks WHERE title=?').get('Uncertain mutation sentinel') as { count: number }).count))
      check('stale epoch mutation effects', 0,
        Number((durableInspection.prepare('SELECT COUNT(*) AS count FROM tasks WHERE title=?').get('Forbidden stale epoch') as { count: number }).count))
    } finally { durableInspection.close(); inspectionOpen = durableInspection.open }
    check('independent read-only inspection handle closed', 0, Number(durableInspection.open))
    check('fragments delivered', 100, fragments, 'atLeast'); check('frame bytes including newline', SERVICE_LIMITS.frameBytes + 1, maxFrame, 'atMost')
    check('peer queued bytes', SERVICE_LIMITS.queuedBytes, maxQueueBytes, 'atMost'); check('peer queued frames', SERVICE_LIMITS.queuedFrames, maxQueueFrames, 'atMost')
    check('peer pending calls', SERVICE_LIMITS.pendingRequests, maxPending, 'atMost')
  } catch (error) {
    const reason = error instanceof ServiceProtocolError ? error.code : error instanceof Error && error.message.startsWith('PAYLOAD_PROOF') ? error.message : 'unexpected owner failure'
    console.error(`PRODUCTION_PAYLOAD_RECOVERY_FAILURE ${JSON.stringify({ phase: startup ? 'startup' : 'workload', reason, provenance: report.provenance, counters })}`)
    throw new Error(`PAYLOAD_PROOF ${startup ? 'startup' : 'workload'} failed: ${reason}; inspect source hashes and last counter (no live profile was used)`, { cause: error })
  } finally {
    heldReply?.release(); downloadGate?.release()
    // A failed close deliberately retains the disposable profile for repair.
    // Never remove it while an actual owner/FD/native process still exists.
    await connection.service?.close(); connection.host?.disconnect(); await connection.host?.waitForHandlers()
    report.cleanup.ownerClosed = true; report.cleanup.nativeExits = receipts.filter(value => value.exited).length
    if (receipts.some(value => !value.exited) || fdCount !== 0 || inspectionOpen) throw new Error('PAYLOAD_PROOF cleanup incomplete; disposable profile retained')
    rmSync(root, { recursive: true, force: true }); report.cleanup.profileRemoved = !existsSync(root)
    for (const key of keys.values()) key.fill(0); keys.clear()
    report.memory.peakSampledRss = sampleRss; report.memory.peakSampledHeap = sampleHeap
  }
  return report
}
