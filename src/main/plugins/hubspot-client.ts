/**
 * HubSpot CRM API Client
 *
 * Wraps HubSpot's REST API for ticket management operations.
 * Handles pagination, ticket queries, owners, pipelines, and mutations.
 *
 * Uses direct fetch calls instead of the 44MB @hubspot/api-client SDK.
 */

import { HttpError } from '../http-utils'
import { downloadFile, requestJson } from './http'

const BASE_URL = 'https://api.hubapi.com'

export interface HubSpotTicket {
  id: string
  properties: {
    subject: string
    content?: string
    hs_pipeline?: string
    hs_pipeline_stage?: string
    hs_ticket_priority?: string
    hubspot_owner_id?: string
    hs_due_date?: string
    hs_ticket_category?: string
    hs_resolution?: string
    createdate?: string
    hs_lastmodifieddate?: string
  }
  associations?: {
    contacts?: {
      results: Array<{ id: string }>
    }
  }
}

export interface HubSpotOwner {
  id: string
  email: string
  firstName: string
  lastName: string
}

export interface HubSpotPipeline {
  id: string
  label: string
  displayOrder: number
  stages: Array<{
    id: string
    label: string
    displayOrder: number
    metadata: {
      ticketState: 'OPEN' | 'CLOSED'
    }
  }>
}

export interface HubSpotContact {
  id: string
  properties: {
    firstname?: string
    lastname?: string
    email?: string
  }
}

export interface HubSpotAttachment {
  id: string
  name: string
  size: number
  type: string
  url: string
  extension?: string
}

export interface HubSpotAccountInfo {
  portalId: number
  uiDomain: string
  timeZone: string
  accountType: string
}

const TICKET_PROPERTIES = [
  'subject',
  'content',
  'hs_pipeline',
  'hs_pipeline_stage',
  'hs_ticket_priority',
  'hubspot_owner_id',
  'hs_due_date',
  'hs_ticket_category',
  'hs_resolution',
  'createdate',
  'hs_lastmodifieddate'
]

const PROPERTIES_QUERY = TICKET_PROPERTIES.map((p) => `properties=${p}`).join('&')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = any

interface Page<T> {
  results: T[]
  paging?: { next?: { after?: string } }
}

