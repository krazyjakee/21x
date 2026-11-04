import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionConfig } from '../coding-agent-adapter'
import { applyRtkSessionPolicy, findRtkExecutable, rewriteWithRtk } from './rtk-session'

/** Follows the real `rtk rewrite` exit codes, recorded from RTK 0.49.0. */
const FAKE_RTK = `#!/bin/sh
[ "$1" = "rewrite" ] && [ "$2" = "--" ] || exit 64
case "$3" in
  "git status"|"rtk git status") echo "rtk git status"; exit 3 ;;
  "ls -la") echo "rtk ls -la"; exit 0 ;;
  "broken") echo "not a command"; exit 2 ;;
  "empty") exit 0 ;;
  "slow") exec sleep 10 ;;
  *) exit 1 ;;
esac
`

describe.skipIf(process.platform === 'win32')('RTK session support', () => {
  let root: string
  let rtk: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rtk-session-'))
    mkdirSync(join(root, 'bin'))
    rtk = join(root, 'bin', 'rtk')
    writeFileSync(rtk, FAKE_RTK)
    chmodSync(rtk, 0o755)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  describe('rewriteWithRtk', () => {
    it('uses the rewrite for both of the exit codes that carry one', async () => {
      expect(await rewriteWithRtk(rtk, 'git status')).toBe('rtk git status')
      expect(await rewriteWithRtk(rtk, 'ls -la')).toBe('rtk ls -la')
    })

    it('runs a command with no filter unchanged', async () => {
      expect(await rewriteWithRtk(rtk, 'npm test')).toBe('npm test')
    })

    it('does not double-wrap', async () => {
      expect(await rewriteWithRtk(rtk, 'rtk git status')).toBe('rtk git status')
    })

    it('passes a command that looks like a flag as a command', async () => {
      expect(await rewriteWithRtk(rtk, '--version')).toBe('--version')
    })

    it('keeps the command when RTK fails or prints nothing', async () => {
      expect(await rewriteWithRtk(rtk, 'broken')).toBe('broken')
      expect(await rewriteWithRtk(rtk, 'empty')).toBe('empty')
    })

    it('keeps the command when RTK hangs', async () => {
      expect(await rewriteWithRtk(rtk, 'slow')).toBe('slow')
    }, 5000)

    it('keeps the command when RTK has disappeared', async () => {
      expect(await rewriteWithRtk(join(root, 'missing'), 'git status')).toBe('git status')
    })

    it('keeps a command the operating system refuses to pass on', async () => {
      expect(await rewriteWithRtk(rtk, 'git\0status')).toBe('git\0status')
    })

    it('does not start RTK for a blank command', async () => {
      expect(await rewriteWithRtk(join(root, 'missing'), '  ')).toBe('  ')
    })
  })

  describe('findRtkExecutable', () => {
    it('finds RTK on PATH', () => {
      expect(findRtkExecutable({ PATH: ['/nonexistent', join(root, 'bin')].join(delimiter) }, 'linux', '/nonexistent')).toBe(rtk)
    })

    it('finds the installer target when a desktop launch left it off PATH', () => {
      const home = join(root, 'home')
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      const installed = join(home, '.local', 'bin', 'rtk')
      writeFileSync(installed, FAKE_RTK)
      chmodSync(installed, 0o755)
      expect(findRtkExecutable({ PATH: '/nonexistent' }, 'linux', home)).toBe(installed)
    })

    it('returns null when RTK is not installed', () => {
      expect(findRtkExecutable({ PATH: '/nonexistent' }, 'linux', '/nonexistent')).toBeNull()
      expect(findRtkExecutable({}, 'linux', '/nonexistent')).toBeNull()
    })

    it('ignores a file it cannot execute', () => {
      const directory = join(root, 'plain')
      mkdirSync(directory)
      writeFileSync(join(directory, 'rtk'), 'data')
      expect(findRtkExecutable({ PATH: directory }, 'linux', '/nonexistent')).toBeNull()
    })
  })
})

describe('applyRtkSessionPolicy', () => {
  const session = (): SessionConfig => ({ agentId: 'a', taskId: 't', workspaceDir: '/w' })

  it('starts a prompt for a session that had none', () => {
    const config = session()
    applyRtkSessionPolicy(config, 'codex', true, '/opt/bin/rtk')
    expect(config.systemPrompt).toContain('Prefix shell commands with `rtk`')
  })

  it('tells the agent to ignore global RTK instructions after the opt-out', () => {
    const config = session()
    applyRtkSessionPolicy(config, 'claude-code', false, '/opt/bin/rtk')
    expect(config.rtkDisabled).toBe(true)
    expect(config.systemPrompt).toContain('even if other instructions ask for one')
  })
})
