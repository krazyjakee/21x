import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertClaudeSupportsSecrets } from './claude-code-executable'

describe.skipIf(process.platform === 'win32')('assertClaudeSupportsSecrets', () => {
  let root: string
  const claude = (name: string, script: string) => {
    const path = join(root, name)
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }

  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'claude-version-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('accepts versions that source CLAUDE_ENV_FILE', async () => {
    await expect(assertClaudeSupportsSecrets(claude('current', 'echo "2.1.317 (Claude Code)"'))).resolves.toBeUndefined()
    await expect(assertClaudeSupportsSecrets(claude('floor', 'echo "2.0.60 (Claude Code)"'))).resolves.toBeUndefined()
  })

  it('refuses a version that would leave secrets empty', async () => {
    await expect(assertClaudeSupportsSecrets(claude('old', 'echo "2.0.20 (Claude Code)"'))).rejects.toThrow('need Claude Code 2.0.60 or newer. Found 2.0.20')
  })

  it('refuses to start without curl or base64, which would leave secrets empty', async () => {
    const original = process.env.PATH
    const current = claude('current2', 'echo "2.1.317 (Claude Code)"')
    claude('sh', 'exec /bin/sh "$@"')
    process.env.PATH = root
    try {
      await expect(assertClaudeSupportsSecrets(current)).rejects.toThrow('need curl and base64')
    } finally {
      process.env.PATH = original
    }
  })

  it('lets a session start when the version cannot be read', async () => {
    await expect(assertClaudeSupportsSecrets(claude('broken', 'exit 1'))).resolves.toBeUndefined()
    await expect(assertClaudeSupportsSecrets(join(root, 'missing'))).resolves.toBeUndefined()
  })
})
