/** Read compatibility for coordinator prose and tool names stored before #71.
 * Keep these literals here; active prompts and UI use Captain.
 */
export const LEGACY_CAPTAIN_TOOL = 'ask_mastermind'
const LEGACY_CAPTAIN_NAME = /(?<![\w/\\.-])master ?mind(?![\w/\\-]|\.\w)/gi

/** Present the old role name as Captain; retain identifiers, paths and URLs. */
export function captainTerminology(text: string): string {
  return text.replace(LEGACY_CAPTAIN_NAME, 'Captain')
}

export function captainToolName(name: string): string {
  return name === LEGACY_CAPTAIN_TOOL ? 'ask_captain' : name
}
