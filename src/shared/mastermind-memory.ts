/**
 * The memory file a project's Mastermind keeps in its workspace (#55): the
 * decisions, conventions and open threads it wants to remember across
 * sessions. Main reads it into the Mastermind's prompt and serves it to the
 * project editor read-only; the Mastermind itself writes it with its file tools.
 */
export interface MastermindMemory {
  /** Absolute path of the memory file. */
  path: string
  /** Its content, cut to the injection cap. Empty when the file does not exist. */
  content: string
  /** True when `content` is a prefix of a longer file. */
  truncated: boolean
}
