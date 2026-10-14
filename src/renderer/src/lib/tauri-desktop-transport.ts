import { isUiLeaseId } from '@shared/ui-desktop-codecs'
import {
  SERVICE_ERROR_MESSAGES, ServiceProtocolError, isRecord, type ServiceErrorCode
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
    if (phase === 'production-windows-private-fd3-unavailable') return 'This preview cannot supervise desktop processes on Windows yet. Changes are paused.'
    if (phase === 'production-detached-descendant-containment-unavailable') return 'This preview cannot supervise desktop processes on this platform yet. Changes are paused.'
    if (['production-delegation-missing', 'production-delegated-cgroup-v2', 'production-owned-receipts', 'production-prepare-not-acknowledged'].includes(phase)) return 'Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.'
  }
  if (code === 'PRODUCTION_GUARDIAN_UNAVAILABLE' && phase === 'production-private-guardian-receipt') return 'Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.'
  if (['INVALID_ARGUMENTS', 'INVALID_RESULT', 'DISCONNECTED', 'FRAME_TOO_LARGE'].includes(code) && ['production-resources', 'production-resource-root', 'production-resource-files', 'production-resource-links', 'production-resource-containment', 'production-resource-verification', 'production-resource-entries', 'production-resource-closure', 'production-resource-signature', 'production-resource-bytes', 'production-manifest', 'production-manifest-digest', 'production-manifest-build-digest', 'production-manifest-build-identity'].includes(phase)) return 'Required desktop resources could not be verified. Provision the preview and relaunch the app. Changes are paused.'
  if (['PROFILE_IN_USE', 'PROFILE_DUPLICATE_OWNER'].includes(code) && phase === 'profile-lock') return 'Another desktop service owns this profile. Close that service before relaunching. Changes are paused.'
  if (['PROFILE_DATABASE_PATH_INVALID', 'PROFILE_DATABASE_CORRUPT', 'PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE', 'PROFILE_CREDENTIAL_OR_DATABASE_INVALID'].includes(code) && ['database-preflight', 'database'].includes(phase)) return 'The preview profile could not be opened safely. Check its provisioning before relaunching. Changes are paused.'
  if (code === 'SECRET_STORE_UNAVAILABLE' && phase === 'credentials') return 'The protected credential store is unavailable. Provision the native credential store and relaunch the app. Changes are paused.'
  return null
}

export function createTauriDesktopTransport(native: TauriDesktopApi): DesktopTransport {
  return {
    async invoke(operation, payload, { engineEpoch, signal }) {
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      try {
        // Paths, native identity and caller authority never originate in renderer arguments.
        const document = uiDocuments.get(native)
        const requiresDocument = operation === 'ui:publishState' || operation === 'agent-installer:install' || operation === 'attachments:open' || operation === 'chatImages:readClipboard'
        if (requiresDocument && (!document || document.engineEpoch !== engineEpoch)) throw new ServiceProtocolError('DISCONNECTED')
        const result = await native.core.invoke('desktop_invoke', { operation, payload, engineEpoch,
          ...(requiresDocument ? { uiLease: document!.leaseId } : {}) })
        if (requiresDocument && uiDocuments.get(native) !== document) throw new ServiceProtocolError('STALE_EPOCH')
        return result
      } catch (error) { throw nativeError(error) }
    },
    async listen(receive) {
      try {
        return await native.event.listen<unknown>('desktop:event', event => receive(event.payload),
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
