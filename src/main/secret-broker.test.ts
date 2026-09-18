import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DatabaseManager } from './database'
import {
  buildWindowsSecretShellScript,
  registerSecretSession,
  startSecretBroker,
  stopSecretBroker,
  unregisterSecretSession,
  writeSecretShellWrapper
} from './secret-broker'

interface FakeSecret {
  id: string
  env_var_name: string
  value: string
}

const SECRETS: FakeSecret[] = [
  { id: 's1', env_var_name: 'API_KEY', value: "it's $(echo injected) `id` \"quoted\"\nsecond line" },
  { id: 's2', env_var_name: 'OTHER_KEY', value: 'belongs-to-another-session' },
  { id: 's3', env_var_name: 'BAD; echo injected #', value: 'x' }
]

const fakeDb = {
  getSecretsWithValues: (ids: string[]) => SECRETS.filter((secret) => ids.includes(secret.id))
} as unknown as DatabaseManager

async function fetchExports(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/secrets/export?token=${token}`)
}

describe('secret broker', () => {
  afterEach(() => stopSecretBroker())

  it('rejects missing, unknown and unregistered tokens', async () => {
    const port = await startSecretBroker(fakeDb)
    registerSecretSession('token-a', 'agent-a', ['s1'])

    expect((await fetch(`http://127.0.0.1:${port}/secrets/export`)).status).toBe(403)
    expect((await fetchExports(port, 'unknown')).status).toBe(403)

    unregisterSecretSession('token-a')
    expect((await fetchExports(port, 'token-a')).status).toBe(403)
  })

  it('returns only the secrets registered for the session token', async () => {
    const port = await startSecretBroker(fakeDb)
    registerSecretSession('token-a', 'agent-a', ['s1'])
    registerSecretSession('token-b', 'agent-b', ['s2'])

    const body = await (await fetchExports(port, 'token-a')).text()

    expect(body).toContain('export API_KEY=')
    expect(body).not.toContain('OTHER_KEY')
  })

  it('never emits a secret whose name is not a shell identifier', async () => {
    const port = await startSecretBroker(fakeDb)
    registerSecretSession('token-a', 'agent-a', ['s1', 's3'])

    const body = await (await fetchExports(port, 'token-a')).text()

    expect(body).not.toContain('BAD')
    expect(body.split('\n').filter((line) => line.startsWith('export '))).toHaveLength(1)
  })
})

describe.skipIf(process.platform === 'win32')('secret shell wrapper', () => {
  const debugLog = join(app.getPath('userData'), 'secret-shell-debug.log')

  function runWrapper(command: string, env: Record<string, string>): Promise<string> {
    const wrapper = writeSecretShellWrapper()
    return new Promise((resolve, reject) => {
      // Not execFileSync: that would block the event loop the broker runs on.
      execFile(
        wrapper,
        ['-c', command],
        { env: { ...process.env, _20X_REAL_SHELL: '/bin/bash', ...env } },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
    })
  }

  beforeAll(() => {
    mkdirSync(app.getPath('userData'), { recursive: true })
  })

  beforeEach(() => rmSync(debugLog, { force: true }))

  afterEach(() => stopSecretBroker())

  it('exports the exact secret value into the command environment without evaluating it', async () => {
    const port = await startSecretBroker(fakeDb)
    registerSecretSession('token-a', 'agent-a', ['s1'])

    const output = await runWrapper('printf %s "$API_KEY"; printf "|%s" "${_20X_SB_TOKEN:-unset}"', {
      _20X_SB_PORT: String(port),
      _20X_SB_TOKEN: 'token-a'
    })

    expect(output).toBe(`${SECRETS[0].value}|unset`)
  })

  it('keeps the response off disk and the command out of the debug log', async () => {
    const port = await startSecretBroker(fakeDb)
    registerSecretSession('token-a', 'agent-a', ['s1'])

    await runWrapper('echo command-marker >/dev/null', { _20X_SB_PORT: String(port), _20X_SB_TOKEN: 'token-a' })

    expect(existsSync('/tmp/_20x_secrets_body')).toBe(false)
    const log = readFileSync(debugLog, 'utf8')
    expect(log).toContain('body_len=')
    expect(log).not.toContain('command-marker')
  })

  it('runs the command without secrets when the broker refuses the token', async () => {
    const port = await startSecretBroker(fakeDb)

    const output = await runWrapper('printf %s "${API_KEY:-none}"', {
      _20X_SB_PORT: String(port),
      _20X_SB_TOKEN: 'unregistered'
    })

    expect(output).toBe('none')
  })
})

describe('buildWindowsSecretShellScript', () => {
  it('fetches secrets from the local broker via Invoke-WebRequest', () => {
    const script = buildWindowsSecretShellScript('C:\\Users\\test\\AppData\\Roaming\\21x\\secret-shell-debug.log')

    expect(script).toContain('Invoke-WebRequest')
    expect(script).toContain('/secrets/export?token=')
    expect(script).toContain('$env:_20X_SB_PORT')
    expect(script).toContain('$env:_20X_SB_TOKEN')
  })

  it('parses bash-style export lines into environment variables', () => {
    const script = buildWindowsSecretShellScript('C:\\logs\\debug.log')

    expect(script).toContain('^export\\s+([^=]+)=(.*)$')
    expect(script).toContain('[Environment]::SetEnvironmentVariable')
  })

  it('escapes backslashes in the debug log path', () => {
    const script = buildWindowsSecretShellScript('C:\\Users\\test\\debug.log')

    expect(script).toContain('C:\\\\Users\\\\test\\\\debug.log')
  })

  it('clears broker env vars after fetching secrets', () => {
    const script = buildWindowsSecretShellScript('C:\\logs\\debug.log')

    expect(script).toContain('Remove-Item Env:\\_20X_SB_PORT')
    expect(script).toContain('Remove-Item Env:\\_20X_SB_TOKEN')
    expect(script).toContain('Remove-Item Env:\\_20X_REAL_SHELL')
  })
})
