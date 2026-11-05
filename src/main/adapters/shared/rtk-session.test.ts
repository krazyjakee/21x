import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionConfig } from '../coding-agent-adapter'
import { applyRtkSessionPolicy, findRtkExecutable, PATH_ASSIGNMENT, rewriteWithRtk, rtkProcessEnv } from './rtk-session'

/** Follows the real `rtk rewrite` exit codes, recorded from RTK 0.49.0. */
const FAKE_RTK = `#!/bin/sh
[ "$1" = "rewrite" ] && [ "$2" = "--" ] || exit 64
case "$3" in
  "git status"|"rtk git status") echo "rtk git status"; exit 3 ;;
  "ls -la") echo "rtk ls -la"; exit 0 ;;
  "broken") echo "not a command"; exit 2 ;;
  "empty") exit 0 ;;
  "slow") exec sleep 10 ;;
  "where") echo "rtk where $(pwd)"; exit 0 ;;
  *) exit 1 ;;
esac
`

describe.skipIf(process.platform === 'win32')('RTK session support', () => {
  let root: string
  let rtk: string
  const rewrite = (command: string, executable = rtk) => rewriteWithRtk(executable, command, root)

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
      expect(await rewrite('git status')).toBe('rtk git status')
      expect(await rewrite('ls -la')).toBe('rtk ls -la')
    })

    it('runs a command with no filter unchanged', async () => {
      expect(await rewrite('npm test')).toBe('npm test')
    })

    it('does not double-wrap', async () => {
      expect(await rewrite('rtk git status')).toBe('rtk git status')
    })

    it('passes a command that looks like a flag as a command', async () => {
      expect(await rewrite('--version')).toBe('--version')
    })

    it('keeps the command when RTK fails or prints nothing', async () => {
      expect(await rewrite('broken')).toBe('broken')
      expect(await rewrite('empty')).toBe('empty')
    })

    it('keeps the command when RTK hangs', async () => {
      expect(await rewrite('slow')).toBe('slow')
    }, 5000)

    it('keeps the command when RTK has disappeared', async () => {
      expect(await rewrite('git status', join(root, 'missing'))).toBe('git status')
    })

    it('keeps a command the operating system refuses to pass on', async () => {
      expect(await rewrite('git\0status')).toBe('git\0status')
    })

    it('runs RTK from the session directory, where project deny rules are read', async () => {
      const project = join(root, 'project')
      mkdirSync(project)
      expect(await rewriteWithRtk(rtk, 'where', project)).toBe(`rtk where ${resolve(project)}`)
    })

    it('leaves a command alone when it sets its own PATH, which might not hold rtk', async () => {
      for (const command of ['PATH=/usr/bin git status', 'export PATH=/usr/bin; git status', 'cd x && PATH=/usr/bin git status', 'PATH+=:/x git status']) {
        expect(PATH_ASSIGNMENT.test(command)).toBe(true)
        expect(await rewrite(command)).toBe(command)
      }
    })

    it('does not mistake another variable for PATH', () => {
      expect(PATH_ASSIGNMENT.test('MY_PATH=x git status')).toBe(false)
      expect(PATH_ASSIGNMENT.test('git log -- PATH')).toBe(false)
    })

    it('does not start RTK for a blank command', async () => {
      expect(await rewrite('  ', join(root, 'missing'))).toBe('  ')
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

    it('ignores a relative PATH entry, which would resolve inside the open repository', () => {
      const cwd = process.cwd()
      process.chdir(root)
      try {
        expect(findRtkExecutable({ PATH: 'bin' }, 'linux', '/nonexistent')).toBeNull()
      } finally {
        process.chdir(cwd)
      }
    })

    it('ignores a file it cannot execute', () => {
      const directory = join(root, 'plain')
      mkdirSync(directory)
      writeFileSync(join(directory, 'rtk'), 'data')
      expect(findRtkExecutable({ PATH: directory }, 'linux', '/nonexistent')).toBeNull()
    })
  })
})

describe('rtkProcessEnv', () => {
  it('adds RTK to the end of PATH when it is missing, so nothing else resolves differently', () => {
    const env = rtkProcessEnv({ rtkExecutable: join('/opt', 'rtk') }, { PATH: ['/usr/bin', '/bin'].join(delimiter) })
    expect(env.PATH).toBe(['/usr/bin', '/bin', '/opt'].join(delimiter))
  })

  it('leaves PATH alone when RTK is already on it', () => {
    expect(rtkProcessEnv({ rtkExecutable: join('/opt', 'rtk') }, { PATH: '/opt' })).toEqual({})
  })

  it('keeps the spelling of the PATH variable', () => {
    const env = rtkProcessEnv({ rtkExecutable: join('/opt', 'rtk') }, { Path: '/usr/bin' })
    expect(env.Path).toBe(['/usr/bin', '/opt'].join(delimiter))
    expect(env.PATH).toBeUndefined()
  })

  it('copes with an empty PATH', () => {
    expect(rtkProcessEnv({ rtkExecutable: join('/opt', 'rtk') }, {}).PATH).toBe('/opt')
  })

  it('passes the session limits through', () => {
    expect(rtkProcessEnv({ rtkEnv: { RTK_DISABLED: '1' } }, { PATH: '/usr/bin' })).toEqual({ RTK_DISABLED: '1' })
  })

  it('adds nothing for a session without RTK', () => {
    expect(rtkProcessEnv({}, { PATH: '/usr/bin' })).toEqual({})
  })
})

describe('applyRtkSessionPolicy', () => {
  const session = (): SessionConfig => ({ agentId: 'a', taskId: 't', workspaceDir: '/w' })

  it('starts a prompt for a session that had none', () => {
    const config = session()
    applyRtkSessionPolicy(config, 'codex', true, '/opt/bin/rtk', false)
    expect(config.systemPrompt).toContain('Prefix shell commands with `rtk`')
  })

  it('tells the agent to ignore global RTK instructions after the opt-out', () => {
    const config = session()
    applyRtkSessionPolicy(config, 'claude-code', false, '/opt/bin/rtk', false)
    expect(config.rtkEnv).toEqual({ RTK_DISABLED: '1' })
    expect(config.systemPrompt).toContain('even if other instructions ask for one')
  })

  it('puts secrets ahead of the preference', () => {
    const config = session()
    applyRtkSessionPolicy(config, 'claude-code', true, '/opt/bin/rtk', true)
    expect(config.rtkExecutable).toBeUndefined()
    expect(config.rtkEnv).toMatchObject({ RTK_RECALL: '0', RTK_TEE: '0' })
  })
})
