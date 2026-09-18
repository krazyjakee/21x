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

/**
 * Todoist: the OAuth2 proof piece (issue #15). Imports the active tasks a
 * Todoist filter query selects (`todoist_filter_tasks` follows every page);
 * completion goes through the dedicated close / reopen actions because
 * `todoist_update_task` cannot change it. Active tasks only: a task completed
 * in Todoist simply stops appearing (see docs/connectors.md).
 */
const todoist: ConnectorTaskMapping = {
  pieceName: '@activepieces/piece-todoist',
  label: 'Todoist',
  auth: {
    type: 'oauth2',
    labels: { clientId: 'Client ID', clientSecret: 'Client secret' },
    help: 'Create an app at developer.todoist.com/appconsole.html with the OAuth redirect URL http://localhost:3000/callback (21x also tries ports 3001-3010), then paste its Client ID and Client secret and click Connect.',
    scopes: ['data:read_write']
  },
  configProps: [
    {
      key: 'filter_query',
      label: 'Filter',
      required: true,
      placeholder: 'e.g. #Work | overdue',
      description: 'A Todoist filter in its native syntax: a project (#Work), a label (@waiting), "today", "overdue", "no due date", combined with & and |.'
    }
  ],
  import: {
    target: { type: 'action', name: 'todoist_filter_tasks' },
    props: { query: { config: 'filter_query' } },
    itemsPath: 'tasks'
  },
  fields: {
    externalId: 'id',
    title: 'content',
    description: 'description',
    dueDate: 'due.date',
    labels: 'labels',
    status: { path: 'checked', completedValues: [true] }
  },
  update: {
    action: 'todoist_update_task',
    idProp: 'task_id',
    titleProp: 'content',
    // The piece routes any value matching \d{4}-\d{2}-\d{2} to Todoist's
    // `due_date`, which only takes a calendar day; a full timestamp is refused.
    dueDateProp: 'due_date',
    dueDateFormat: 'date',
    statusActions: {
      complete: { action: 'todoist_complete_task', idProp: 'task_id' },
      reopen: { action: 'todoist_reopen_task', idProp: 'task_id' }
    }
  }
}

export const CONNECTOR_TASK_MAPPINGS: ConnectorTaskMappings = {
  [trello.pieceName]: trello,
  [todoist.pieceName]: todoist
}

export function getTaskMapping(
  pieceName: string,
  mappings: ConnectorTaskMappings = CONNECTOR_TASK_MAPPINGS
): ConnectorTaskMapping | undefined {
  return Object.prototype.hasOwnProperty.call(mappings, pieceName) ? mappings[pieceName] : undefined
}
