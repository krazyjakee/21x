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

