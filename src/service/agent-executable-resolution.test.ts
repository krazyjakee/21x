import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findExecutable } from '../main/find-executable'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe.skipIf(process.platform !== 'linux')('CLI discovery without a system lookup utility', () => {
  it('finds an executable in an explicit PATH directory without executing it or requiring which/node', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-cli-resolution-')); roots.push(root)
    const executable = join(root, 'codex'), marker = join(root, 'must-not-run')
    writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
    vi.stubEnv('PATH', root)
    expect(await findExecutable('codex')).toBe(executable)
    expect(existsSync(marker)).toBe(false)
  })
  it('ignores directories, nonexecutable candidates and empty/relative PATH entries before explicit fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), '21x-cli-resolution-')); roots.push(root)
    const first = join(root, 'first'), second = join(root, 'second')
    mkdirSync(first); mkdirSync(second); mkdirSync(join(first, 'pi'))
    writeFileSync(join(second, 'pi'), 'synthetic', { mode: 0o600 })
    const fallback = join(root, 'fallback'); writeFileSync(fallback, 'synthetic', { mode: 0o700 })
    vi.stubEnv('PATH', `.:${first}::${second}`)
    expect(await findExecutable('pi', [fallback])).toBe(fallback)
    expect(await findExecutable('nonexistent-211')).toBeNull()
  })
})
