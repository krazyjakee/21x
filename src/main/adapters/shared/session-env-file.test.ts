import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
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

  it('asks only the broker, ignoring proxies and curlrc', () => {
    const script = readFileSync(write(undefined, 4321, 'session-token'), 'utf8')
    expect(script).toContain("curl -q --noproxy '*' -sf --max-time 5 -K ")
  })

  it('keeps the token out of the script, and so out of process arguments', () => {
    const path = write(undefined, 4321, 'session-token')
    expect(readFileSync(path, 'utf8')).not.toContain('session-token')
    expect(readFileSync(join(dirname(path), 'curl.conf'), 'utf8'))
      .toBe('url = "http://127.0.0.1:4321/secrets/export?format=base64&token=session-token"\n')
  })

  it('never evaluates the response', () => {
    expect(readFileSync(write(undefined, 4321, 'session-token'), 'utf8')).not.toMatch(/\beval\b/)
  })

  it('cannot be broken out of by an odd token', () => {
    const path = write(undefined, 4321, "a'b\"c")
    expect(readFileSync(join(dirname(path), 'curl.conf'), 'utf8')).toContain('token=a\'b%22c')
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const path = write(undefined, 4321, 'session-token')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dirname(path), 'curl.conf')).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  it('updates the same files, so the path given to the CLI stays valid', () => {
    const path = write(undefined, 4321, 'old')
    expect(write(path, 4321, 'new')).toBe(path)
    expect(readFileSync(join(dirname(path), 'curl.conf'), 'utf8')).toContain('token=new')
  })

  it('removes the file and its directory', () => {
    const path = write(undefined, 4321, 'session-token')
    removeSessionEnvFile(path)
    expect(existsSync(dirname(path))).toBe(false)
  })
})
