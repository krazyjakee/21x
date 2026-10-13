import { spawn } from 'node:child_process'
import { getTaskApiEnv } from '../task-api-server'
import { McpProbeService, type McpServerProbeInput, type McpServerProbeResult } from './mcp-probe-service'
export type { McpServerProbeInput, McpServerProbeResult } from './mcp-probe-service'

const probes = new McpProbeService({
  spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
  fetch: (input, init) => fetch(input, init),
  environment: () => process.env,
  taskApiEnvironment: getTaskApiEnv,
  platform: process.platform
})

export function testMcpServer(input: McpServerProbeInput): Promise<McpServerProbeResult> { return probes.probe(input) }
export function shutdownMcpProbes(): void { probes.shutdown() }
export function closeMcpProbes(timeoutMs?: number): Promise<void> { return probes.close(timeoutMs) }
export function areMcpProbesClosed(): boolean { return probes.isClosed }
