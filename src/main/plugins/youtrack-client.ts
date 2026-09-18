/**
 * YouTrack REST API Client
 *
 * Lightweight client using fetch() -- no npm dependencies.
 * Handles pagination, rate limiting, and error handling.
 * Supports both YouTrack Cloud and self-hosted instances.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { HttpError } from '../http-utils'
import { downloadFile, filenameFromUrl, requestJson } from './http'

// ── Response types ───────────────────────────────────────────

export interface YouTrackUser {
  id: string
  login: string
  fullName: string
  email?: string
  $type?: string
}

export interface YouTrackProject {
  id: string
  name: string
  shortName: string
  $type?: string
}

export interface YouTrackCustomFieldValue {
  name?: string
  login?: string
  fullName?: string
  text?: string
  minutes?: number
  presentation?: string
  id?: string
  $type?: string
}

export interface YouTrackCustomField {
  name: string
  value:
    | YouTrackCustomFieldValue
    | YouTrackCustomFieldValue[]
    | string
    | number
    | null
  projectCustomField?: {
    field?: {
      name: string
      fieldType?: { id: string }
    }
  }
  $type?: string
}

export interface YouTrackTag {
  id: string
  name: string
  color?: {
    background?: string
    foreground?: string
  }
  $type?: string
}

export interface YouTrackAttachment {
  id: string
  name: string
  url: string
  size: number
  mimeType: string
  $type?: string
}

export interface YouTrackIssueLinkType {
  name: string
  sourceToTarget: string
  targetToSource: string | null
  directed: boolean
  $type?: string
}

export interface YouTrackIssueLink {
  id: string
  direction: 'OUTWARD' | 'INWARD' | 'BOTH'
  linkType: YouTrackIssueLinkType | null
  issues: Array<{
    id: string
    idReadable: string
    summary: string
    resolved: number | null
  }>
  $type?: string
}

export interface YouTrackIssue {
  id: string
  idReadable: string
  summary: string
  description: string | null
  created: number
  updated: number
  resolved: number | null
  project: YouTrackProject
  reporter?: YouTrackUser
  customFields: YouTrackCustomField[]
  tags: YouTrackTag[]
  attachments: YouTrackAttachment[]
  links: YouTrackIssueLink[]
  parent?: YouTrackIssueLink | null
  subtasks?: YouTrackIssueLink | null
  $type?: string
}

export interface YouTrackBundleValue {
  name: string
  login?: string
  fullName?: string
  id?: string
  $type?: string
}

export interface YouTrackProjectCustomField {
  id: string
  field: {
    name: string
    fieldType: { id: string }
  }
  bundle?: {
    values: YouTrackBundleValue[]
  }
  $type?: string
}

// ── Client ───────────────────────────────────────────────────

const PAGE_SIZE = 50
const RATE_LIMIT_DELAY = 200 // ms between paginated requests

/** Fields param to request all data needed for task mapping */
const ISSUE_FIELDS = [
  'id',
  'idReadable',
  'summary',
  'description',
  'created',
  'updated',
  'resolved',
  'project(id,name,shortName)',
  'reporter(login,fullName)',
  'customFields(name,value(name,login,fullName,text,minutes,presentation,id,$type),projectCustomField(field(name,fieldType(id))))',
  'tags(id,name,color(background,foreground))',
  'attachments(id,name,url,size,mimeType)',
  'links(id,direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved))',
  'parent(id,direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved))',
  'subtasks(id,direction,linkType(name,sourceToTarget,targetToSource,directed),issues(id,idReadable,summary,resolved))'
].join(',')

export class YouTrackClient {
  private baseUrl: string
  private token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = this.normalizeBaseUrl(baseUrl)
    this.token = token
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Normalize the base URL: strip trailing slash and /api suffix.
   * Handles path-based URLs like /youtrack.
   */
  private normalizeBaseUrl(url: string): string {
    let normalized = url.trim()
    // Remove trailing slash(es)
    normalized = normalized.replace(/\/+$/, '')
    // Remove trailing /api if present
    normalized = normalized.replace(/\/api$/, '')
    return normalized
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(`${this.baseUrl}/api${path}`, {
      method,
      body,
      service: 'YouTrack',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      errors: {
        401: 'YouTrack authentication failed. Check your permanent token.',
        403: 'YouTrack access forbidden. Your token may lack the required permissions.',
        404: `YouTrack API endpoint not found: ${path}. Check your server URL.`
      },
      defaultRetryAfterSeconds: 2
    })
  }

