import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PI_RTK_EXECUTABLE_ENV, PI_RTK_EXTENSION_SOURCE } from './pi-config'

const FAKE_RTK = `#!/bin/sh
case "$3" in
  "git status"|"rtk git status") echo "rtk git status"; exit 3 ;;
  "ls -la") echo "rtk ls -la"; exit 0 ;;
  "broken") echo "not a command"; exit 2 ;;
  "unrelated") echo "Rust Type Kit: nothing to do"; exit 0 ;;
  "usage") echo "Usage: rtk [OPTIONS] <COMMAND>"; exit 0 ;;
  *) exit 1 ;;
esac
`

/** Loads the source that ships and gives it a `pi` that runs real processes. */
describe.skipIf(process.platform === 'win32')('Pi RTK extension', () => {
  let root: string
  let handler: (event: unknown, ctx: unknown) => Promise<void>
  const originalExecutable = process.env[PI_RTK_EXECUTABLE_ENV]

  const pi = {
    on: (_event: string, listener: typeof handler) => { handler = listener },
    exec: (command: string, args: string[], options: { timeout: number }) => new Promise((resolve, reject) => {
      execFile(command, args, { timeout: options.timeout }, (error, stdout) => {
        if (error && typeof error.code !== 'number') reject(error)
        else resolve({ code: error ? error.code : 0, stdout, killed: false })
      })
    })
  }

  async function run(command: unknown, toolName = 'bash'): Promise<unknown> {
    const event = { toolName, input: { command } }
    await handler(event, { signal: new AbortController().signal })
    return event.input.command
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rtk-pi-'))
    const rtk = join(root, 'rtk')
    writeFileSync(rtk, FAKE_RTK)
    chmodSync(rtk, 0o755)
    process.env[PI_RTK_EXECUTABLE_ENV] = rtk
    const extension = join(root, 'extension.mjs')
    writeFileSync(extension, PI_RTK_EXTENSION_SOURCE)
    const loaded = await import(/* @vite-ignore */ pathToFileURL(extension).href)
    loaded.default(pi)
  })

  afterAll(() => {
    if (originalExecutable === undefined) delete process.env[PI_RTK_EXECUTABLE_ENV]
    else process.env[PI_RTK_EXECUTABLE_ENV] = originalExecutable
    rmSync(root, { recursive: true, force: true })
  })

  it('applies a rewrite on both of the exit codes that carry one', async () => {
    expect(await run('git status')).toBe('rtk git status')
    expect(await run('ls -la')).toBe('rtk ls -la')
  })

  it('leaves a command with no filter alone', async () => {
    expect(await run('npm test')).toBe('npm test')
  })

  it('does not double-wrap', async () => {
    expect(await run('rtk git status')).toBe('rtk git status')
  })

  it('keeps the command when RTK fails', async () => {
    expect(await run('broken')).toBe('broken')
  })

  it('never runs the output of a different program called rtk', async () => {
    expect(await run('unrelated')).toBe('unrelated')
    expect(await run('usage')).toBe('usage')
  })

  it('leaves a command alone when it sets its own PATH', async () => {
    expect(await run('PATH=/usr/bin git status')).toBe('PATH=/usr/bin git status')
  })

  it('ignores other tools and non-text commands', async () => {
    expect(await run('git status', 'read')).toBe('git status')
    expect(await run(undefined)).toBeUndefined()
  })

  it('keeps the command when RTK has disappeared', async () => {
    const executable = process.env[PI_RTK_EXECUTABLE_ENV]
    process.env[PI_RTK_EXECUTABLE_ENV] = join(root, 'missing')
    try {
      expect(await run('git status')).toBe('git status')
    } finally {
      process.env[PI_RTK_EXECUTABLE_ENV] = executable
    }
  })
})
