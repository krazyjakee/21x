import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretBroker, type SecretBrokerSource } from './secret-broker-core'
import { writeSecretShellWrapper } from './secret-shell'

const run = promisify(execFile)
const fixtureValue = "fixture ' $(not-evaluated) `literal`\nsecond line"

describe('portable secret wrapper in the owning profile', () => {
  let root: string, profile: string, fixture: string, broker: SecretBroker
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '21x-portable-shell-'))
    profile = join(root, "profile ' $fixture [literal]")
    mkdirSync(profile)
    fixture = join(root, 'command.cjs')
    writeFileSync(fixture, 'process.stdout.write(JSON.stringify({ value: process.env.FIXTURE_SECRET, token: process.env._20X_SB_TOKEN, shell: process.env._20X_REAL_SHELL }))')
    broker = new SecretBroker({ getSecretsWithValues: () => [{ id: 'a', env_var_name: 'FIXTURE_SECRET', value: fixtureValue }] } as unknown as SecretBrokerSource)
  })
  afterEach(async () => { await broker.close(); rmSync(root, { recursive: true, force: true }) })

  async function command(env: Record<string, string>): Promise<string> {
    const wrapper = writeSecretShellWrapper(profile)
    const executable = process.platform === 'win32' ? 'powershell.exe' : wrapper
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, process.execPath, fixture]
      : ['-c', 'exec "$1" "$2"', 'fixture', process.execPath, fixture]
    const { stdout } = await run(executable, args, {
      env: { ...process.env, FIXTURE_SECRET: undefined, _20X_REAL_SHELL: '/bin/bash', ...env }, timeout: 10_000
    })
    return stdout
  }

  it('preserves a multiline secret and quotes the profile path without logging credentials', async () => {
    const port = await broker.start()
    broker.register('fixture-token', 'agent', ['a'])
    const output = await command({ _20X_SB_PORT: String(port), _20X_SB_TOKEN: 'fixture-token' })
    expect(JSON.parse(output)).toEqual({ value: fixtureValue })
    const log = readFileSync(join(profile, 'secret-shell-debug.log'), 'utf8')
    expect(log).toContain('body_len=')
    expect(log).not.toContain('fixture-token')
    expect(log).not.toContain(fixtureValue)
  }, 15_000)

  it('redacts a refused request and clears incomplete credentials before executing commands', async () => {
    const port = await broker.start()
    expect(JSON.parse(await command({ _20X_SB_PORT: String(port), _20X_SB_TOKEN: 'refused-fixture-token' }))).toEqual({})
    expect(readFileSync(join(profile, 'secret-shell-debug.log'), 'utf8')).not.toContain('refused-fixture-token')
    expect(JSON.parse(await command({ _20X_SB_PORT: '', _20X_SB_TOKEN: 'incomplete-fixture-token' }))).toEqual({})
  }, 15_000)
})
