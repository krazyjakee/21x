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

export function createTauriDesktopTransport(native: TauriDesktopApi): DesktopTransport {
  return {
    async invoke(operation, payload, { engineEpoch, signal }) {
      if (signal.aborted) throw new ServiceProtocolError('CANCELLED')
      try {
        // Paths, native identity and caller authority never originate in renderer arguments.
        return await native.core.invoke('desktop_invoke', { operation, payload, engineEpoch })
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
  let status: unknown
  try { status = await native.core.invoke('engine_status') }
  catch (error) { throw nativeError(error) }
  if (!isRecord(status) || status.available !== true || status.protocolVersion !== 1 ||
    typeof status.engineEpoch !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(status.engineEpoch)) {
    throw new ServiceProtocolError('DISCONNECTED')
  }
  return status.engineEpoch
}

function nativeError(error: unknown): ServiceProtocolError {
  const code = isRecord(error) && typeof error.code === 'string' && Object.hasOwn(SERVICE_ERROR_MESSAGES, error.code)
    ? error.code as ServiceErrorCode : 'DISCONNECTED'
  return new ServiceProtocolError(code)
}
