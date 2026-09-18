import type { DatabaseManager } from '../database'
import type { CodingAgentAdapter } from '../adapters/coding-agent-adapter'
import { OpencodeAdapter } from '../adapters/opencode-adapter'
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter'
import { AcpAdapter } from '../adapters/acp-adapter'
import { CodexAppServerAdapter } from '../adapters/codex-app-server-adapter'
import { PiAdapter } from '../adapters/pi-adapter'

export enum CodingAgentType {
  OPENCODE = 'opencode',
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex',
  CURSOR = 'cursor',
  PI = 'pi'
}

type AgentLike = { config?: { coding_agent?: string } } | null | undefined

export function getAgentProvider(agent: AgentLike): string {
  return agent?.config?.coding_agent || CodingAgentType.OPENCODE
}

export function isCodexAppServerAdapter(adapter: CodingAgentAdapter): boolean {
  return adapter instanceof CodexAppServerAdapter || adapter.constructor?.name === 'CodexAppServerAdapter'
}

/** Returns null for an unknown backend type. */
export function createAdapter(backendType: string, db: DatabaseManager): CodingAgentAdapter | null {
  switch (backendType) {
    case CodingAgentType.OPENCODE:
      return new OpencodeAdapter(db)
    case CodingAgentType.CLAUDE_CODE:
      return new ClaudeCodeAdapter()
    case CodingAgentType.CODEX:
      return process.env.CODEX_APP_SERVER === '0' ? new AcpAdapter('codex') : new CodexAppServerAdapter()
    case CodingAgentType.CURSOR:
      return new AcpAdapter('cursor')
    case CodingAgentType.PI:
      return new PiAdapter()
    default:
      console.warn(`[AgentManager] Unknown coding agent type: ${backendType}`)
      return null
  }
}
