import { existsSync, readFileSync, statSync } from 'fs'
import { dirname } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeSessionEnvFile, writeSessionEnvFile } from './session-env-file'

describe('session env file', () => {
  const written: string[] = []
  const write = (previous: string | undefined, port: number, token: string) => {
    const path = writeSessionEnvFile(previous, port, token)
    written.push(path)
    return path
  }

  afterEach(() => { written.splice(0).forEach(removeSessionEnvFile) })

  it('fetches secrets from the broker rather than holding them', () => {
    expect(readFileSync(write(undefined, 4321, 'session-token'), 'utf8'))
      .toBe(`eval "$(curl -sf --max-time 5 'http://127.0.0.1:4321/secrets/export?token=session-token' 2>/dev/null)"\n`)
  })

  it('cannot be broken out of by an odd token', () => {
    expect(readFileSync(write(undefined, 4321, "a'b c"), 'utf8')).toContain('token=a%27b%20c')
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const path = write(undefined, 4321, 'session-token')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  it('updates the same file, so the path given to the CLI stays valid', () => {
    const path = write(undefined, 4321, 'old')
    expect(write(path, 4321, 'new')).toBe(path)
    expect(readFileSync(path, 'utf8')).toContain('token=new')
  })

  it('removes the file and its directory', () => {
    const path = write(undefined, 4321, 'session-token')
    removeSessionEnvFile(path)
    expect(existsSync(dirname(path))).toBe(false)
  })
})