  // ── Public methods ───────────────────────────────────────

  /**
   * Test connection by fetching the current user.
   * Also verifies the server URL is correct and reachable.
   */
  async testConnection(): Promise<YouTrackUser> {
    return this.request<YouTrackUser>(
      'GET',
      '/users/me?fields=id,login,fullName,email'
    )
  }

  /**
   * Fetch issues matching a YQL query with pagination.
   */
  async getIssues(
    query: string,
    skip = 0,
    top = PAGE_SIZE
  ): Promise<YouTrackIssue[]> {
    const params = new URLSearchParams({
      fields: ISSUE_FIELDS,
      query,
      $skip: String(skip),
      $top: String(top)
    })
    return this.request<YouTrackIssue[]>('GET', `/issues?${params.toString()}`)
  }

  /**
   * Fetch all issues matching a YQL query, handling pagination automatically.
   * Inserts a delay between pages to avoid rate limiting.
   */
  async getAllIssues(query: string): Promise<YouTrackIssue[]> {
    const allIssues: YouTrackIssue[] = []
    let skip = 0

    do {
      const page = await this.getIssues(query, skip, PAGE_SIZE)
      allIssues.push(...page)

      if (page.length < PAGE_SIZE) break
      skip += PAGE_SIZE
      await sleep(RATE_LIMIT_DELAY)
    } while (true)

    return allIssues
  }

  /**
   * Fetch a single issue by ID.
   */
  async getIssue(issueId: string): Promise<YouTrackIssue> {
    const params = new URLSearchParams({ fields: ISSUE_FIELDS })
    return this.request<YouTrackIssue>(
      'GET',
      `/issues/${issueId}?${params.toString()}`
    )
  }

  /**
   * Update an issue's fields.
   */
  async updateIssue(
    issueId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const params = new URLSearchParams({ fields: 'id' })
    await this.request<unknown>(
      'POST',
      `/issues/${issueId}?${params.toString()}`,
      body
    )
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(issueId: string, text: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/issues/${issueId}/comments?fields=id`,
      { text }
    )
  }

  /**
   * List all projects accessible to the current user.
   * Uses the admin API; returns no projects when it is forbidden.
   */
  async getProjects(): Promise<YouTrackProject[]> {
    try {
      return await this.request<YouTrackProject[]>(
        'GET',
        '/admin/projects?fields=id,name,shortName&$top=500'
      )
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        console.warn('[youtrack] Admin API not accessible, no projects listed')
        return []
      }
      throw err
    }
  }

  /**
   * List workspace users.
   */
  async getUsers(): Promise<YouTrackUser[]> {
    return this.request<YouTrackUser[]>(
      'GET',
      '/users?fields=id,login,fullName,email&$top=500'
    )
  }

  /**
   * Get custom fields for a project, including bundle values.
   * This is used to resolve filter options (states, priorities, types).
   */
  async getProjectCustomFields(
    projectId: string
  ): Promise<YouTrackProjectCustomField[]> {
    return this.request<YouTrackProjectCustomField[]>(
      'GET',
      `/admin/projects/${projectId}/customFields?fields=id,field(name,fieldType(id)),bundle(values(name,login,fullName,id,$type))&$top=100`
    )
  }

  /**
   * Download an attachment file.
   * Attachment URLs in YouTrack are relative; we prepend the base URL.
   */
  async downloadAttachment(
    attachmentUrl: string
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const fullUrl = attachmentUrl.startsWith('http')
      ? attachmentUrl
      : `${this.baseUrl}${attachmentUrl}`
    const file = await downloadFile(fullUrl, { 'Authorization': `Bearer ${this.token}` })
    return {
      buffer: file.buffer,
      filename: file.filename || filenameFromUrl(fullUrl) || `youtrack-attachment-${Date.now()}`,
      contentType: file.contentType || 'application/octet-stream'
    }
  }

  /**
   * Get the base URL for constructing issue web links.
   */
  getBaseUrl(): string {
    return this.baseUrl
  }
}
