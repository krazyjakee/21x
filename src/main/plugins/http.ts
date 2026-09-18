/**
 * Shared fetch helpers for the task source API clients.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { HttpError } from '../http-utils'

interface JsonRequestOptions {
  method?: string
  headers: Record<string, string>
  body?: unknown
  /** Label used in the generic error message, e.g. "Notion" -> "Notion API error: 500 ..." */
  service: string
  /** Messages for specific failure statuses; others get the generic message. */
  errors?: Partial<Record<number, string>>
  /** How many times a 429 response is retried after waiting Retry-After seconds. */
  retries?: number
  /** Wait used when a 429 response has no Retry-After header. */
  defaultRetryAfterSeconds?: number
}

/** Fetches JSON, retrying on 429 and throwing HttpError on any other failure. */
export async function requestJson<T>(url: string, options: JsonRequestOptions): Promise<T> {
  const { method = 'GET', headers, body, service, errors = {}, retries = 3, defaultRetryAfterSeconds = 1 } = options

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })

    if (response.status === 429 && attempt < retries) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || String(defaultRetryAfterSeconds), 10)
      await sleep(retryAfter * 1000)
      continue
    }

    if (!response.ok) {
      const message = errors[response.status] ?? `${service} API error: ${response.status} ${await response.text()}`
      throw new HttpError(response.status, message)
    }

    return (await response.json()) as T
  }
}

export interface DownloadedFile {
  buffer: Buffer
  /** Filename from the Content-Disposition header, if any. */
  filename?: string
  contentType?: string
}

export async function downloadFile(url: string, headers?: Record<string, string>): Promise<DownloadedFile> {
  const response = await fetch(url, headers ? { headers } : undefined)
  if (!response.ok) {
    throw new HttpError(response.status, `Failed to download file: ${response.status}`)
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type') || undefined
  }
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  const match = header?.match(/filename\*?=(?:UTF-8''([^;]+)|"([^"]+)"|([^;]+))/i)
  if (!match) return undefined
  const raw = (match[1] ?? match[2] ?? match[3]).trim()
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Last path segment of a URL when it looks like a filename (has an extension). */
export function filenameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    return last && last.includes('.') ? decodeURIComponent(last) : undefined
  } catch {
    return undefined
  }
}
