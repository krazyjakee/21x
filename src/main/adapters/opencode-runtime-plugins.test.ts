import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionConfig } from './coding-agent-adapter'
import { writeRuntimePluginFiles } from './opencode-runtime-plugins'

const FAKE_RTK = `#!/bin/sh
case "$3" in
  "git status"|"rtk git status") echo "rtk git status"; exit 3 ;;
  "broken") echo "not a command"; exit 2 ;;
  *) exit 1 ;;
esac
`

describe.skipIf(process.platform === 'win32')('OpenCode RTK plugin', () => {
  let root: string
  let workspaceDir: string
  let rtk: string
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
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function runPlugin(path: string, tool: string, command: unknown): Promise<unknown> {
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path).href)
    const hooks = await plugin.RtkRewriter()
    const output = { args: { command } }
    await hooks['tool.execute.before']({ tool }, output)
    return output.args.command
  }

  it('is absent without an RTK executable', () => {
    const files = writeRuntimePluginFiles(config({}))
    expect(files.pluginFilePaths).toEqual([])
  })

  it('runs before the secret injector and is declared to OpenCode', () => {
    const files = writeRuntimePluginFiles(config({ rtkExecutable: rtk, tillDone: true, secretEnvVars: { TOKEN: 'x' } }))
    expect(files.pluginFilePaths[0]).toMatch(/20x-rtk\.js$/)
    expect(files.pluginFilePaths.at(-1)).toMatch(/20x-secret-injector\.js$/)
    const declared = JSON.parse(readFileSync(join(workspaceDir, '.opencode', 'opencode.json'), 'utf8'))
    expect(declared.plugin).toEqual(files.pluginFilePaths)
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

    it('never gives RTK a command that may already hold secrets', async () => {
      const command = "export TOKEN='x'\ngit status"
      expect(await runPlugin(plugin, 'bash', command)).toBe(command)
    })

    it('keeps the command when RTK has disappeared', async () => {
      rmSync(rtk)
      expect(await runPlugin(plugin, 'bash', 'git status')).toBe('git status')
    })
  })
})
