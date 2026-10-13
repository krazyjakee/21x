/** Portable owner for CLI installer commands; the host supplies its spawn function. */
export class InstallerProcessOwner {
  #spawn
  #closing = false
  /** @type {Map<import('node:child_process').ChildProcess, Promise<unknown>>} */
  #children = new Map()

  /** @param {typeof import('node:child_process').spawn} spawnClient */
  constructor(spawnClient) { this.#spawn = spawnClient }

  /**
   * Never releases an asynchronous spawn/stream error before actual child close.
   * Captured output retains a bounded tail; live progress still streams normally.
   * @param {string} command
   * @param {string[]} args
   * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
   * @param {number} percent
   * @param {import('node:child_process').SpawnOptions} [options]
   * @returns {Promise<{ error: Error | null, code: number | null, stdout: string, stderr: string }>}
   */
  run(command, args, onProgress, percent, options = {}) {
    const empty = { code: null, stdout: '', stderr: '' }
    if (this.#closing) return Promise.resolve({ ...empty, error: new Error('INSTALLER_PROCESS_CLOSED') })
    let process
    try { process = this.#spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options }) }
    catch { return Promise.resolve({ ...empty, error: new Error('INSTALLER_PROCESS_FAILED') }) }
    let stdout = ''
    let stderr = ''
    let error = null
    let resolve
    const work = new Promise(done => { resolve = done })
    this.#children.set(process, work)
    const fail = () => { error ??= new Error('INSTALLER_PROCESS_FAILED') }
    const emit = text => {
      if (this.#closing || error) return
      try { onProgress({ stage: 'installing', output: text, percent }) }
      catch {
        error ??= new Error('INSTALLER_PROGRESS_FAILED')
        try { process.kill() } catch { /* ownership remains until close */ }
      }
    }
    process.stdout?.setEncoding('utf8')
    process.stderr?.setEncoding('utf8')
    process.stdout?.on('data', chunk => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-256 * 1024)
      emit(text)
    })
    process.stderr?.on('data', chunk => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-256 * 1024)
      emit(text)
    })
    process.stdout?.on('error', fail)
    process.stderr?.on('error', fail)
    process.on('error', fail)
    process.once('close', code => {
      this.#children.delete(process)
      resolve({ error: error ?? (this.#closing ? new Error('INSTALLER_PROCESS_CANCELLED') : null), code, stdout, stderr })
    })
    return work
  }

  stop() {
    this.#closing = true
    for (const process of this.#children.keys()) {
      try { process.kill() } catch { /* ownership remains until close */ }
    }
  }

  async close(timeoutMs = 2000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
      throw new RangeError('Installer process shutdown deadline must be an integer from 1 to 3000 ms')
    }
    this.stop()
    let timer
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('INSTALLER_PROCESS_SHUTDOWN_INCOMPLETE')), timeoutMs)
    })
    try {
      do { await Promise.race([Promise.allSettled([...this.#children.values()]), expired]) }
      while (this.#children.size)
    } finally { clearTimeout(timer) }
  }
}
