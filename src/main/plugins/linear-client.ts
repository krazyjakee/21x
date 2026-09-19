/**
 * Linear GraphQL API Client
 *
 * Wraps Linear's GraphQL API for task management operations.
 * Handles pagination, issue queries, workflow states, and mutations.
 */

import { downloadFile, requestJson, type DownloadedFile } from './http'

export interface LinearIssue {
  id: string
  title: string
  description: string
  state: { id: string; name: string }
  team?: { id: string; name: string; key: string }
  priority: number
  assignee?: { id: string; displayName: string }
  dueDate?: string
  labels: { nodes: Array<{ id: string; name: string }> }
  project?: { id: string; name: string }
  attachments: { nodes: Array<{ id: string; url: string; title?: string; subtitle?: string; metadata?: { size?: number } }> }
  comments: { nodes: Array<{ id: string; body: string; user?: { displayName: string }; attachments?: Array<{ id: string; url: string; filename?: string; size?: number; contentType?: string }> }> }
  createdAt: string
  updatedAt: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  type: string
}

export interface LinearUser {
  id: string
  name: string
  displayName: string
  email: string
}

export class LinearClient {
  private accessToken: string
  private apiUrl = 'https://api.linear.app/graphql'

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await requestJson<{ data?: T; errors?: Array<{ message: string }> }>(this.apiUrl, {
      method: 'POST',
      body: { query, variables },
      service: 'Linear',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`
      },
      errors: {
        401: 'Linear authentication failed. Please re-authenticate.',
        403: 'Linear access forbidden. Check your OAuth permissions.'
      }
    })

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${result.errors[0].message}`)
    }
    if (!result.data) {
      throw new Error('Linear API returned no data')
    }
    return result.data
  }

  /** Collects every page of a Relay-style connection query. */
  private async paginate<T>(
    query: string,
    connection: string,
    variables: Record<string, unknown> = {}
  ): Promise<T[]> {
    const all: T[] = []
    let after: string | undefined
    for (;;) {
      const data = await this.query<Record<string, { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }>>(
        query,
        { ...variables, first: 50, after }
      )
      const page = data[connection]
      all.push(...page.nodes)
      if (!page.pageInfo.hasNextPage) return all
      after = page.pageInfo.endCursor
    }
  }

  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query GetIssue($issueId: String!) {
        issue(id: $issueId) {
          id
          title
          description
          state {
            id
            name
          }
          team {
            id
            name
            key
          }
          priority
          assignee {
            id
            displayName
          }
          dueDate
          labels {
            nodes {
              id
              name
            }
          }
          project {
            id
            name
          }
          attachments {
            nodes {
              id
              url
              title
              subtitle
              metadata
            }
          }
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              user {
                displayName
              }
            }
          }
          createdAt
          updatedAt
        }
      }
    `

    const data = await this.query<{ issue: LinearIssue | null }>(query, { issueId })
    return data.issue
  }

  async getIssues(assigneeId?: string): Promise<LinearIssue[]> {
    const filterClause = assigneeId ? 'filter: { assignee: { id: { eq: $assigneeId } } }' : ''

    const query = `
      query GetIssues($assigneeId: ID, $first: Int!, $after: String) {
        issues(
          ${filterClause}
          first: $first
          after: $after
          orderBy: updatedAt
        ) {
          nodes {
            id
            title
            description
            state {
              id
              name
            }
            team {
              id
              name
              key
            }
            priority
            assignee {
              id
              displayName
            }
            dueDate
            labels {
              nodes {
                id
                name
              }
            }
            project {
              id
              name
            }
            attachments {
              nodes {
                id
                url
                title
                subtitle
                metadata
              }
            }
            createdAt
            updatedAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `

    return this.paginate<LinearIssue>(query, 'issues', { assigneeId: assigneeId || null })
  }

  async getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const query = `
      query GetWorkflowStates($teamId: ID!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }
    `

    const data = await this.query<{
      team: { states: { nodes: LinearWorkflowState[] } }
    }>(query, { teamId })

    return data.team.states.nodes
  }

  async getUsers(): Promise<LinearUser[]> {
    const query = `
      query GetUsers($first: Int!, $after: String) {
        users(first: $first, after: $after) {
          nodes {
            id
            name
            displayName
            email
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `

    const users = await this.paginate<LinearUser>(query, 'users')
    console.log(`[LinearClient] Fetched ${users.length} users`)
    return users
  }

  async updateIssue(
    issueId: string,
    updates: {
      stateId?: string
      priority?: number
      title?: string
      description?: string
      assigneeId?: string | null
      dueDate?: string | null
    }
  ): Promise<void> {
    const mutation = `
      mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) {
          success
          issue {
            id
          }
        }
      }
    `

    const input: Record<string, unknown> = {}
    if (updates.stateId !== undefined) input.stateId = updates.stateId
    if (updates.priority !== undefined) input.priority = updates.priority
    if (updates.title !== undefined) input.title = updates.title
    if (updates.description !== undefined) input.description = updates.description
    if (updates.assigneeId !== undefined) input.assigneeId = updates.assigneeId
    if (updates.dueDate !== undefined) input.dueDate = updates.dueDate

    const data = await this.query<{
      issueUpdate: { success: boolean }
    }>(mutation, { issueId, input })

    if (!data.issueUpdate.success) {
      throw new Error('Failed to update Linear issue')
    }
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
          }
        }
      }
    `

    const data = await this.query<{
      commentCreate: { success: boolean }
    }>(mutation, { issueId, body })

    if (!data.commentCreate.success) {
      throw new Error('Failed to add comment to Linear issue')
    }
  }

  async getAttachmentMetadata(attachmentId: string): Promise<{ id: string; title?: string; url?: string } | null> {
    const query = `
      query GetAttachment($attachmentId: String!) {
        attachment(id: $attachmentId) {
          id
          title
          url
        }
      }
    `

    try {
      const data = await this.query<{ attachment: { id: string; title?: string; url?: string } | null }>(
        query,
        { attachmentId }
      )
      return data.attachment
    } catch (err) {
      console.error(`[LinearClient] Failed to get attachment metadata for ${attachmentId}:`, err)
      return null
    }
  }

  downloadAttachment(url: string): Promise<DownloadedFile> {
    return downloadFile(url, { 'Authorization': `Bearer ${this.accessToken}` })
  }
}
