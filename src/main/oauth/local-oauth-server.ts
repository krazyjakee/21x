/**
 * Local OAuth Server
 *
 * Creates a temporary HTTP server on localhost to receive OAuth callbacks
 * for providers that don't support custom URL schemes (like HubSpot).
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

  /**
   * Start the local server and return the redirect URI
   */
  async start(): Promise<string> {
    // Try ports 3000-3010 until we find an available one
    for (let port = 3000; port <= 3010; port++) {
      try {
        await this.startOnPort(port)
        this.port = port
        return `http://localhost:${port}/callback`
      } catch {
        // Port in use, try next one
        continue
      }
    }
    throw new Error('Could not find available port for OAuth server')
  }

  /**
   * Start server on a specific port
   */
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

  /**
   * Wait for the OAuth callback
   */
  waitForCallback(): Promise<OAuthCallback> {
    return new Promise((resolve, reject) => {
      this.resolver = resolve
      this.rejecter = reject

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.resolver) {
          this.stop()
          reject(new Error('OAuth timeout: No callback received within 5 minutes'))
        }
      }, 5 * 60 * 1000)
    })
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`)

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        // OAuth error
        this.sendErrorPage(res, error, errorDescription)
        if (this.rejecter) {
          this.rejecter(new Error(`OAuth error: ${error} - ${errorDescription}`))
          this.rejecter = null
          this.resolver = null
        }
        this.stop()
        return
      }

      if (!code || !state) {
        // Missing parameters
        this.sendErrorPage(res, 'invalid_request', 'Missing code or state parameter')
        if (this.rejecter) {
          this.rejecter(new Error('OAuth callback missing required parameters'))
          this.rejecter = null
          this.resolver = null
        }
        this.stop()
        return
      }

      // Success - send success page to browser
      this.sendSuccessPage(res)

      // Resolve the promise with the callback data
      if (this.resolver) {
        this.resolver({ code, state, error: error || undefined, error_description: errorDescription || undefined })
        this.resolver = null
        this.rejecter = null
      }

      // Stop the server after a short delay (let the browser render the page)
      setTimeout(() => this.stop(), 1000)
    } else {
      // Unknown path
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  }

  private sendSuccessPage(res: ServerResponse): void {
    sendPage(res, 'Authentication successful', 'You can close this window and return to the app.')
  }

  private sendErrorPage(res: ServerResponse, error: string, description: string | null): void {
    const details = description ? `${error}: ${description}` : error
    sendPage(res, 'Authentication failed', 'Close this window and try again.', details)
  }

  /**
   * Stop the server
   */
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
