/**
 * Linear issues as returned by LinearClient.getIssues() (the GraphQL `issues`
 * connection nodes, see src/main/plugins/linear-client.ts).
 */
import type { LinearIssue } from '../../src/main/plugins/linear-client'

export const LINEAR_UPLOAD_URL = 'https://uploads.linear.app/acme/eng/3f2a9c1e-7b4d-4c6a-9e0f-1a2b3c4d5e6f'

export const LINEAR_ISSUE_LOGIN: LinearIssue = {
  id: 'iss-1',
  title: 'Fix login redirect',
  description: `Users bounce back to /login after signing in.\n\n![login-loop.png](${LINEAR_UPLOAD_URL})`,
  state: { id: 'state-progress', name: 'In Progress' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  priority: 2,
  assignee: { id: 'user-1', displayName: 'Ana' },
  dueDate: '2026-10-02',
  labels: { nodes: [{ id: 'l1', name: 'Bug' }, { id: 'l2', name: 'Auth' }] },
  project: { id: 'proj-1', name: 'Q4 polish' },
  attachments: { nodes: [] },
  comments: { nodes: [] },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z'
}

export const LINEAR_ISSUE_CHANGELOG: LinearIssue = {
  id: 'iss-2',
  title: 'Write changelog',
  description: '',
  state: { id: 'state-todo', name: 'Todo' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  priority: 0,
  labels: { nodes: [] },
  attachments: { nodes: [] },
  comments: { nodes: [] },
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z'
}

export const LINEAR_ISSUE_DONE: LinearIssue = {
  id: 'iss-3',
  title: 'Rotate signing keys',
  description: 'Done last sprint',
  state: { id: 'state-done', name: 'Done' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  priority: 1,
  labels: { nodes: [{ id: 'l3', name: 'Security' }] },
  attachments: { nodes: [] },
  comments: { nodes: [] },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z'
}

export const LINEAR_ISSUES_FIRST_SYNC: LinearIssue[] = [LINEAR_ISSUE_LOGIN, LINEAR_ISSUE_CHANGELOG, LINEAR_ISSUE_DONE]

/** A later sync: iss-1 shipped, iss-2 was renamed and picked up. */
export const LINEAR_ISSUES_RESYNC: LinearIssue[] = [
  { ...LINEAR_ISSUE_LOGIN, state: { id: 'state-done', name: 'Done' }, updatedAt: '2026-09-18T00:00:00.000Z' },
  {
    ...LINEAR_ISSUE_CHANGELOG,
    title: 'Write the 2.0 changelog',
    state: { id: 'state-progress', name: 'In Progress' },
    assignee: { id: 'user-2', displayName: 'Ben' },
    updatedAt: '2026-09-18T00:00:00.000Z'
  }
]
