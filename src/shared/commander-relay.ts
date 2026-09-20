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
