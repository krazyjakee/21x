/**
 * Building a recap when a task's work hands off from one agent to another
 * mid-conversation (e.g. switching from a model that ran out of credits to
 * a different one) — a pure function over transcript records so it can be
 * tested without starting the application.
 */

export interface TranscriptLike {
  partId?: string
  role: string
  content: string
  partType?: string
}

// ~200k tokens is the smallest context window among the agent backends this
// app supports — generous enough that almost every real conversation passes
// through whole, while still being a hard ceiling so a genuinely extreme
// transcript (a long-running task looping for days) can't blow past what any
// of them can even accept. There's no way to raise this per-handoff further
// than the receiving model's own context window actually allows — beyond
// that the API call itself would reject it, recap or not.
const DEFAULT_MAX_CHARS = 800_000

/** Part-id prefix AgentManager uses for the generated first prompt of a session. */
export const INITIAL_PROMPT_PART_PREFIX = 'user-initial-'

/**
 * Turns a task's transcript into a recap block to seed the next agent's
 * first prompt with, instead of starting from a blank slate.
 *
 * Only user asks and the previous agent's plain text replies are kept — tool
 * calls, reasoning, questions and errors are noise for a handoff and would
 * burn context without adding anything the new agent needs to continue the
 * work. The full conversation is passed through as long as it fits under
 * maxChars; only a transcript that exceeds it gets truncated to its most
 * recent portion. Returns '' when there is nothing worth recapping (fresh
 * task, or a transcript made up entirely of skipped part types).
 */
export function buildAgentSwitchRecap(parts: TranscriptLike[], maxChars = DEFAULT_MAX_CHARS): string {
  const turns = parts.filter(
    (p) =>
      // Generated initial prompts (task context, repos, skills, and any earlier
      // handoff recap) are rebuilt fresh for the new agent — recapping them
      // would duplicate that context and nest recaps on repeated switches.
      !p.partId?.startsWith(INITIAL_PROMPT_PART_PREFIX) &&
      (p.role === 'user' || p.role === 'assistant') &&
      (!p.partType || p.partType === 'text') &&
      (p.content ?? '').trim().length > 0
  )
  if (turns.length === 0) return ''

  let text = turns
    .map((p) => `${p.role === 'user' ? 'User' : 'Previous agent'}: ${p.content.trim()}`)
    .join('\n\n')

  // Keep the tail on truncation — the most recent exchanges matter most for
  // picking work back up, more than how the conversation started.
  if (text.length > maxChars) {
    text = `…(earlier conversation omitted)…\n\n${text.slice(text.length - maxChars)}`
  }

  return text
}

/**
 * Size of the recap a replacement session gets after the backend lost the
 * previous one. Deliberately small: it rides on the first prompt next to the
 * task context (and, for a Captain, the memory file already in its system
 * prompt), and only has to say where the conversation had got to.
 */
export const LOST_SESSION_RECAP_MAX_CHARS = 6_000

/** The transcript notice shown when a lost session is replaced. */
export const LOST_SESSION_NOTICE = 'Previous session was lost; starting a new session'

/**
 * The block that seeds a session replacing one the backend lost, or '' when
 * the transcript has nothing worth recapping. The newest exchanges are kept
 * when the conversation is longer than maxChars.
 */
export function buildLostSessionRecap(parts: TranscriptLike[], maxChars = LOST_SESSION_RECAP_MAX_CHARS): string {
  const recap = buildAgentSwitchRecap(parts, maxChars)
  if (!recap) return ''
  return [
    '## Continuing after a lost session',
    '',
    'Your previous session on this conversation was lost by the agent backend, so you are starting a new one. Here are the latest exchanges from it, for context only; do not redo work they show as finished:',
    '',
    recap,
    '',
    '---'
  ].join('\n')
}
