import type { IncomingMessage } from 'http'

/** An error that carries the HTTP status the server should answer with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
}

/**
 * Buffers the request body. Past `maxBytes` it rejects with a 413 and drains
 * the rest without keeping it, so the caller can still write that response.
 */
export function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > maxBytes) {
        req.off('data', onData)
        req.resume()
        reject(new HttpError(413, 'Request body too large'))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** An empty body is `{}`; anything that is not a JSON object is a 400. */
export function parseJsonBody(body: string): Record<string, unknown> {
  if (!body) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new HttpError(400, 'Malformed JSON body')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export async function readJsonBody(req: IncomingMessage, maxBytes = Infinity): Promise<Record<string, unknown>> {
  return parseJsonBody(await readBody(req, maxBytes))
}
