import { existsSync, readFileSync, statSync } from 'fs'
import { dirname } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeSessionEnvFile, writeSessionEnvFile } from './session-env-file'

describe('session env file', () => {
  const written: string[] = []
  const write = (previous: string | undefined, vars: Record<string, string>) => {
    const path = writeSessionEnvFile(previous, vars)
    written.push(path)
    return path
  }

  afterEach(() => { written.splice(0).forEach(removeSessionEnvFile) })

  it('writes quoted exports a shell can source', () => {
    expect(readFileSync(write(undefined, { TOKEN: "it's" }), 'utf8')).toBe("export TOKEN='it'\\''s'\n")
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const path = write(undefined, { TOKEN: 'x' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  it('updates the same file, so the path given to the CLI stays valid', () => {
    const path = write(undefined, { TOKEN: 'old' })
    expect(write(path, { TOKEN: 'new' })).toBe(path)
    expect(readFileSync(path, 'utf8')).toContain("'new'")
  })

  it('removes the file and its directory', () => {
    const path = write(undefined, { TOKEN: 'x' })
    removeSessionEnvFile(path)
    expect(existsSync(dirname(path))).toBe(false)
  })
})
