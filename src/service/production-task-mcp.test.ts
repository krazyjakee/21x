import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { startTaskApiServer, closeTaskApiServer, getTaskApiToken } from '../main/task-api-server-core'
import { buildTaskMcpUrl } from '../main/task-mcp-endpoint'
import { browserTools } from '../main/mcp-servers/task-management-tools'
import { listRegisteredTaskArtifacts } from '../main/artifacts'

describe.skipIf(!!process.versions.electron)('actual bundled Node production task stdio', () => {
  let root: string, entry: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), '21x-task-stdio-'))
    const repository = fileURLToPath(new URL('../../', import.meta.url))
    if (process.env.TAURI_PRODUCTION_TASK_MCP_ENTRY) {
      entry = await realpath(process.env.TAURI_PRODUCTION_TASK_MCP_ENTRY)
      expect(entry).toBe(await realpath(join(repository, 'src-tauri/resources/service/production-task-mcp.mjs')))
      return
    }
    entry = join(root, 'production-task-mcp.mjs')
    // Same pure-Node bundle boundary as production staging: no package or
    // Electron imports, and a physical ESM entry launched with empty PATH.
    const result = await build({ configFile: false, root: repository, logLevel: 'silent',
      build: { ssr: fileURLToPath(new URL('./production-task-mcp.ts', import.meta.url)), target: 'node22', write: false, minify: false,
        rollupOptions: { external: isBuiltin, output: { format: 'es', inlineDynamicImports: true } } }, ssr: { noExternal: true } })
    if (!Array.isArray(result) && !('output' in result)) throw new Error('Unexpected watched production bundle')
    const chunks = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]
    if (chunk.type !== 'chunk') throw new Error('Expected one production stdio module')
    expect(chunk.imports.every(isBuiltin)).toBe(true)
    await writeFile(entry, chunk.code, { mode: 0o600 })
  }, 30_000)
  afterAll(async () => { await closeTaskApiServer(); if (root) await rm(root, { recursive: true, force: true }) })

  it('preserves actual token/project/artifact scopes through the standalone child and never advertises or executes browser tools', async () => {
    const db = createPortableTestDb()
    const a = db.createProject({ name: 'Stdio project A' })!, b = db.createProject({ name: 'Stdio project B' })!
    const mine = db.createTask({ title: 'Own stdio task', project_id: a.id })!, foreign = db.createTask({ title: 'Foreign stdio task', project_id: b.id })!
    await mkdir(db.getWorkspaceDir(mine.id), { recursive: true })
    await mkdir(db.getWorkspaceDir(foreign.id), { recursive: true })
    const port = await startTaskApiServer(db), api = `http://127.0.0.1:${port}`
    const url = buildTaskMcpUrl(port, getTaskApiToken(), { projectId: a.id, taskId: mine.id, artifactTaskId: mine.id })
    const env = { PATH: '', HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), TASK_API_URL: api, TASK_MCP_URL: url,
      // These untrusted legacy pins must never replace the signed authority.
      TASK_SCOPE_PROJECT_ID: b.id, TASK_ARTIFACT_SCOPE_ID: foreign.id }
    const clients: Client[] = []
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { PATH: '' }, stdio: 'ignore' })
    const unrelatedClosed = new Promise<void>(resolve => unrelated.once('close', () => resolve()))
    const connect = async (signed: string, extra: Record<string, string> = {}) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, env: { ...env, TASK_MCP_URL: signed, ...extra }, stderr: 'pipe' })
      let diagnostics = ''
      const client = new Client({ name: 'production-stdio-fixture', version: '1.0.0' }); clients.push(client)
      await client.connect(transport)
      transport.stderr?.on('data', chunk => { diagnostics += String(chunk) })
      return { client, transport, diagnostics: () => diagnostics }
    }
    try {
      const actual = await connect(url)
      const list = await actual.client.listTools()
      expect(list.tools.some(tool => tool.name === 'list_tasks')).toBe(true)
      expect(list.tools.some(tool => browserTools.some(browser => browser.name === tool.name))).toBe(false)
      const listed = JSON.stringify(await actual.client.callTool({ name: 'list_tasks', arguments: { project_id: b.id } }))
      expect(listed).toContain('Own stdio task'); expect(listed).not.toContain('Foreign stdio task')
      expect(JSON.stringify(await actual.client.callTool({ name: 'get_task', arguments: { task_id: foreign.id } }))).toContain('not in this project')
      const created = await actual.client.callTool({ name: 'create_artifact', arguments: { task_id: foreign.id, title: 'Pinned stdio artifact', type: 'markdown' } })
      expect(created.isError).not.toBe(true)
      const artifacts = await listRegisteredTaskArtifacts(db.getWorkspaceDir(mine.id), mine.id)
      expect(artifacts).toHaveLength(1); expect(artifacts[0].taskId).toBe(mine.id)
      expect(await listRegisteredTaskArtifacts(db.getWorkspaceDir(foreign.id), foreign.id)).toEqual([])
      for (const tool of browserTools) expect((await actual.client.callTool({ name: tool.name, arguments: { task_id: mine.id } })).isError, tool.name).toBe(true)
      // A forged scope and a wrong launch token may establish stdio, but
      // cannot obtain the tool list from the actual signature/token owner.
      for (const invalid of [url.replace(a.id, b.id), url.replace(getTaskApiToken(), 'f'.repeat(64))]) {
        const rejected = await connect(invalid)
        await expect(rejected.client.listTools()).rejects.toThrow('Task MCP transport unavailable')
        await rejected.client.close()
        expect(rejected.diagnostics()).not.toContain(getTaskApiToken()); expect(rejected.diagnostics()).not.toContain(url)
      }
      const pid = actual.transport.pid!
      expect(pid).toBeGreaterThan(0)
      await actual.client.close()
      expect(() => process.kill(pid, 0)).toThrow()
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
      expect(db.getTask(foreign.id)?.title).toBe('Foreign stdio task')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      unrelated.kill(); await unrelatedClosed
      await closeTaskApiServer(); db.close()
      await rm(dirname(dirname(db.getWorkspaceDir('fixture'))), { recursive: true, force: true })
    }
  }, 30_000)
})
