import { randomBytes, randomUUID } from 'node:crypto'
import { fstatSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireProfileLock, PROFILE_LOCK_FILE, type ProfileLock } from '../main/platform/profile-lock'
import { configureSecretStorage } from '../main/platform/secret-storage'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { DatabaseBackend, isFixtureTranscriptInput } from './database-backend'
import { AgentManager } from '../main/agent-manager-core'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { DeterministicAgentAdapter } from './fixtures/deterministic-agent-adapter'
import { AgentBackend } from './agent-backend'
import { AGENT_COMMAND_CODECS, AGENT_EVENT_CODECS } from '../shared/agent-desktop-codecs'
import { ServicePeer, type OperationSchema } from './transport/peer'
import {
  hasExactKeys, isBootstrapResult, isInitializePayload, isJsonValue, isRecord, ServiceProtocolError,
  SERVICE_PROTOCOL_VERSION
} from '../shared/service-protocol'
import { DATABASE_COMMAND_CODECS, DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'

const MARKER = '.21x-synthetic-database.json'
const fail = (): never => { throw new ServiceProtocolError('INVALID_ARGUMENTS') }

function canonicalSyntheticRoot(value: string | undefined): string {
  if (!value || !isAbsolute(value)) return fail()
  const root = realpathSync.native(value)
  const temp = realpathSync.native(tmpdir())
  const within = relative(temp, root)
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || !basename(root).startsWith('21x-database-service-')) return fail()
  return root
}
function marker(profileRoot: string): boolean {
  const path = join(profileRoot, MARKER)
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 1024) return fail()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || !hasExactKeys(value, ['kind', 'version']) || value.kind !== 'synthetic-database' || value.version !== 1) return fail()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A missing marker never adopts an existing database/profile. Only a fresh
    // dedicated directory and the held lock's own files may precede first init.
    if (readdirSync(profileRoot).some(name => ![PROFILE_LOCK_FILE, PROFILE_LOCK_FILE + '-journal'].includes(name))) return fail()
    return false
  }
}

