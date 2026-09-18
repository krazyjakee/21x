import type { ConnectorTaskMapping, ConnectorTaskMappings } from './mapping'

/**
 * Task mappings for allowlisted pieces (the sibling of ../allowlist.ts).
 *
 * Only pieces listed here can back a connector-bridge task source. Every
 * action and trigger named here must also be allowlisted; validateMapping()
 * enforces that at runtime and in the tests.
 */

const trello: ConnectorTaskMapping = {
  pieceName: '@activepieces/piece-trello',
  label: 'Trello',
  auth: {
    type: 'basic',
    labels: { username: 'API key', password: 'Token' },
    help: 'Create a Power-Up at trello.com/power-ups/admin, copy its API key, then generate a token for your account.'
  },
  configProps: [
    {
      key: 'board_id',
      label: 'Board ID',
      required: true,
      placeholder: 'e.g. 5f1a2b3c4d5e6f7a8b9c0d1e',
      description: 'The id in the board URL (trello.com/b/<id>/...) or from the board JSON export.'
    }
  ],
  import: {
    target: { type: 'action', name: 'list_cards_in_board' },
    // "all" includes archived cards so a card archived in Trello completes its
    // task. Archived cards never create new tasks (see the bridge engine).
    props: { board_id: { config: 'board_id' }, filter: { value: 'all' } },
    itemsPath: 'cards'
  },
  fields: {
    externalId: 'id',
    title: 'name',
    description: 'desc',
    dueDate: 'due',
    url: 'url',
    labels: 'labels[].name',
    status: { path: 'closed', completedValues: [true] }
  },
  update: {
    action: 'update_card',
    idProp: 'card_id',
    titleProp: 'name',
    dueDateProp: 'due',
    status: { prop: 'closed', completedValue: true, openValue: false }
  }
}

export const CONNECTOR_TASK_MAPPINGS: ConnectorTaskMappings = {
  [trello.pieceName]: trello
}

export function getTaskMapping(
  pieceName: string,
  mappings: ConnectorTaskMappings = CONNECTOR_TASK_MAPPINGS
): ConnectorTaskMapping | undefined {
  return Object.prototype.hasOwnProperty.call(mappings, pieceName) ? mappings[pieceName] : undefined
}
