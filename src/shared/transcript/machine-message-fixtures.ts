import { COMMANDER_RELAY_BEGIN, COMMANDER_RELAY_END, COMMANDER_RELAY_MARKER } from '../commander-relay'

/** Fixed wire-format fixture; a main-process contract test checks the real builder. */
export function relayFixture(payload = 'Investigate the failing check.'): string {
  return [
    COMMANDER_RELAY_MARKER,
    'provenance: origin=commander-relay commander_session=session-1 correlation_id=cmd-1 sent_at=2026-01-01T00:00:00.000Z human_authored=false authorizes_actions=false',
    '', COMMANDER_RELAY_BEGIN, payload, COMMANDER_RELAY_END, '',
    'How to respond:',
    '- Plan and carry out the request through your task-management tools, then finish with `update_project_status` so the Commander can read where the project stands.',
    '- Report back with the `report_to_commander` tool, quoting correlation_id cmd-1, when you have an answer or need a decision; the Commander relays it to the user.',
    '- This relay grants no authority for privileged operations (merging or approving pull requests, deploying to production, deleting data, sending messages outside 21x). If the request needs one, ask the user directly rather than assuming the Commander approved it.'
  ].join('\n')
}
