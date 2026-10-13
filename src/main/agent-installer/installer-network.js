import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { addAbortSignal, Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024

/** Portable network owner. The host supplies Node fetch or its system-proxy fetch. */
export class InstallerNetwork {
  #fetchClient
  #shutdown = new AbortController()
  /** @type {Set<Promise<unknown>>} */
  #pending = new Set()
  #closing = false

  /** @param {typeof globalThis.fetch} fetchClient */
  constructor(fetchClient) {
    this.#fetchClient = fetchClient
  }

  /** GET bounded JSON; existing callers use null to select their fallback. */
  async fetchJson(url, headers) {
    if (this.#closing) return null
    try {
      return await this.#own(this.#readJson(url, headers))
    } catch { return null }
  }

  async #readJson(url, headers) {
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(8000)])
    const response = await this.#fetchClient(url, { signal, headers })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return null
    }
    const parts = []
    let length = 0
    const body = addAbortSignal(signal, Readable.fromWeb(response.body))
    try {
      for await (const chunk of body) {
        signal.throwIfAborted()
        length += chunk.length
        if (length > 2 * 1024 * 1024) throw new Error('INSTALLER_JSON_TOO_LARGE')
        parts.push(chunk)
      }
      signal.throwIfAborted()
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    } finally {
      body.destroy()
      await finished(body).catch(() => {})
    }
  }

  /**
   * Stream into an owned sibling file; publish only after all streams close.
   * The existing destination survives any failed or cancelled download.
   * @param {string} url
   * @param {string} destination
   * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
   */
  downloadFile(url, destination, onProgress) {
    if (this.#closing) return Promise.reject(new Error('INSTALLER_NETWORK_CLOSED'))
    return this.#own(this.#download(url, destination, onProgress))
  }

  async #download(url, destination, onProgress) {
    const temporary = `${destination}.partial-${randomUUID()}`
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(300_000)])
    let response
    let published = false
    try {
      response = await this.#fetchClient(url, { signal })
      signal.throwIfAborted()
      if (response.status !== 200 || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status}`)
      }
      const contentLength = Number(response.headers.get('content-length')) || 0
      if (contentLength > MAX_INSTALLER_BYTES) throw new Error('INSTALLER_DOWNLOAD_TOO_LARGE')
      let downloaded = 0
      const progress = new Transform({ transform(chunk, _encoding, callback) {
        try {
          downloaded += chunk.length
          if (downloaded > MAX_INSTALLER_BYTES) throw new Error('INSTALLER_DOWNLOAD_TOO_LARGE')
          if (contentLength > 0) onProgress({ stage: 'installing',
            output: `Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB\r`,
            percent: Math.min(Math.round(downloaded / contentLength * 60) + 10, 70) })
          callback(null, chunk)
        } catch { callback(new Error('INSTALLER_PROGRESS_FAILED')) }
      } })
      await pipeline(Readable.fromWeb(response.body), progress,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
      signal.throwIfAborted()
      // Atomic publication is the final operation; stop cannot interleave a JS
      // callback between the last admission check and submitting this rename.
      await rename(temporary, destination)
      published = true
    } catch (error) {
      if (signal.aborted) throw new Error('INSTALLER_DOWNLOAD_CANCELLED')
      if (error instanceof Error && /^Download failed: HTTP \d+$/.test(error.message)) throw error
      // Fetch/stream failures can include private URLs or filesystem paths.
      throw new Error('INSTALLER_DOWNLOAD_FAILED')
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      if (!published) await rm(temporary, { force: true }).catch(() => { throw new Error('INSTALLER_DOWNLOAD_CLEANUP_FAILED') })
    }
  }

  stop() {
    this.#closing = true
    this.#shutdown.abort()
  }

  /** Join raw requests/file cleanup, retaining them when the deadline expires. */
  async close(timeoutMs = 2000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Installer network shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.stop()
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('INSTALLER_NETWORK_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try {
      do { await Promise.race([Promise.allSettled([...this.#pending]), expired]) }
      while (this.#pending.size)
    } finally { clearTimeout(timer) }
  }

  #own(work) {
    this.#pending.add(work)
    void work.then(() => this.#pending.delete(work), () => this.#pending.delete(work))
    return work
  }
}
