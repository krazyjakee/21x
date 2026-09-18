/**
 * Responses of `gh api --paginate /repos/{owner}/{repo}/issues`, shaped like
 * the GitHub REST API (the fields GitHubManager.fetchIssues reads).
 */
import type { GitHubIssue } from '../../src/main/github-manager'

export const GITHUB_ISSUE_CRASH: GitHubIssue = {
  number: 12,
  title: 'Crash on startup',
  body: 'Stack trace:\n```\nTypeError: cannot read properties of undefined\n```',
  state: 'open',
  assignees: [{ login: 'alice' }, { login: 'bob' }],
  labels: [{ name: 'bug' }, { name: 'P1' }, { name: 'in progress' }],
  milestone: { due_on: '2026-10-15T00:00:00Z' },
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-17T10:00:00Z'
}

export const GITHUB_ISSUE_DOCS: GitHubIssue = {
  number: 13,
  title: 'Docs typo',
  body: null,
  state: 'open',
  assignees: [],
  labels: [{ name: 'priority:low' }, { name: 'needs review' }],
  milestone: null,
  created_at: '2026-09-02T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z'
}

/** The issues API also lists pull requests; they must be ignored. */
export const GITHUB_PULL_REQUEST: GitHubIssue = {
  number: 14,
  title: 'Add dark mode',
  body: 'Implements #9',
  state: 'open',
  assignees: [{ login: 'carol' }],
  labels: [{ name: 'enhancement' }],
  milestone: null,
  pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/14' },
  created_at: '2026-09-03T10:00:00Z',
  updated_at: '2026-09-03T10:00:00Z'
}

export const GITHUB_ISSUE_CLOSED: GitHubIssue = {
  number: 15,
  title: 'Closed already',
  body: 'Fixed in 1.2',
  state: 'closed',
  assignees: [],
  labels: [{ name: 'p3' }],
  milestone: null,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-05T10:00:00Z'
}

export const GITHUB_ISSUES_FIRST_SYNC: GitHubIssue[] = [
  GITHUB_ISSUE_CRASH,
  GITHUB_ISSUE_DOCS,
  GITHUB_PULL_REQUEST,
  GITHUB_ISSUE_CLOSED
]

/** A later sync: #12 was closed and renamed, #13 lost its review label. */
export const GITHUB_ISSUES_RESYNC: GitHubIssue[] = [
  {
    ...GITHUB_ISSUE_CRASH,
    title: 'Crash on startup (fixed)',
    state: 'closed',
    labels: [{ name: 'bug' }, { name: 'P1' }],
    updated_at: '2026-09-18T08:00:00Z'
  },
  {
    ...GITHUB_ISSUE_DOCS,
    labels: [{ name: 'priority:low' }]
  },
  GITHUB_ISSUE_CLOSED
]
