import { isUiLeaseId } from '@shared/ui-desktop-codecs'
import {
  SERVICE_ERROR_MESSAGES, ServiceProtocolError, hasExactKeys, isRecord, type ServiceErrorCode
} from '@shared/service-protocol'
import type { DesktopTransport } from './desktop-client'

/** Narrow surface available through Tauri's withGlobalTauri configuration. */
export interface TauriDesktopApi {
  core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  event: { listen: <T>(event: string, callback: (event: { payload: T }) => void,
    options: { target: { kind: 'WebviewWindow'; label: 'main' } }) => Promise<() => void> }
}

const bootstrapGenerations = new WeakMap<TauriDesktopApi, number>()
const uiDocuments = new WeakMap<TauriDesktopApi, Readonly<{ engineEpoch: string; leaseId: string }>>()
const documentNotices = new Set(['agent:incompatible-session', 'task:checkpointAnswered', 'task:source-action-failed'])
export function getTauriUiDocument(native: TauriDesktopApi): Readonly<{ engineEpoch: string; leaseId: string }> | undefined { return uiDocuments.get(native) }

/** Fixed product wording only; native diagnostics, paths and credentials are
 * never part of the renderer's bootstrap failure. */
export class NativeBootstrapUnavailableError extends ServiceProtocolError {
  constructor(readonly explanation: string) { super('DISCONNECTED'); this.name = 'NativeBootstrapUnavailableError' }
}
export function productionBootstrapMessage(value: unknown): string | null {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.production !== true || value.available !== false || !isRecord(value.startupFailure)) return null
  const { code, phase } = value.startupFailure
  if (typeof code !== 'string' || typeof phase !== 'string') return null
  if (code === 'PRODUCTION_CONTAINMENT_UNAVAILABLE') {
    if (['production-windows-job-create', 'production-windows-job-limits', 'production-windows-attributes', 'production-windows-atomic-job-launch',
      'production-windows-private-pipe', 'production-windows-private-pipe-owner', 'production-windows-private-stderr', 'production-windows-argument',
      'production-windows-owned-process', 'production-windows-owned-thread', 'production-windows-job-readiness', 'production-windows-job-observation',
      'production-windows-process-observation', 'production-windows-job-drain', 'production-windows-job-stop'].includes(phase)) return 'Windows process supervision is unavailable. Check the native environment and relaunch the app. Changes are paused.'
    if (phase === 'production-windows-private-fd3-unavailable') return 'This preview cannot supervise desktop processes on Windows yet. Changes are paused.'
    if (phase === 'production-detached-descendant-containment-unavailable') return 'This preview cannot supervise desktop processes on this platform yet. Changes are paused.'
    if (['production-delegation-missing', 'production-delegated-cgroup-v2', 'production-owned-receipts', 'production-prepare-not-acknowledged'].includes(phase)) return 'Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.'
  }
  if (['DISCONNECTED', 'TIMEOUT'].includes(code) && phase === 'production-private-bootstrap-write') return 'The private desktop service channel could not be established. Relaunch the app. Changes are paused.'
  if (code === 'PRODUCTION_GUARDIAN_UNAVAILABLE' && phase === 'production-private-guardian-receipt') return 'Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.'
  if (['INVALID_ARGUMENTS', 'INVALID_RESULT', 'DISCONNECTED', 'FRAME_TOO_LARGE'].includes(code) && ['production-resources', 'production-resource-root', 'production-resource-files', 'production-resource-links', 'production-resource-containment', 'production-resource-verification', 'production-resource-entries', 'production-resource-closure', 'production-resource-signature', 'production-resource-bytes', 'production-manifest', 'production-manifest-digest', 'production-manifest-build-digest', 'production-manifest-build-identity'].includes(phase)) return 'Required desktop resources could not be verified. Provision the preview and relaunch the app. Changes are paused.'
  if (['PROFILE_IN_USE', 'PROFILE_DUPLICATE_OWNER'].includes(code) && phase === 'profile-lock') return 'Another desktop service owns this profile. Close that service before relaunching. Changes are paused.'
  if (code === 'PROFILE_DATABASE_LOCKED' && ['database', 'database-preflight'].includes(phase)) return 'The profile database is busy. Close the other application using this copied profile, then relaunch. Changes are paused.'
  if (code === 'PROFILE_LOW_DISK' && ['profile-lock', 'resources', 'database-preflight', 'database', 'secret-broker', 'task-api', 'services', 'recovery', 'background'].includes(phase)) return 'The profile has insufficient free disk space. Free space on its drive, then relaunch. Existing data is preserved. Changes are paused.'
  if (['RESOURCE_UNAVAILABLE', 'MANAGED_MCP_RESOURCE_UNAVAILABLE', 'CONNECTOR_RESOURCES_REQUIRED'].includes(code) && ['resources', 'services'].includes(phase)) return 'Required desktop resources are missing. Repair the preview installation, then relaunch. Changes are paused.'
  if (code === 'AGENT_CLI_UNAVAILABLE' && ['native-readiness', 'services', 'recovery'].includes(phase)) return 'A required agent CLI is unavailable. Install or repair the configured CLI, then relaunch. Changes are paused.'
  if (['PROFILE_LOCK_INVALID', 'PROFILE_LOCK_LOST'].includes(code) && phase === 'profile-lock') return 'The profile ownership lock could not be verified. Check the copied profile location and permissions, then relaunch. Changes are paused.'
  if (['PROFILE_DATABASE_PATH_INVALID', 'PROFILE_DATABASE_CORRUPT', 'PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE', 'PROFILE_CREDENTIAL_OR_DATABASE_INVALID'].includes(code) && ['database-preflight', 'database'].includes(phase)) return 'The preview profile could not be opened safely. Check its provisioning before relaunching. Changes are paused.'
  if (code === 'SECRET_STORE_UNAVAILABLE' && phase === 'credentials') return 'The protected credential store is unavailable. Provision the native credential store and relaunch the app. Changes are paused.'
  if (['OWNER_DRAIN_BLOCKED', 'OWNER_FENCE_FAILED'].includes(code) && ['new', 'profile-lock', 'resources', 'native-readiness', 'credentials', 'database-preflight', 'database', 'secret-broker', 'task-api', 'services', 'recovery', 'background', 'ready', 'released'].includes(phase)) return 'Desktop cleanup has not completed. Keep this instance open while its owned work stops. Changes are paused.'
  return null
}

