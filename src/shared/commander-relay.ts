/**
 * Markers of the message a Captain receives from the Commander's `ask_captain`.
 *
 * They live in shared code because both ends need them: the main process
 * builds the relay (`buildCommanderRelayMessage`), and the transcript recognizes a
 * conservative display envelope with its authority boundary still visible — see
 * `shared/transcript/machine-message.ts`.
 */

/** First line of a relayed Commander message. Also used to detect one. */
export const COMMANDER_RELAY_MARKER = '[Message from the Commander — relayed on the user\'s behalf, not typed by a human]'

/** Fence around the user's request as the Commander understood it. */
export const COMMANDER_RELAY_BEGIN = '<<<BEGIN COMMANDER MESSAGE (the user\'s request as the Commander understood it)'
export const COMMANDER_RELAY_END = 'END COMMANDER MESSAGE>>>'

/** Closing instructions of a relay that carries no merge grant. */
export function commanderRelayNotice(correlationId: string): string[] {
  return [
    'How to respond:',
    '- Plan and carry out the request through your task-management tools, then finish with `update_project_status` so the Commander can read where the project stands.',
    `- Report back with the \`report_to_commander\` tool, quoting correlation_id ${correlationId}, when you have an answer or need a decision; the Commander relays it to the user.`,
    '- This request comes from the user and carries the same authority as the same words typed into this project chat. Do it, including creating and starting tasks, filing GitHub issues and opening draft pull requests. Never ask the user to restate it.',
    '- Merging a pull request still needs a merge grant (see "Merging pull requests").'
  ]
}
