import { ConnectorBridgeCore, type ConnectorBridgeCoreOptions } from './connector-bridge-core'
import { getConnectorRuntime } from '../connectors/bridge/runtime'

export type { BridgePollingOptions } from './connector-bridge-core'
export interface ConnectorBridgePluginOptions extends Omit<ConnectorBridgeCoreOptions, 'runtime'> {
  runtime?: ConnectorBridgeCoreOptions['runtime']
}

/** Legacy desktop adapter; standalone services import ConnectorBridgeCore directly. */
export class ConnectorBridgePlugin extends ConnectorBridgeCore {
  constructor(options: ConnectorBridgePluginOptions = {}) {
    super({ ...options, runtime: options.runtime ?? getConnectorRuntime })
  }
}
