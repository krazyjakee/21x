/** Trusted owner composition; never accepted from desktop request payloads. */
export type ProductionCredentialMutation =
  | { kind: 'provider-key'; key: string }
  | { kind: 'secret'; secretId: string }
  | { kind: 'mcp-server'; serverId: string }
  | { kind: 'default-agent' }
  | { kind: 'plugin-resources'; agentIds: string[]; mcpServerIds: string[]; skillIds: string[] }
