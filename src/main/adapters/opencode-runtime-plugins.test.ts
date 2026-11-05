import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionConfig } from './coding-agent-adapter'
import { writeRuntimePluginFiles } from './opencode-runtime-plugins'

const FAKE_RTK = `#!/bin/sh
case "$3" in
  "git status"|"rtk git status") echo "rtk git status"; exit 3 ;;
  "broken") echo "not a command"; exit 2 ;;
  "where") echo "rtk where $(pwd)"; exit 0 ;;
  "unrelated") echo "Rust Type Kit: nothing to do"; exit 0 ;;
  "usage") echo "Usage: rtk [OPTIONS] <COMMAND>"; exit 0 ;;
  *) exit 1 ;;
esac
`

describe.skipIf(process.platform === 'win32')('OpenCode RTK plugin', () => {
  let root: string
  let workspaceDir: string
  let rtk: string
  const originalPath = process.env.PATH
  const config = (extra: Partial<SessionConfig>): SessionConfig => ({ agentId: 'a', taskId: 't', workspaceDir, tillDone: false, ...extra })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rtk-plugin-'))
    workspaceDir = join(root, 'workspace')
    mkdirSync(workspaceDir)
    // The plugin is ESM, as OpenCode loads it.
    writeFileSync(join(workspaceDir, 'package.json'), '{"type":"module"}')
    rtk = join(root, 'rtk')
    writeFileSync(rtk, FAKE_RTK)
    chmodSync(rtk, 0o755)
    process.env.PATH = [originalPath, root].join(delimiter)
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  })

  const noRules = { config: { get: async () => ({ data: { permission: { bash: 'allow' } } }) } }

  async function runPlugin(path: string, tool: string, command: unknown, client: unknown = noRules): Promise<unknown> {
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path).href)
    const hooks = await plugin.RtkRewriter({ client })
    const output = { args: { command } }
    await hooks['tool.execute.before']({ tool }, output)
    return output.args.command
  }

  it('is absent without an RTK executable', () => {
    const files = writeRuntimePluginFiles(config({}))
    expect(files.pluginFilePaths).toEqual([])
  })

  it('is declared to OpenCode', () => {
    const files = writeRuntimePluginFiles(config({ rtkExecutable: rtk, tillDone: true }))
    expect(files.pluginFilePaths[0]).toMatch(/20x-rtk\.js$/)
    const declared = JSON.parse(readFileSync(join(workspaceDir, '.opencode', 'opencode.json'), 'utf8'))
    expect(declared.plugin).toEqual(files.pluginFilePaths)
  })

  it('carries the limits on RTK with the secrets, because the server is shared', () => {
    writeRuntimePluginFiles(config({ secretEnvVars: { TOKEN: 'x' }, rtkEnv: { RTK_DB_PATH: '/dev/null' } }))
    const exports = readFileSync(join(workspaceDir, '.opencode', '.20x-secrets'), 'utf8')
    expect(exports).toContain("export RTK_DB_PATH='/dev/null'")
    expect(exports).toContain("export TOKEN='x'")
  })

  it('removes the plugin once RTK is turned off', () => {
    const [path] = writeRuntimePluginFiles(config({ rtkExecutable: rtk })).pluginFilePaths
    expect(existsSync(path)).toBe(true)
    writeRuntimePluginFiles(config({}))
    expect(existsSync(path)).toBe(false)
  })

  describe('at run time', () => {
    let plugin: string
    beforeEach(() => { [plugin] = writeRuntimePluginFiles(config({ rtkExecutable: rtk })).pluginFilePaths })

    it('rewrites a bash command RTK has a filter for', async () => {
      expect(await runPlugin(plugin, 'bash', 'git status')).toBe('rtk git status')
    })

    it('leaves a command with no filter alone', async () => {
      expect(await runPlugin(plugin, 'bash', 'npm test')).toBe('npm test')
    })

    it('does not double-wrap', async () => {
      expect(await runPlugin(plugin, 'bash', 'rtk git status')).toBe('rtk git status')
    })

    it('keeps the command when RTK fails', async () => {
      expect(await runPlugin(plugin, 'bash', 'broken')).toBe('broken')
    })

    it('ignores other tools', async () => {
      expect(await runPlugin(plugin, 'read', 'git status')).toBe('git status')
    })

    it('runs RTK from the workspace, where project deny rules are read', async () => {
      expect(await runPlugin(plugin, 'bash', 'where')).toBe(`rtk where ${resolve(workspaceDir)}`)
    })

    it('leaves a command alone when it sets its own PATH', async () => {
      expect(await runPlugin(plugin, 'bash', 'PATH=/usr/bin git status')).toBe('PATH=/usr/bin git status')
    })

    it('does not rewrite when a bare rtk would not resolve in the server', async () => {
      process.env.PATH = originalPath
      expect(await runPlugin(plugin, 'bash', 'git status')).toBe('git status')
    })

    it('never runs the output of a different program called rtk', async () => {
      expect(await runPlugin(plugin, 'bash', 'unrelated')).toBe('unrelated')
      expect(await runPlugin(plugin, 'bash', 'usage')).toBe('usage')
    })

    // OpenCode checks permission rules after this hook, so a rewrite would bypass them.
    it.each([
      'git status',
      'FOO=1 git status',
      'timeout 5 git status',
      'command git status',
      'env git status',
      'nice git status',
      'nohup git status',
    ])('does not rewrite %s while any deny rule exists', async (command) => {
      const denied = { config: { get: async () => ({ data: { permission: { bash: { '*': 'allow', 'git push*': 'deny' } } } }) } }
      expect(await runPlugin(plugin, 'bash', command, denied)).toBe(command)
    })

    it('finds a deny rule set on an agent', async () => {
      const denied = { config: { get: async () => ({ data: { agent: { build: { permission: { bash: 'deny' } } } } }) } }
      expect(await runPlugin(plugin, 'bash', 'git status', denied)).toBe('git status')
    })

    it('does not rewrite when the rules cannot be read', async () => {
      const failing = { config: { get: async () => { throw new Error('offline') } } }
      const empty = { config: { get: async () => ({}) } }
      expect(await runPlugin(plugin, 'bash', 'git status', failing)).toBe('git status')
      expect(await runPlugin(plugin, 'bash', 'git status', empty)).toBe('git status')
    })

    it('does not rewrite when reading the rules hangs', async () => {
      const hanging = { config: { get: () => new Promise(() => undefined) } }
      expect(await runPlugin(plugin, 'bash', 'git status', hanging)).toBe('git status')
    }, 5000)

    it('keeps the command when RTK has disappeared', async () => {
      rmSync(rtk)
      expect(await runPlugin(plugin, 'bash', 'git status')).toBe('git status')
    })
  })
})
