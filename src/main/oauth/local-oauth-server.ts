/**
 * Temporary localhost HTTP server that receives OAuth callbacks for providers
 * that don't support custom URL schemes (like HubSpot).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'

interface OAuthCallback {
  code: string
  state: string
  error?: string
  error_description?: string
}

export class LocalOAuthServer {
  private server: Server | null = null
  private port: number = 3000
  private resolver: ((value: OAuthCallback) => void) | null = null
  private rejecter: ((reason: Error) => void) | null = null

  /** Listens on the first free port in 3000-3010 and returns the redirect URI. */
  async start(): Promise<string> {
    for (let port = 3000; port <= 3010; port++) {
      try {
        await this.startOnPort(port)
        this.port = port
        return `http://localhost:${port}/callback`
      } catch {
        continue
      }
    }
    throw new Error('Could not find available port for OAuth server')
  }

  private startOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} already in use`))
        } else {
          reject(err)
        }
      })

      this.server.listen(port, 'localhost', () => {
        console.log(`[LocalOAuthServer] Listening on http://localhost:${port}/callback`)
        resolve()
      })
    })
  }

  waitForCallback(): Promise<OAuthCallback> {
    return new Promise((resolve, reject) => {
      this.resolver = resolve
      this.rejecter = reject

      setTimeout(() => {
        if (this.resolver) {
          this.stop()
          reject(new Error('OAuth timeout: No callback received within 5 minutes'))
        }
      }, 5 * 60 * 1000)
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`)

    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')

    if (error) {
      this.fail(res, error, errorDescription, `OAuth error: ${error} - ${errorDescription}`)
      return
    }
    if (!code || !state) {
      this.fail(res, 'invalid_request', 'Missing code or state parameter', 'OAuth callback missing required parameters')
      return
    }

    sendPage(res, 'Authentication successful', 'You can close this window and return to the app.')
    this.resolver?.({ code, state })
    this.resolver = null
    this.rejecter = null

    // Give the browser a moment to render the page before closing the server.
    setTimeout(() => this.stop(), 1000)
  }

  private fail(res: ServerResponse, error: string, description: string | null, reason: string): void {
    const details = description ? `${error}: ${description}` : error
    sendPage(res, 'Authentication failed', 'Close this window and try again.', details)
    this.rejecter?.(new Error(reason))
    this.stop()
  }

  stop(): void {
    if (this.server) {
      this.server.close(() => {
        console.log('[LocalOAuthServer] Server stopped')
      })
      this.server = null
    }
    this.resolver = null
    this.rejecter = null
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// The error text comes from the callback query string, so it is escaped
// before it reaches the page.
function sendPage(res: ServerResponse, title: string, message: string, details?: string): void {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 32rem; margin: 20vh auto; padding: 0 1.5rem; color: #1f1f23; }
      pre { white-space: pre-wrap; background: #f2f2ef; padding: 0.75rem; border-radius: 6px; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${details ? `<pre>${escapeHtml(details)}</pre>` : ''}
  </body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}