export class HubSpotClient {
  private accessToken: string
  private accountInfo?: HubSpotAccountInfo

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  private request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    return requestJson(`${BASE_URL}${path}`, {
      method,
      body,
      service: 'HubSpot',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      errors: {
        401: 'HubSpot authentication failed. Please re-authenticate.',
        404: `HubSpot API not found: ${path}`
      }
    })
  }

  /** GET that resolves to null when the object does not exist. */
  private async requestOrNull(path: string): Promise<ApiResponse | null> {
    try {
      return await this.request('GET', path)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  }

  private async paginate<T>(fetchPage: (after?: string) => Promise<Page<T>>): Promise<T[]> {
    const all: T[] = []
    let after: string | undefined
    do {
      const page = await fetchPage(after)
      all.push(...page.results)
      after = page.paging?.next?.after
    } while (after)
    return all
  }

  /** Portal ID and UI domain, cached after the first call. */
  async getAccountInfo(): Promise<HubSpotAccountInfo> {
    if (!this.accountInfo) {
      const data = await this.request('GET', '/account-info/v3/details')
      this.accountInfo = {
        portalId: data.portalId,
        uiDomain: data.uiDomain || 'app.hubspot.com',
        timeZone: data.timeZone,
        accountType: data.accountType
      }
    }
    return this.accountInfo
  }

  /** Ticket URL on the account's region-specific domain. */
  async getTicketUrl(ticketId: string): Promise<string> {
    const accountInfo = await this.getAccountInfo()
    return `https://${accountInfo.uiDomain}/contacts/${accountInfo.portalId}/record/0-5/${ticketId}`
  }

  /**
   * @param modifiedAfter - Only fetch tickets modified after this date (ISO string)
   * @param onlyOpen - Only fetch tickets in an OPEN pipeline stage
   */
  async getTickets(pipelineId?: string, ownerId?: string, modifiedAfter?: string, onlyOpen?: boolean): Promise<HubSpotTicket[]> {
    let tickets: HubSpotTicket[]
    if (modifiedAfter || onlyOpen) {
      tickets = await this.searchTickets(modifiedAfter, pipelineId, ownerId, onlyOpen)
    } else {
      tickets = await this.paginate<HubSpotTicket>((after) =>
        this.request(
          'GET',
          `/crm/v3/objects/tickets?limit=100&${PROPERTIES_QUERY}&associations=contacts${after ? `&after=${after}` : ''}`
        )
      )
      // The list endpoint has no filters.
      if (pipelineId) tickets = tickets.filter((t) => t.properties.hs_pipeline === pipelineId)
      if (ownerId) tickets = tickets.filter((t) => t.properties.hubspot_owner_id === ownerId)
    }
    console.log(`[HubSpotClient] Fetched ${tickets.length} tickets`)
    return tickets
  }

  private async searchTickets(
    modifiedAfter?: string,
    pipelineId?: string,
    ownerId?: string,
    onlyOpen?: boolean
  ): Promise<HubSpotTicket[]> {
    const filters: Array<{ propertyName: string; operator: string; value: string }> = []
    if (modifiedAfter) {
      filters.push({
        propertyName: 'hs_lastmodifieddate',
        operator: 'GTE',
        value: new Date(modifiedAfter).getTime().toString()
      })
    }
    if (pipelineId) filters.push({ propertyName: 'hs_pipeline', operator: 'EQ', value: pipelineId })
    if (ownerId) filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId })

    const tickets = await this.paginate<HubSpotTicket>((after) =>
      this.request('POST', '/crm/v3/objects/tickets/search', {
        filterGroups: filters.length > 0 ? [{ filters }] : undefined,
        properties: TICKET_PROPERTIES,
        limit: 100,
        after
      })
    )

    if (!onlyOpen) return tickets

    // Search cannot filter on a stage's ticketState, so filter client-side.
    const pipelines = await this.getPipelines()
    const openStageIds = new Set(
      pipelines.flatMap((p) => p.stages.filter((s) => s.metadata.ticketState === 'OPEN').map((s) => s.id))
    )
    if (openStageIds.size === 0) return tickets
    return tickets.filter((t) => openStageIds.has(t.properties.hs_pipeline_stage || ''))
  }

  getTicket(ticketId: string): Promise<HubSpotTicket | null> {
    return this.requestOrNull(`/crm/v3/objects/tickets/${ticketId}?${PROPERTIES_QUERY}&associations=contacts`)
  }

  async updateTicket(ticketId: string, updates: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/crm/v3/objects/tickets/${ticketId}`, { properties: updates })
  }

  async addTicketNote(ticketId: string, noteBody: string): Promise<void> {
    const note = await this.request('POST', '/crm/v3/objects/notes', {
      properties: {
        hs_note_body: noteBody,
        hs_timestamp: new Date().toISOString()
      }
    })
    await this.request('PUT', `/crm/v4/objects/tickets/${ticketId}/associations/notes/${note.id}`, [
      {
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: 214 // Ticket to Note
      }
    ])
  }

  async getOwners(): Promise<HubSpotOwner[]> {
    const response = await this.request('GET', '/crm/v3/owners?limit=100')
    const owners = response.results.map(toOwner)
    console.log(`[HubSpotClient] Fetched ${owners.length} owners`)
    return owners
  }

  /** Resolves to null when the owner is missing or cannot be fetched. */
  async getOwner(ownerId: string): Promise<HubSpotOwner | null> {
    try {
      const response = await this.requestOrNull(`/crm/v3/owners/${ownerId}`)
      return response ? toOwner(response) : null
    } catch (err) {
      console.error(`[HubSpotClient] Failed to get owner ${ownerId}:`, err)
      return null
    }
  }

  async getPipelines(): Promise<HubSpotPipeline[]> {
    const response = await this.request('GET', '/crm/v3/pipelines/tickets')
    const pipelines = response.results.map((pipeline: ApiResponse) => ({
      id: pipeline.id,
      label: pipeline.label,
      displayOrder: pipeline.displayOrder,
      stages: (pipeline.stages || []).map((stage: ApiResponse) => ({
        id: stage.id,
        label: stage.label,
        displayOrder: stage.displayOrder,
        metadata: stage.metadata as { ticketState: 'OPEN' | 'CLOSED' }
      }))
    }))
    console.log(`[HubSpotClient] Fetched ${pipelines.length} pipelines`)
    return pipelines
  }

  /** Resolves to null when the contact is missing or cannot be fetched. */
  async getContact(contactId: string): Promise<HubSpotContact | null> {
    try {
      return await this.requestOrNull(
        `/crm/v3/objects/contacts/${contactId}?properties=firstname&properties=lastname&properties=email`
      )
    } catch (err) {
      console.error(`[HubSpotClient] Failed to get contact ${contactId}:`, err)
      return null
    }
  }

  /**
   * HubSpot attaches files to notes (engagements), not to tickets, so this
   * walks ticket -> notes -> hs_attachment_ids -> files.
   */
  async getTicketAttachments(ticketId: string): Promise<HubSpotAttachment[]> {
    try {
      const attachments: HubSpotAttachment[] = []
      const notes = await this.request('GET', `/crm/v4/objects/tickets/${ticketId}/associations/notes`)

      for (const noteAssoc of notes.results ?? []) {
        try {
          const note = await this.request(
            'GET',
            `/crm/v3/objects/notes/${noteAssoc.toObjectId}?properties=hs_attachment_ids`
          )
          const attachmentIds: string | undefined = note.properties.hs_attachment_ids
          if (!attachmentIds) continue

          for (const attachmentId of attachmentIds.split(';').map((id) => id.trim()).filter(Boolean)) {
            try {
              const file = await this.request('GET', `/files/v3/files/${attachmentId}`)
              // The file's own url is a redirect; a short-lived signed URL downloads reliably.
              const signed = await this.request(
                'GET',
                `/files/v3/files/${attachmentId}/signed-url?expirationSeconds=300`
              )
              attachments.push({
                id: file.id,
                name: file.name || 'Unnamed file',
                size: file.size || 0,
                type: file.type || 'application/octet-stream',
                url: signed.url,
                extension: file.extension || undefined
              })
            } catch (err) {
              console.error(`[HubSpotClient] Failed to fetch attachment ${attachmentId}:`, err)
            }
          }
        } catch (err) {
          console.error(`[HubSpotClient] Failed to fetch note ${noteAssoc.toObjectId}:`, err)
        }
      }

      return attachments
    } catch (err) {
      console.error(`[HubSpotClient] Failed to get ticket attachments:`, err)
      return []
    }
  }

  async downloadAttachment(url: string): Promise<Buffer> {
    return (await downloadFile(url)).buffer
  }
}

function toOwner(owner: ApiResponse): HubSpotOwner {
  return {
    id: owner.id,
    email: owner.email || '',
    firstName: owner.firstName || '',
    lastName: owner.lastName || ''
  }
}