/** Actual private NDJSON service, gated to disposable synthetic profiles. */
export function startDatabaseStdio(): void {
  if (process.versions.electron || process.env.TWENTYONEX_DATABASE_MODE !== 'synthetic-only') return fail()
  if (![0, 1].every(fd => { const file = fstatSync(fd); return file.isFIFO() || file.isSocket() })) return fail()
  const agentMode = process.env.TWENTYONEX_AGENT_MODE === 'deterministic-fixture'
  if (process.env.TWENTYONEX_AGENT_MODE !== undefined && !agentMode) return fail()
  const profileRoot = canonicalSyntheticRoot(process.env.TWENTYONEX_PROFILE_ROOT)
  const configuredResource = process.env.TWENTYONEX_RESOURCE_ROOT
  if (!configuredResource || !isAbsolute(configuredResource)) return fail()
  const resourceRoot = realpathSync.native(configuredResource)
  const engineEpoch = randomUUID()
  const bootstrapResult = { protocolVersion: SERVICE_PROTOCOL_VERSION, engineEpoch, nodeVersion: process.version }
  const caller = { principal: 'trusted-desktop-main' as const, engineEpoch }
  let lock: ProfileLock | undefined
  let storage: AuthenticatedSecretStorage | undefined
  let backend: DatabaseBackend | undefined
  let agentManager: AgentManager | undefined
  let agentBackend: AgentBackend | undefined
  let initialized = false
  let closing = false
  let cleaned = false
  let sequence = 0

  const cleanup = async (failed = false): Promise<void> => {
    if (cleaned) return
    cleaned = true
    closing = true
    let error = failed
    const forced = setTimeout(() => process.exit(1), 3000)
    forced.unref()
    process.stdin.destroy()
    try {
      await agentManager?.stopAllSessions()
      await agentManager?.stopServer()
    } catch {
      // Startup/teardown ownership is incomplete. Keep SQLite/provider/profile
      // ownership alive until this process exits; no early writer handoff.
      process.exitCode = 1
      process.stdout.end(() => process.exit(1))
      return
    }
    agentBackend?.dispose()
    agentBackend = undefined
    agentManager = undefined
    let databaseClosed = true
    try { backend?.close() } catch { error = true; databaseClosed = !backend?.database.db.open }
    if (databaseClosed) backend = undefined
    try { storage?.dispose() } catch { error = true }
    storage = undefined
    // A failed domain close must never release lifetime ownership while its
    // SQLite connection remains alive. Process exit releases both connections.
    let lockReleased = !lock
    if (databaseClosed) {
      try { lock?.release(); lockReleased = true; lock = undefined } catch { error = true }
    }
    process.exitCode = error ? 1 : 0
    process.stdin.destroy()
    if (databaseClosed && lockReleased) { clearTimeout(forced); process.stdout.end() }
    else {
      process.stdout.end(() => process.exit(1))
      setTimeout(() => process.exit(1), 1000).unref()
    }
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
  }
  const onSignal = (): void => { peer.disconnect(); void cleanup() }
  const operations: Record<string, OperationSchema> = {
    'engine.ping': { validatePayload: value => isRecord(value) && hasExactKeys(value, []), validateResult: isBootstrapResult, handle: () => bootstrapResult },
    'engine.initialize': {
      validatePayload: isInitializePayload,
      validateResult: isBootstrapResult,
      handle: (payload, signal) => {
        if (initialized || closing || signal.aborted || !isRecord(payload) || payload.profileRoot !== profileRoot || payload.resourceRoot !== resourceRoot) return fail()
        try {
          // Windows native supervision attaches the Node process to its job
          // before this first initialize request. This service spawns no children.
          lock = acquireProfileLock(profileRoot)
          const hasMarker = marker(lock.profileRoot)
          if (agentMode && hasMarker) return fail()
          const key = randomBytes(32)
          try { storage = new AuthenticatedSecretStorage(key, 'synthetic-database-service') } finally { key.fill(0) }
          configureSecretStorage(storage)
          backend = new DatabaseBackend({
            engineEpoch, lock,
            runtime: { paths: { profileRoot: lock.profileRoot, workspaceRoot: join(lock.profileRoot, 'workspaces'), attachmentRoot: join(lock.profileRoot, 'attachments') }, managedTaskMcp: { disabled: true } },
            // stdin is the private owned host pipe. Native host must authorize
            // WebView label/origin/frame before forwarding any renderer request.
            isTrustedDesktop: value => value.principal === 'trusted-desktop-main' && value.engineEpoch === engineEpoch,
            canAccessProject: () => true, canCreateProject: () => true, canEditSettings: () => true,
            canDeleteTask: id => !agentManager?.hasTaskStartOwnership(id),
            emit: (operation, data) => peer.emit(operation, data, ++sequence)
          })
          if (agentMode) {
            const database = backend.database
            const fixtureAgent = database.createAgent({ name: 'Synthetic deterministic agent',
              config: { coding_agent: 'opencode', permission_mode: 'ask', mcp_servers: [], secret_ids: [] } })!
            const fixtureTask = database.createTask({ title: 'Synthetic approval task' })!
            const adapter = new DeterministicAgentAdapter({ fixtureMode: 'synthetic-only', profileRoot: lock.profileRoot })
            const host: AgentManagerHost = {
              renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' },
              secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' },
              createAdapter: type => type === 'opencode' ? adapter : null, isCodexAppServerAdapter: () => false
            }
            agentManager = new AgentManager(database, host)
            agentBackend = new AgentBackend({ fixtureMode: 'synthetic-only', database, manager: agentManager,
              fixtureAdapter: adapter, fixtureAgentId: fixtureAgent.id, fixtureTaskId: fixtureTask.id, engineEpoch,
              assertAvailable: () => { lock?.assertHeld(); if (!lock || !database.db.open) throw new ServiceProtocolError('DISCONNECTED') },
              isTrustedDesktop: value => value.principal === 'trusted-desktop-main' && value.engineEpoch === engineEpoch,
              canAccessProject: projectId => projectId === fixtureTask.project_id,
              emit: (operation, data) => { if (!closing) peer.emit(operation, data, ++sequence) },
              onFatalEvent: () => peer.disconnect()
            })
          }
          if (!hasMarker) writeFileSync(join(lock.profileRoot, MARKER), JSON.stringify({ kind: 'synthetic-database', version: 1 }), { flag: 'wx', mode: 0o600 })
          initialized = true
          return bootstrapResult
        } catch {
          closing = true
          setImmediate(() => { void peer.drain().then(() => { void cleanup(true) }, () => { void cleanup(true) }) })
          throw new ServiceProtocolError('INTERNAL_ERROR')
        }
      }
    },
    'engine.shutdown': {
      validatePayload: value => isRecord(value) && hasExactKeys(value, []),
      validateResult: value => isRecord(value) && hasExactKeys(value, ['stopped']) && value.stopped === true,
      handle: () => {
        if (!initialized || closing) return fail()
        closing = true
        // Wait until the handler's response and all preceding events drain.
        setImmediate(() => { void peer.drain().then(() => { void cleanup() }, () => { void cleanup(true) }) })
        return { stopped: true }
      }
    },
    'fixture.transcriptUpsert': {
      validatePayload: isFixtureTranscriptInput,
      validateResult: value => isRecord(value) && hasExactKeys(value, ['maxRev', 'changedPartIds']) && Number.isSafeInteger(value.maxRev) && (value.maxRev as number) >= 0 && Array.isArray(value.changedPartIds) && value.changedPartIds.every(id => typeof id === 'string'),
      handle: (payload, signal) => {
        if (!backend || !initialized || closing) return fail()
        return backend.fixtureTranscriptUpsert(payload, caller, signal)
      }
    }
  }
  // Register exact shared schemas before initialize, but bind to a backend only
  // after lifetime ownership and its configured provider are ready.
  for (const [operation, codec] of Object.entries(DATABASE_COMMAND_CODECS)) operations[operation] = {
    validatePayload: value => { try { return isJsonValue(value) && codec.validateArguments(codec.decodeArguments(value)) } catch { return false } },
    validateResult: codec.validateWireResult,
    handle: (payload, signal) => {
      if (!backend || !initialized || closing) return fail()
      return backend.registry.invoke(operation, payload, caller, signal)
    }
  }
  if (agentMode) for (const [operation, codec] of Object.entries(AGENT_COMMAND_CODECS)) operations[operation] = {
    validatePayload: value => { try { return isJsonValue(value) && codec.validateArguments(codec.decodeArguments(value)) } catch { return false } },
    validateResult: codec.validateWireResult,
    handle: (payload, signal) => {
      if (!agentBackend || !initialized || closing) return fail()
      return agentBackend.registry.invoke(operation, payload, caller, signal)
    }
  }
  const eventCodecs = { ...DATABASE_EVENT_CODECS, ...(agentMode ? AGENT_EVENT_CODECS : {}) }
  const peer = new ServicePeer({
    role: 'service', engineEpoch, operations,
    eventSchemas: Object.fromEntries(Object.entries(eventCodecs).map(([operation, codec]) => [operation, codec.validatePayload])),
    write: bytes => new Promise((resolve, reject) => {
      if (process.stdout.destroyed) { reject(new ServiceProtocolError('DISCONNECTED')); return }
      process.stdout.write(bytes, error => error ? reject(new ServiceProtocolError('DISCONNECTED')) : resolve())
    }),
    onDisconnect: () => { void cleanup(!closing) }
  })
  process.stdin.on('data', (data: Buffer) => peer.receive(data))
  process.stdin.on('end', () => peer.end())
  process.stdin.on('error', () => peer.disconnect())
  process.stdout.on('error', () => peer.disconnect())
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
}
