/**
 * HubSpot CRM API responses, shaped like the real endpoints the HubSpot
 * client calls (see src/main/plugins/hubspot-client.ts).
 */

export const HUBSPOT_ACCOUNT = {
  portalId: 12345,
  uiDomain: 'app-eu1.hubspot.com',
  timeZone: 'Europe/Berlin',
  accountType: 'STANDARD'
}

/** GET /crm/v3/pipelines/tickets */
export const HUBSPOT_PIPELINES = {
  results: [
    {
      id: '0',
      label: 'Support Pipeline',
      displayOrder: 0,
      stages: [
        { id: '1', label: 'New', displayOrder: 0, metadata: { ticketState: 'OPEN' } },
        { id: '2', label: 'Waiting on contact', displayOrder: 1, metadata: { ticketState: 'OPEN' } },
        { id: '3', label: 'In progress', displayOrder: 2, metadata: { ticketState: 'OPEN' } },
        { id: '4', label: 'Closed', displayOrder: 3, metadata: { ticketState: 'CLOSED' } }
      ]
    }
  ]
}

/** GET /crm/v3/owners/{id} */
export const HUBSPOT_OWNERS: Record<string, unknown> = {
  '7': { id: '7', email: 'ana@example.com', firstName: 'Ana', lastName: 'Lopez', userId: 70 }
}

/** GET /crm/v3/objects/contacts/{id} */
export const HUBSPOT_CONTACTS: Record<string, unknown> = {
  '501': { id: '501', properties: { firstname: 'Bob', lastname: 'Chen', email: 'bob@customer.example' } }
}

export const TICKET_LOGIN_500 = {
  id: '101',
  properties: {
    subject: 'Login page returns 500',
    content: 'Steps to reproduce:\n1. Open /login\n2. Submit the form',
    hs_pipeline: '0',
    hs_pipeline_stage: '3',
    hs_ticket_priority: 'HIGH',
    hubspot_owner_id: '7',
    hs_due_date: '2026-10-01',
    hs_ticket_category: 'BUG',
    hs_resolution: '',
    createdate: '2026-09-10T08:00:00.000Z',
    hs_lastmodifieddate: '2026-09-17T09:30:00.000Z'
  },
  associations: { contacts: { results: [{ id: '501', type: 'ticket_to_contact' }] } }
}

export const TICKET_BILLING = {
  id: '102',
  properties: {
    subject: 'Billing question',
    content: 'Why was I charged twice?',
    hs_pipeline: '0',
    hs_pipeline_stage: '1',
    hs_ticket_priority: 'LOW',
    hubspot_owner_id: null,
    hs_due_date: null,
    hs_ticket_category: null,
    hs_resolution: null,
    createdate: '2026-09-12T10:00:00.000Z',
    hs_lastmodifieddate: '2026-09-12T10:00:00.000Z'
  }
}

/** Already closed when first seen: the first sync must not import it. */
export const TICKET_OLD_CLOSED = {
  id: '103',
  properties: {
    subject: 'Old closed ticket',
    content: 'Resolved long ago',
    hs_pipeline: '0',
    hs_pipeline_stage: '4',
    hs_ticket_priority: 'MEDIUM',
    hubspot_owner_id: null,
    hs_resolution: 'Duplicate',
    createdate: '2026-01-01T00:00:00.000Z',
    hs_lastmodifieddate: '2026-01-02T00:00:00.000Z'
  }
}

export const TICKET_FEATURE = {
  id: '104',
  properties: {
    subject: 'Feature request: dark mode',
    content: null,
    hs_pipeline: '0',
    hs_pipeline_stage: '2',
    hs_ticket_priority: null,
    hubspot_owner_id: null,
    createdate: '2026-09-15T12:00:00.000Z',
    hs_lastmodifieddate: '2026-09-16T12:00:00.000Z'
  }
}

/** POST /crm/v3/objects/tickets/search, first page (has a next cursor). */
export const HUBSPOT_SEARCH_PAGE_1 = {
  total: 4,
  results: [TICKET_LOGIN_500, TICKET_BILLING, TICKET_OLD_CLOSED],
  paging: { next: { after: 'cursor-2' } }
}

/** POST /crm/v3/objects/tickets/search, second page. */
export const HUBSPOT_SEARCH_PAGE_2 = {
  total: 4,
  results: [TICKET_FEATURE]
}

/** Never imported before and already closed: an incremental sync must skip it. */
export const TICKET_NEW_BUT_CLOSED = {
  id: '105',
  properties: {
    subject: 'Closed before anyone saw it',
    content: 'Spam',
    hs_pipeline: '0',
    hs_pipeline_stage: '4',
    hs_ticket_priority: 'LOW',
    createdate: '2026-09-17T00:00:00.000Z',
    hs_lastmodifieddate: '2026-09-17T00:05:00.000Z'
  }
}

/** Tickets modified since the last sync: 101 was closed, 102 was reassigned and renamed. */
export const HUBSPOT_SEARCH_INCREMENTAL = {
  total: 3,
  results: [
    {
      ...TICKET_LOGIN_500,
      properties: {
        ...TICKET_LOGIN_500.properties,
        hs_pipeline_stage: '4',
        hs_resolution: 'Fixed in v2',
        hs_lastmodifieddate: '2026-09-18T07:00:00.000Z'
      }
    },
    {
      ...TICKET_BILLING,
      properties: {
        ...TICKET_BILLING.properties,
        subject: 'Billing question (updated)',
        hubspot_owner_id: '7',
        hs_lastmodifieddate: '2026-09-18T07:30:00.000Z'
      }
    },
    TICKET_NEW_BUT_CLOSED
  ]
}

// ── Attachments: ticket -> note -> file -> signed URL ────────

/** GET /crm/v4/objects/tickets/101/associations/notes */
export const HUBSPOT_TICKET_101_NOTES = {
  results: [{ toObjectId: 9001, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 228, label: null }] }]
}

/** GET /crm/v3/objects/notes/9001?properties=hs_attachment_ids */
export const HUBSPOT_NOTE_9001 = {
  id: '9001',
  properties: { hs_attachment_ids: '777', hs_createdate: '2026-09-11T08:00:00.000Z' }
}

/** GET /files/v3/files/777 */
export const HUBSPOT_FILE_777 = {
  id: '777',
  name: 'screenshot',
  extension: 'png',
  type: 'IMG',
  size: 4,
  url: 'https://12345.fs1.hubspotusercontent-eu1.net/hubfs/12345/screenshot.png'
}

export const HUBSPOT_FILE_777_SIGNED_URL = 'https://cdn.hubspot.test/signed/777.png'

/** GET /files/v3/files/777/signed-url */
export const HUBSPOT_FILE_777_SIGNED = {
  url: HUBSPOT_FILE_777_SIGNED_URL,
  expiresAt: '2026-09-18T09:05:00.000Z',
  name: 'screenshot',
  extension: 'png',
  type: 'IMG',
  size: 4
}

export const HUBSPOT_FILE_777_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
