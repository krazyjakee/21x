import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliMcpConfigManager } from '../main/cli-mcp-config/core'
import { CliMcpFileOwner } from '../main/cli-mcp-config/portable-file-owner'
import { McpProbeService, type McpProbeHost } from '../main/agent-manager/mcp-probe-service'
import { CLI_MCP_CODECS, type CliMcpCodec, type CliMcpOperation } from '../shared/cli-mcp-codecs'
import { MASKED_SECRET } from '../shared/cli-mcp-config'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { CliMcpBackend, type CliMcpBackendOptions } from './cli-mcp-backend'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'cli-epoch', webviewId: 'main', origin: 'app://cli-settings' }
let home: string, files: CliMcpFileOwner, manager: CliMcpConfigManager, probes: McpProbeService, backend: CliMcpBackend, options: CliMcpBackendOptions
let host: McpProbeHost, releases: Array<() => void>, children: ChildProcess[]
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
function fixture(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function response(id: number, result: object) { return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } }) }
beforeEach(() => {
  releases = []; children = []; home = realpathSync(mkdtempSync(join(tmpdir(), '21x-cli-backend-')))
  files = new CliMcpFileOwner({ homeDir: home, env: {}, assertCurrent: () => { if (!existsSync(home)) throw new Error('CLI_MCP_OWNER_LOST') } })
  fixture(files.paths.claudeConfig, JSON.stringify({ accountSecret: 'unrelated-private-value', mcpServers: { docs: { type: 'http', url: 'https://configured.example/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } } } }))
  fixture(files.paths.opencode, '{\n // preserve me\n "mcp": {"docs":{"type":"remote","url":"https://configured.example/mcp"}},"unknown":"keep"\n}')
  fixture(files.paths.codex, '# retain global comment\nmodel="unrelated"\n[mcp_servers.docs]\nurl="https://configured.example/mcp"\n')
  let fetchCount = 0
  host = { platform: process.platform, environment: () => ({ HOME: home }), taskApiEnvironment: vi.fn(() => { throw new Error('User CLI cannot borrow task API auth') }),
    spawn: (command, args, options) => { const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child },
    fetch: vi.fn(async () => ++fetchCount === 1 ? response(1, {}) : fetchCount === 2 ? new Response(null, { status: 204 }) : response(2, { tools: [{ name: 'search', description: 'Search configured docs.' }] })) }
  probes = new McpProbeService(host, 1000)
  manager = new CliMcpConfigManager({ files, homeDir: home, env: { DOCS_TOKEN: 'owned-source-secret' }, probeService: probes })
  options = { manager, files, probes, engineEpoch: caller.engineEpoch, assertAvailable() { if (!existsSync(home)) throw new Error('Private profile unavailable') },
    assertCliMcpOwners(owners) { if (owners.manager !== manager || owners.files !== files || owners.probes !== probes) throw new Error('Wrong CLI owner') },
    isTrustedDesktop: identity => identity.webviewId === caller.webviewId && identity.origin === caller.origin,
    canManageConfiguration: () => true, canAccessCli: () => true, canProbeCli: () => true, canProbeServer: input => input.type === 'remote' && input.url === 'https://configured.example/mcp', canUseEnvironmentReference: name => name === 'DOCS_TOKEN' }
  backend = new CliMcpBackend(options)
})
afterEach(async () => {
  for (const release of releases) release()
  await backend.close(); await manager.close(); await probes.close(); await files.close()
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGTERM'); await closed }
  rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends CliMcpOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = CLI_MCP_CODECS[operation] as CliMcpCodec<K>, wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true); return codec.decodeResult((wire as { value: JsonValue }).value)
}

describe('actual CLI stores/backend and owned MCP probes', () => {
  it('performs all six controls using actual three stores, preserving sections/comments and masked-value roundtrips', async () => {
    const snapshot = await call('cliMcp:snapshot', [])
    expect(snapshot.clis).toHaveLength(3); expect(snapshot.servers).toHaveLength(3)
    expect(JSON.stringify(snapshot)).not.toContain('unrelated-private-value'); expect(JSON.stringify(snapshot)).not.toContain('owned-source-secret')
    const upsert = await call('cliMcp:upsert', [{ targets: ['claude-code', 'opencode', 'codex'], name: 'new_server', definition: { transport: 'stdio', command: 'node', env: { API_KEY: 'new-user-secret' } } }])
    expect(upsert.results.every(row => row.ok)).toBe(true)
    expect(readFileSync(files.paths.opencode, 'utf8')).toContain('// preserve me'); expect(readFileSync(files.paths.codex, 'utf8')).toContain('# retain global comment')
    expect(readFileSync(files.paths.claudeConfig, 'utf8')).toContain('unrelated-private-value')
    expect((await call('cliMcp:setEnabled', [{ cli: 'opencode', name: 'new_server', enabled: false }])).results[0].ok).toBe(true)
    expect((await call('cliMcp:setToolEnabled', [{ cli: 'codex', name: 'new_server', tool: 'search', enabled: false }])).results[0].ok).toBe(true)
    expect((await call('cliMcp:remove', [{ cli: 'claude-code', name: 'new_server' }])).results[0].ok).toBe(true)
    const probed = await call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs' }])
    expect(probed).toMatchObject({ status: 'connected', tools: [{ name: 'search', description: 'Search configured docs.' }] })
    expect((await call('cliMcp:snapshot', [])).servers.find(row => row.cli === 'claude-code' && row.name === 'docs')?.tools).toEqual(probed.tools)
    expect(host.taskApiEnvironment).not.toHaveBeenCalled()
    fixture(files.paths.claudeConfig, '{"mcpServers":{"docs":{"type":"http","url":"https://other.example/mcp"}}}')
    expect((await call('cliMcp:snapshot', [])).servers.find(row => row.cli === 'claude-code' && row.name === 'docs')?.tools).toBeUndefined()
  })
  it('keeps existing plaintext env credentials byte values through markers and refuses absent markers before write', async () => {
    fixture(files.paths.claudeConfig, '{"mcpServers":{"saved":{"command":"node","env":{"API_KEY":"existing-private-secret,}","UNRELATED":"value,]"}}}}')
    const snapshot = await call('cliMcp:snapshot', []), saved = snapshot.servers.find(row => row.name === 'saved')!
    expect(saved.definition.env?.API_KEY).toBe(MASKED_SECRET)
    expect((await call('cliMcp:upsert', [{ targets: ['claude-code'], name: 'saved', definition: saved.definition }])).results[0].ok).toBe(true)
    expect(readFileSync(files.paths.claudeConfig, 'utf8')).toContain('existing-private-secret,}')
    const before = readFileSync(files.paths.claudeConfig, 'utf8')
    expect(JSON.parse(before).mcpServers.saved.env).toMatchObject({ API_KEY: 'existing-private-secret,}', UNRELATED: 'value,]' })
    expect((await call('cliMcp:upsert', [{ targets: ['claude-code'], name: 'missing', definition: { transport: 'stdio', command: 'node', env: { API_KEY: MASKED_SECRET } } }])).results[0].ok).toBe(false)
    expect(readFileSync(files.paths.claudeConfig, 'utf8')).toBe(before)
  })
  it('requires independent read/write/probe grants and exact current caller/owner epoch before effects', async () => {
    options.canManageConfiguration = (_caller, access) => access === 'read'
    expect((await call('cliMcp:snapshot', [])).clis).toHaveLength(3)
    await expect(call('cliMcp:remove', [{ cli: 'codex', name: 'docs' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canProbeCli = () => false
    await expect(call('cliMcp:probe', [{ cli: 'codex', name: 'docs' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(host.fetch).not.toHaveBeenCalled()
    options.canAccessCli = cli => cli !== 'opencode'
    await expect(call('cliMcp:snapshot', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('cliMcp:snapshot', [], undefined, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    expect(() => manager.assertOwners({ files, probes: new McpProbeService(host) })).toThrow('CLI_MCP_OWNER_LOST')
  })
  it('redacts private saved URL parameters and preserves them on unavailable edits and valid toggles', async () => {
    fixture(files.paths.codex, '[mcp_servers.docs]\nurl="https://user:private-password@configured.example/mcp?api_token=private-query#private-fragment"\n')
    const snapshot = await call('cliMcp:snapshot', []), saved = snapshot.servers.find(row => row.cli === 'codex')!
    expect(saved.definition.url).toBe('https://configured.example/mcp'); expect(JSON.stringify(snapshot)).not.toContain('private-password'); expect(JSON.stringify(snapshot)).not.toContain('private-query')
    const original = readFileSync(files.paths.codex, 'utf8')
    expect((await call('cliMcp:upsert', [{ targets: ['codex'], name: 'docs', definition: saved.definition }])).results[0].ok).toBe(false)
    expect(readFileSync(files.paths.codex, 'utf8')).toBe(original)
    expect((await call('cliMcp:setEnabled', [{ cli: 'codex', name: 'docs', enabled: false }])).results[0].ok).toBe(true)
    expect(readFileSync(files.paths.codex, 'utf8')).toContain('api_token=private-query')
    await expect(call('cliMcp:probe', [{ cli: 'codex', name: 'docs' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(host.fetch).not.toHaveBeenCalled()
  })
  it('authorizes original env source names as well as actual resolved destination headers', async () => {
    const sources = vi.fn(options.canUseEnvironmentReference); options.canUseEnvironmentReference = sources
    await call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs' }]); expect(sources).toHaveBeenCalledWith('DOCS_TOKEN', caller)
    fixture(files.paths.claudeConfig, '{"mcpServers":{"docs":{"type":"http","url":"https://configured.example/mcp","headers":{"X-Destination":"${PRIVATE_SOURCE}"}}}}')
    const count = vi.mocked(host.fetch).mock.calls.length
    options.canProbeServer = () => true; options.canUseEnvironmentReference = () => false
    await expect(call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(vi.mocked(host.fetch).mock.calls).toHaveLength(count)
  })
  it('preserves stale fingerprint conflicts and malformed store bytes without exposing parse excerpts', async () => {
    const old = await call('cliMcp:snapshot', []), fingerprint = old.clis.find(row => row.cli === 'codex')!.fingerprint
    fixture(files.paths.codex, '[mcp_servers.docs]\nurl="https://configured.example/mcp"\nenabled=false\n')
    const result = await call('cliMcp:setEnabled', [{ cli: 'codex', name: 'docs', enabled: true, expectedFingerprint: fingerprint }])
    expect(result.results[0]).toMatchObject({ ok: false, conflict: { expectedFingerprint: fingerprint } })
    fixture(files.paths.claudeConfig, '{"private-secret-excerpt": broken JSON}')
    const malformed = await call('cliMcp:snapshot', []); expect(malformed.clis[0].error).toBe('The CLI configuration could not be read.')
    expect(JSON.stringify(malformed)).not.toContain('private-secret-excerpt')
  })
  it('refuses prototype names after the actual upsert name normalization before borrowing the mutation lease', async () => {
    const before = readFileSync(files.paths.claudeConfig, 'utf8'), lease = vi.fn(async () => { throw new Error('Unexpected mutation lease') })
    options.runConfigurationMutation = lease
    for (const name of [' __proto__ ', 'constructor\uFEFF', ' prototype ']) await expect(call('cliMcp:upsert', [{ targets: ['claude-code'], name, definition: { transport: 'stdio', command: 'node' } }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(lease).not.toHaveBeenCalled(); expect(readFileSync(files.paths.claudeConfig, 'utf8')).toBe(before)
  })
  it('refuses a stale requested probe fingerprint before any network effect and accepts its current replacement', async () => {
    const snapshot = await call('cliMcp:snapshot', []), previous = snapshot.clis.find(row => row.cli === 'claude-code')!.fingerprint
    fixture(files.paths.claudeConfig, JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://configured.example/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-User': 'changed' } } } }))
    await expect(call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs', expectedFingerprint: previous }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(host.fetch).not.toHaveBeenCalled()
    const current = (await call('cliMcp:snapshot', [])).clis.find(row => row.cli === 'claude-code')!.fingerprint
    expect((await call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs', expectedFingerprint: current }])).status).toBe('connected')
    expect(host.fetch).toHaveBeenCalledTimes(3)
  })
  it('retains ignored raw fetch/body cancellation through failed close and forbids post-cancel requests/cache', async () => {
    const fetchGate = held(), entered = held(), cancelGate = held(), controller = new AbortController(), cancel = vi.fn(async () => { await cancelGate.promise })
    host.fetch = vi.fn(async () => { entered.release(); await fetchGate.promise; return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }) })
    const pending = call('cliMcp:probe', [{ cli: 'codex', name: 'docs' }], controller.signal).catch(error => error)
    await entered.promise; controller.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1)
    fetchGate.release(); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); await expect(manager.close(10)).rejects.toThrow('CLI_MCP_SHUTDOWN_INCOMPLETE')
    cancelGate.release(); await pending; await backend.close(); await manager.close()
    expect(host.fetch).toHaveBeenCalledOnce(); expect(probes.pendingCount).toBe(0)
  })
  it('refuses nested protocol effects and cache writes after config replacement or probe grant withdrawal', async () => {
    const gate = held(), entered = held()
    host.fetch = vi.fn(async () => { entered.release(); await gate.promise; return response(1, {}) })
    const pending = call('cliMcp:probe', [{ cli: 'codex', name: 'docs' }]).catch(error => error)
    await entered.promise; fixture(files.paths.codex, '[mcp_servers.docs]\nurl="https://changed.example/mcp"\n'); gate.release()
    expect((await pending).code).toBe('INTERNAL_ERROR'); expect(host.fetch).toHaveBeenCalledOnce()
    expect((await call('cliMcp:snapshot', [])).servers.find(row => row.cli === 'codex')?.probe).toBeUndefined()
    const second = held(), accepted = held(); host.fetch = vi.fn(async () => { accepted.release(); await second.promise; return response(1, {}) })
    const revoked = call('cliMcp:probe', [{ cli: 'claude-code', name: 'docs' }]).catch(error => error)
    await accepted.promise; options.canProbeCli = () => false; second.release(); expect((await revoked).code).toBe('INVALID_REQUEST'); expect(host.fetch).toHaveBeenCalledOnce()
  })
  it('retains an actual host configuration lease through cancellation and refuses its late write', async () => {
    const entered = held(), gate = held(), controller = new AbortController(), before = readFileSync(files.paths.codex, 'utf8')
    options.runConfigurationMutation = async (_targets, _caller, beforeEffect, effect) => { entered.release(); await gate.promise; beforeEffect(); return await effect() }
    const pending = call('cliMcp:setEnabled', [{ cli: 'codex', name: 'docs', enabled: false }], controller.signal).catch(error => error)
    await entered.promise; controller.abort(); await expect(backend.close(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    gate.release(); expect((await pending).code).toBe('CANCELLED'); expect(readFileSync(files.paths.codex, 'utf8')).toBe(before)
  })
  it('refuses inherited retired manager guards even when grants still exist', async () => {
    const gate = held(); let inherited!: Promise<unknown>
    await manager.withRequestGuard(async () => { inherited = gate.promise.then(() => manager.remove({ cli: 'codex', name: 'docs' })).catch(error => error) }, { beforeEffect() {}, signal: new AbortController().signal })
    gate.release(); expect((await inherited as Error).message).toBe('CLI_MCP_REQUEST_RETIRED'); expect(readFileSync(files.paths.codex, 'utf8')).toContain('[mcp_servers.docs]')
  })
  it('completes real local JSONL child/pipe close while preserving an unrelated fixture process', async () => {
    const node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'].find(existsSync))
    if (!node) throw new Error('Standalone Node fixture unavailable; supply TAURI_NODE_RUNTIME')
    const script = join(home, 'owned-probe.cjs')
    writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'local_fixture',description:'Actual owned child fixture only'}]}}))})`)
    fixture(files.paths.claudeConfig, JSON.stringify({ mcpServers: { 'task-management': { command: node, args: [script] } } }))
    options.canProbeServer = input => input.command === node && input.args?.[0] === script
    const unrelated = spawn(node, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(unrelated)
    await new Promise<void>(resolve => unrelated.stdout.once('data', () => resolve()))
    const result = await call('cliMcp:probe', [{ cli: 'claude-code', name: 'task-management' }]); expect(result).toMatchObject({ status: 'connected', tools: [{ name: 'local_fixture' }] })
    expect(host.taskApiEnvironment).not.toHaveBeenCalled(); expect(probes.pendingCount).toBe(0)
    const owned = children.find(child => child !== unrelated)!; expect(owned.pid).toBeGreaterThan(0); expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true)
    expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull()
  }, 10000)
})
