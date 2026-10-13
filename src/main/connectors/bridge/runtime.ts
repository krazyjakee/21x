import { shell } from 'electron'
import { createUtilityProcessTransport } from '../piece-host/utility-transport'
import { getConnectorRuntime as getRuntime, type ConnectorRuntime, type DbSource } from './runtime-core'

export { closeConnectorRuntime, disposeConnectorRuntime, ConnectorRuntimeClosedError } from './runtime-core'
export type { ConnectorRuntime } from './runtime-core'

/** Legacy desktop host; portable service owners inject their own native/worker host. */
export function getConnectorRuntime(source: DbSource): ConnectorRuntime {
  return getRuntime(source, {
    openExternal: url => shell.openExternal(url),
    createTransport: () => createUtilityProcessTransport()
  })
}
