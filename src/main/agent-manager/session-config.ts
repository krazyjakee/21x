import { electronAgentManagerHost } from './electron-host'
import { assembleSessionConfig as assemblePortableSessionConfig, buildMcpServers as buildPortableMcpServers } from './session-config-core'

export * from './session-config-core'

/** Existing callers keep the shipping Electron services and argument shape. */
export function assembleSessionConfig(...args: [
  Parameters<typeof assemblePortableSessionConfig>[0],
  Parameters<typeof assemblePortableSessionConfig>[1],
  Parameters<typeof assemblePortableSessionConfig>[2]
]): ReturnType<typeof assemblePortableSessionConfig> {
  return assemblePortableSessionConfig(...args, electronAgentManagerHost())
}

export function buildMcpServers(...args: [
  Parameters<typeof buildPortableMcpServers>[0],
  Parameters<typeof buildPortableMcpServers>[1],
  Parameters<typeof buildPortableMcpServers>[2],
  Parameters<typeof buildPortableMcpServers>[3]?
]): ReturnType<typeof buildPortableMcpServers> {
  const [db, oauthManager, agentId, options] = args
  return buildPortableMcpServers(db, oauthManager, agentId, options, electronAgentManagerHost())
}
