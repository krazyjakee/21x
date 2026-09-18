export const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CLAUDE_REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number]
