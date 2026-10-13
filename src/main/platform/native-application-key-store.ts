import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { ProtectedApplicationKeyStore } from './authenticated-secret-storage'

export class NativeApplicationKeyStoreError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'NativeApplicationKeyStoreError'
  }
}

const SAFE_ERRORS = new Set(['KEYSTORE_NO_ENTRY', 'KEYSTORE_NO_ACCESS', 'KEYSTORE_ALREADY_EXISTS', 'KEYSTORE_INVALID_DATA', 'KEYSTORE_UNSUPPORTED', 'KEYSTORE_PROTOCOL_ERROR'])
const BACKENDS = new Set(['linux-secret-service', 'macos-keychain', 'windows-credential-store'])

export function nativeCredentialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) if (source[name] !== undefined) env[name] = source[name]
  return env
}

/**
 * Trusted-bootstrap only. Launch a trusted absolute helper path using private
 * anonymous pipes. Keys never enter argv/environment/files/logs/renderer APIs.
 * The host must select/package this executable, not accept it from UI input.
 */
export class NativeApplicationKeyStore implements ProtectedApplicationKeyStore {
  constructor(private readonly helperPath: string, private readonly timeoutMs = 15_000) {
    if (!isAbsolute(helperPath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new NativeApplicationKeyStoreError('KEYSTORE_PROTOCOL_ERROR')
  }

  private request(operation: 'load' | 'create' | 'delete-fixture', profileId: string, key?: Buffer): Promise<{ backend: string; key?: string }> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profileId) || key && (!Buffer.isBuffer(key) || key.length !== 32)) throw new NativeApplicationKeyStoreError('KEYSTORE_PROTOCOL_ERROR')
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: nativeCredentialEnvironment(process.env) })
      const chunks: Buffer[] = []
      let bytes = 0
      let settled = false
      let failure: string | undefined
      const finish = (error?: string, response?: { backend: string; key?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdin.destroy()
        child.stdout.destroy()
        for (const chunk of chunks) chunk.fill(0)
        if (error) reject(new NativeApplicationKeyStoreError(error))
        else resolve(response!)
      }
      // A deadline rejects acceptance, but never releases raw ownership before
      // Node observes the helper's pipes/process closing. ProductionOwner must
      // retain its bootstrap/profile lease if a helper refuses termination.
      const failAfterClose = (code: string): void => {
        if (settled || failure) return
        failure = code
        clearTimeout(timer)
        for (const chunk of chunks) chunk.fill(0)
        child.stdin.destroy()
        child.kill()
      }
      const timer = setTimeout(() => failAfterClose('KEYSTORE_NO_ACCESS'), this.timeoutMs)
      child.on('error', () => failAfterClose('KEYSTORE_NO_ACCESS'))
      child.stdin.on('error', () => failAfterClose('KEYSTORE_NO_ACCESS'))
      child.stdout.on('error', () => failAfterClose('KEYSTORE_NO_ACCESS'))
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) { chunk.fill(0); return }
        bytes += chunk.length
        if (bytes > 4096) { chunk.fill(0); failAfterClose('KEYSTORE_PROTOCOL_ERROR'); return }
        chunks.push(chunk)
      })
      child.on('close', (code) => {
        if (settled) return
        if (failure) { finish(failure); return }
        const raw = Buffer.concat(chunks)
        try {
          const response = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
          if (response.version !== 1 || typeof response.ok !== 'boolean') { finish('KEYSTORE_PROTOCOL_ERROR'); return }
          if (!response.ok) { finish(typeof response.code === 'string' && SAFE_ERRORS.has(response.code) ? response.code : 'KEYSTORE_PROTOCOL_ERROR'); return }
          if (code !== 0 || typeof response.backend !== 'string' || !BACKENDS.has(response.backend)) { finish('KEYSTORE_PROTOCOL_ERROR'); return }
          if (operation === 'load' && (typeof response.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(response.key))) { finish('KEYSTORE_INVALID_DATA'); return }
          finish(undefined, { backend: response.backend, key: operation === 'load' ? response.key as string : undefined })
        } catch { finish('KEYSTORE_PROTOCOL_ERROR') }
        finally { raw.fill(0) }
      })
      // Only this private pipe contains key material; no shell is involved.
      child.stdin.end(JSON.stringify({ version: 1, operation, account: profileId, ...(key ? { key: key.toString('base64') } : {}) }))
    })
  }

  async load(profileId: string): Promise<Buffer> {
    const response = await this.request('load', profileId)
    const key = Buffer.from(response.key!, 'base64')
    if (key.length !== 32 || key.toString('base64') !== response.key) { key.fill(0); throw new NativeApplicationKeyStoreError('KEYSTORE_INVALID_DATA') }
    return key
  }

  async create(profileId: string, key: Buffer): Promise<void> {
    await this.request('create', profileId, key)
  }

  /** Proof cleanup only; the native helper independently enforces the t03- prefix. */
  async deleteFixture(profileId: string): Promise<void> {
    await this.request('delete-fixture', profileId)
  }

  async backend(profileId: string): Promise<string> {
    const result = await this.request('load', profileId)
    return result.backend
  }
}