export function createTauriDesktopTransport(native: TauriDesktopApi): DesktopTransport {
  return {
    async invoke(operation, payload, { engineEpoch, signal }) {
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      try {
        // Paths, native identity and caller authority never originate in renderer arguments.
        const document = uiDocuments.get(native)
        const requiresDocument = operation === 'app:setTitleBarOverlay' || operation === 'ui:publishState' || operation === 'agent-installer:install' || operation === 'attachments:readImage' || operation === 'attachments:pick' || operation === 'attachments:save' || operation === 'attachments:open' || operation === 'attachments:download' || operation === 'artifacts:copyFile' || operation === 'chatImages:readClipboard' || operation === 'notifications:show' || operation === 'app:getNotificationPermission' || operation === 'app:requestNotificationPermission' || operation === 'app:getMinimizeToTray' || operation === 'app:setMinimizeToTray'
        if (requiresDocument && (!document || document.engineEpoch !== engineEpoch)) throw new ServiceProtocolError('DISCONNECTED')
        const result = await native.core.invoke('desktop_invoke', { operation, payload, engineEpoch,
          ...(requiresDocument ? { uiLease: document!.leaseId } : {}) })
        if (requiresDocument && uiDocuments.get(native) !== document) throw new ServiceProtocolError('STALE_EPOCH')
        return result
      } catch (error) { throw nativeError(error) }
    },
    async listen(receive) {
      try {
        const document = uiDocuments.get(native)
        return await native.event.listen<unknown>('desktop:event', event => {
          const value = event.payload
          if (isRecord(value) && isRecord(value.event) && documentNotices.has(String(value.event.operation))) {
            // Reject ungranted/retired document receipts before DesktopClient
            // sees the sequence. Invalid current envelopes retain its normal
            // fatal validation policy; only the exact native wrapper unwraps.
            if (!document || uiDocuments.get(native) !== document || value.engineEpoch !== document.engineEpoch || value.leaseId !== document.leaseId) return
            if (!hasExactKeys(value, ['engineEpoch', 'leaseId', 'event']) || value.event.engineEpoch !== document.engineEpoch) { receive(value); return }
            receive(value.event)
            return
          }
          // These exact notices require a native document stamp. Other generic
          // service events keep their existing transport semantics.
          if (isRecord(value) && documentNotices.has(String(value.operation))) return
          receive(value)
        },
          { target: { kind: 'WebviewWindow', label: 'main' } })
      } catch (error) { throw nativeError(error) }
    }
  }
}

/** Bootstrap metadata is read from the native-owned engine, before installing the client listener. */
export async function getTauriEngineEpoch(native: TauriDesktopApi): Promise<string> {
  const generation = (bootstrapGenerations.get(native) ?? 0) + 1
  bootstrapGenerations.set(native, generation)
  uiDocuments.delete(native)
  let status: unknown
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      status = await native.core.invoke('engine_status')
      if (!isRecord(status) || status.available !== true || status.uiSupported !== true || isUiLeaseId(status.uiLeaseId)) break
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
  }
  catch (error) { throw nativeError(error) }
  if (bootstrapGenerations.get(native) !== generation) throw new ServiceProtocolError('STALE_EPOCH')
  const failure = productionBootstrapMessage(status)
  if (failure) throw new NativeBootstrapUnavailableError(failure)
  if (!isRecord(status) || status.available !== true || status.protocolVersion !== 1 ||
    typeof status.engineEpoch !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(status.engineEpoch)) {
    throw new ServiceProtocolError('DISCONNECTED')
  }
  if (isUiLeaseId(status.uiLeaseId)) uiDocuments.set(native, Object.freeze({ engineEpoch: status.engineEpoch, leaseId: status.uiLeaseId }))
  return status.engineEpoch
}

function nativeError(error: unknown): ServiceProtocolError {
  if (error instanceof ServiceProtocolError) return error
  const code = isRecord(error) && typeof error.code === 'string' && Object.hasOwn(SERVICE_ERROR_MESSAGES, error.code)
    ? error.code as ServiceErrorCode : 'DISCONNECTED'
  return new ServiceProtocolError(code)
}
