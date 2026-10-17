/** Read-only inspection of the existing #202 scope. Registration is deliberately
 * separate from codecs, authority declarations and observed execution. */
import { DESKTOP_OPERATION_MANIFEST } from '../shared/desktop-operations'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, type ProductionDesktopBindings } from './production-desktop-bindings'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { NATIVE_SERVICES_CODECS } from '../shared/native-services-codecs'
import { NATIVE_WINDOW_CODECS } from '../shared/native-window-codecs'
import { NATIVE_CLIPBOARD_CODECS } from '../shared/native-clipboard-codecs'
import { NATIVE_ATTACHMENT_PICK_CODECS } from '../shared/native-attachment-pick-codecs'
import { NATIVE_ATTACHMENT_IMAGE_CODECS } from '../shared/attachment-image-codecs'
import { NATIVE_NOTIFICATION_CODECS } from '../shared/native-notification-codecs'

const nativeCodecs = { ...NATIVE_SERVICES_CODECS, ...NATIVE_WINDOW_CODECS, ...NATIVE_CLIPBOARD_CODECS, ...NATIVE_ATTACHMENT_PICK_CODECS, ...NATIVE_ATTACHMENT_IMAGE_CODECS, ...NATIVE_NOTIFICATION_CODECS }
export interface DomainObservations { commands: Map<string, { attempted: number; succeeded: number }>; events: Map<string, number> }
const owners: Record<string, string> = {
  projectRepo: 'src/service/configuration-backend.ts', projectResource: 'src/service/configuration-backend.ts', skills: 'src/service/configuration-backend.ts',
  agent: 'src/service/agent-configuration-backend.ts', agentConfig: 'src/service/agent-configuration-backend.ts', agentSession: 'src/service/production-agent-backend.ts',
  db: 'src/service/task-lifecycle-backend.ts', tasks: 'src/service/task-lifecycle-backend.ts', task: 'src/service/task-lifecycle-backend.ts',
  settings: 'src/service/production-settings-backend.ts', secrets: 'src/service/production-settings-backend.ts', env: 'src/service/production-settings-backend.ts',
  projectLimits: 'src/service/project-runtime-backend.ts', concurrency: 'src/service/project-runtime-backend.ts',
  taskGroups: 'src/service/task-group-backend.ts', taskSource: 'src/service/task-source-backend.ts', connectors: 'src/service/connector-backend.ts',
  plugin: 'src/service/task-source-plugin-backend.ts', claudePlugin: 'src/service/claude-plugin-backend.ts',
  mcp: 'src/service/mcp-backend.ts', sessionContext: 'src/service/session-context-backend.ts',
  heartbeat: 'src/service/heartbeat-backend.ts', worktree: 'src/service/worktree-runtime-backend.ts', workspace: 'src/service/worktree-runtime-backend.ts',
  terminal: 'src/service/terminal-backend.ts', mobile: 'src/service/mobile-backend.ts',
  voice: 'src/service/voice-management-backend.ts', artifacts: 'src/service/artifact-backend.ts',
  cliMcp: 'src/service/cli-mcp-backend.ts', attachments: 'src/service/task-attachment-backend.ts', chatImages: 'src/service/task-attachment-backend.ts',
  ui: 'src/service/ui-state-backend.ts', commander: 'src/service/commander-backend.ts', chat: 'src/service/commander-backend.ts',
  github: 'src/service/git-provider-backend.ts', gitlab: 'src/service/git-provider-backend.ts', forgejo: 'src/service/git-provider-backend.ts', git: 'src/service/git-provider-backend.ts',
  'agent-installer': 'src/service/agent-installer-backend.ts',
  overdue: 'src/main/overdue-notifier.ts'
}
function sourceOwner(name: string): string {
  if (name === 'project:create' || name === 'project:update') return 'src/service/project-configuration-backend.ts'
  if (['project:get', 'project:getAll', 'project:getDefault'].includes(name)) return 'src/service/database-backend.ts'
  if (['project:archive', 'project:reorder', 'project:changed'].includes(name)) return 'src/service/configuration-backend.ts'
  if (name === 'project:moveTask') return 'src/service/task-lifecycle-backend.ts'
  if (name.startsWith('project:')) return 'src/service/project-runtime-backend.ts'
  if (name === 'app:getMinimizeToTray' || name === 'app:setMinimizeToTray') return 'src/service/tray-preference-backend.ts'
  return owners[name.split(':')[0]] ?? 'No Source owner assigned by this reconciliation'
}
export function reconcileProductionDomains(bindings: ProductionDesktopBindings, caller: DesktopCallerContext, observations: DomainObservations) {
  const schemas = bindings.operationSchemas(caller)
  // Read registration names only; never invoke a retained command, inspect
  // credentials, or treat a declaration as a registered runtime owner.
  const domainRegistrations = new Map<string, string[]>()
  for (const field of Object.getOwnPropertyNames(bindings)) {
    const owner = Reflect.get(bindings, field)
    if (!owner || typeof owner !== 'object') continue
    const registry = Reflect.get(owner, 'registry')
    if (!registry || typeof registry !== 'object') continue
    const commands = Reflect.get(registry, 'commands')
    if (commands instanceof Map) for (const name of commands.keys()) if (typeof name === 'string') domainRegistrations.set(name, [...(domainRegistrations.get(name) ?? []), field])
  }
  const rows = Object.values(DESKTOP_OPERATION_MANIFEST).filter(row => row.disposition === 'retained').map(row => {
    const sourceRegistered = row.kind === 'command' ? typeof schemas[row.name]?.handle === 'function' : bindings.hasOwnerEvent(row.name)
    const sourceCodec = row.kind === 'command' ? Object.hasOwn(PRODUCTION_COMMAND_CODECS, row.name) : Object.hasOwn(PRODUCTION_EVENT_CODECS, row.name)
    const nativeClientCodec = row.kind === 'command' && Object.hasOwn(nativeCodecs, row.name)
    const observed = observations.commands.get(row.name)
    return {
      name: row.name, kind: row.kind,
      declaration: { owner: row.owner, caller: row.caller, destination: row.destination },
      runtimeBinding: {
        sourceRegisteredInThisLaunch: sourceRegistered,
        registeredSourceDomainOwners: row.kind === 'command' ? domainRegistrations.get(row.name) ?? [] : [],
        sourceOwnerCandidate: sourceOwner(row.name),
        native: nativeClientCodec ? 'Native codec exists; OS/document/private dispatch runtime not inspected by this Source fixture' : 'Not assessed by this Source fixture',
        status: sourceRegistered ? 'Source handler/event owner registered; capability and domain checks still apply' : sourceCodec ? 'Source codec present; optional owner not attached in this launch' : nativeClientCodec ? 'Native-only client codec; no ordinary Source registration' : 'No Source codec or registration in this launch'
      },
      codec: { sourceRequestResultOrEvent: sourceCodec, nativeClientRequestResult: nativeClientCodec, nativeValidator: 'See production_contracts.rs and native domain modules; presence is not platform proof' },
      authorization: {
        caller: row.caller,
        policy: sourceRegistered ? 'Host-captured epoch/principal plus current domain grants, references and owner lifetime; inspect named owner for task/project/session/path-specific checks' : 'No grant inferred from declaration or codec',
        nativeDocument: 'Physical document/OS capability checks are independent of Source registration',
        validation: 'This column describes required checks; it does not assert an individual negative control passed'
      },
      proof: {
        successfulSyntheticPrivatePeerCalls: row.kind === 'command' ? observed?.succeeded ?? 0 : 0,
        attemptedSyntheticPrivatePeerCalls: row.kind === 'command' ? observed?.attempted ?? 0 : 0,
        observedSyntheticPrivatePeerEvents: row.kind === 'event' ? observations.events.get(row.name) ?? 0 : 0,
        scope: 'project-configuration-backend.test.ts actual ProductionService/owners, synthetic isolated profile and controlled adapters/process; no live providers',
        installedSupportedPlatforms: 'Not run for this revision; repository Actions disabled, awaiting user decision'
      }
    }
  })
  return { schemaVersion: 1, contractScope: '#202 unchanged',
    launch: { voice: 'unsupported', connectors: 'disabled', mobile: 'not configured', nativeUi: 'unsupported', realMicrophone: false, hostedVoice: 'deferred' },
    counts: { retained: rows.length, commands: rows.filter(row => row.kind === 'command').length, events: rows.filter(row => row.kind === 'event').length,
      sourceRegistered: rows.filter(row => row.runtimeBinding.sourceRegisteredInThisLaunch).length, sourceCodecs: rows.filter(row => row.codec.sourceRequestResultOrEvent).length,
      nativeClientCodecs: rows.filter(row => row.codec.nativeClientRequestResult).length }, rows }
}
