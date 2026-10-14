import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliMcpFileOwner, CLI_MCP_FILE_LIMITS, type CliMcpFilePrimitives } from './portable-file-owner'
import { createDefaultStores } from './core'
import { preserveJsonDocument, validatePortableJsonText } from './jsonc-edit'
import { parseJsonDocument, stripJsonComments } from './file-store'

let home: string, owners: CliMcpFileOwner[]
beforeEach(() => { home = mkdtempSync(join(tmpdir(), '21x-cli-config-')); owners = [] })
afterEach(async () => { for (const owner of owners) await owner.close(); rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks() })
function own(fs?: Partial<CliMcpFilePrimitives>, env: NodeJS.ProcessEnv = {}) { const value = new CliMcpFileOwner({ homeDir: home, env, assertCurrent: () => {}, fs }); owners.push(value); return value }
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }

describe('actual captured CLI files and stores', () => {
  it('fixes all four paths, honors trusted config overrides and preserves modes/full original fingerprints', () => {
    const env = { CODEX_HOME: join(home, 'codex-specific'), OPENCODE_CONFIG: join(home, 'opencode-specific.json') }, files = own(undefined, env)
    env.CODEX_HOME = '/foreign'; expect(files.paths.codex).toBe(join(home, 'codex-specific', 'config.toml'))
    write(files.paths.claudeConfig, '{"accountToken":"private","mcpServers":{}}\n'); chmodSync(files.paths.claudeConfig, 0o640)
    const before = files.readSnapshot(files.paths.claudeConfig)
    files.writeAtomic(before.path, '{"accountToken":"private","mcpServers":{"x":{"command":"x"}}}\n', before)
    expect(lstatSync(before.path).mode & 0o777).toBe(0o640); expect(readFileSync(before.path, 'utf8')).toContain('"accountToken":"private"')
    expect(() => files.readSnapshot(join(home, 'foreign.json'))).toThrow('CLI_MCP_FILE_INVALID')
    expect(files.inflightCount).toBe(0)
  })
  it('preflights per-file/aggregate bytes before any actual open or parse', () => {
    const open = vi.fn(openSync), files = own({ open })
    write(files.paths.claudeConfig, 'x'.repeat(CLI_MCP_FILE_LIMITS.fileBytes + 1))
    expect(() => files.readAll()).toThrow('CLI_MCP_FILE_LIMIT'); expect(open).not.toHaveBeenCalled()
    write(files.paths.claudeConfig, 'x'.repeat(200000)); write(files.paths.opencode, 'x'.repeat(200000)); write(files.paths.codex, 'x'.repeat(200000))
    expect(() => createDefaultStores({}, home, files)[0].load()).toThrow('CLI_MCP_FILE_LIMIT'); expect(open).not.toHaveBeenCalled()
    expect(readFileSync(files.paths.claudeConfig).length).toBe(200000)
  })
  it('refuses publication that would exceed aggregate size before creating scratch', () => {
    const files = own(); write(files.paths.claudeConfig, 'x'.repeat(200000)); write(files.paths.opencode, 'x'.repeat(200000))
    const before = files.readSnapshot(files.paths.codex)
    expect(() => files.writeAtomic(before.path, 'x'.repeat(200000), before)).toThrow('CLI_MCP_FILE_LIMIT')
    expect(readdirSync(home).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('refuses symlinks, hardlinks and replaced parents without reading/modifying unrelated data', () => {
    const files = own(), secret = join(home, 'unrelated'); write(secret, 'private unowned data'); symlinkSync(secret, files.paths.claudeConfig)
    expect(() => files.readAll()).toThrow('CLI_MCP_FILE_UNSAFE'); rmSync(files.paths.claudeConfig); linkSync(secret, files.paths.claudeConfig)
    expect(() => files.readSnapshot(files.paths.claudeConfig)).toThrow('CLI_MCP_FILE_UNSAFE'); rmSync(files.paths.claudeConfig)
    write(files.paths.codex, 'model="fixture"'); files.readSnapshot(files.paths.codex)
    renameSync(dirname(files.paths.codex), join(home, 'old-codex')); mkdirSync(dirname(files.paths.codex)); write(files.paths.codex, 'foreign replacement')
    expect(() => files.readSnapshot(files.paths.codex)).toThrow('CLI_MCP_FILE_CHANGED'); expect(readFileSync(secret, 'utf8')).toBe('private unowned data')
  })
  it('keeps malformed relative/linked selected config unavailable without failing unrelated bootstrap', async () => {
    const relative = own(undefined, { CODEX_HOME: 'relative' }); expect(() => relative.readAll()).toThrow('CLI_MCP_FILE_UNAVAILABLE'); await relative.close()
    const outside = join(home, 'outside'); mkdirSync(outside); symlinkSync(outside, join(home, '.claude'))
    const linked = own(); expect(() => linked.readAll()).toThrow('CLI_MCP_FILE_UNAVAILABLE'); await linked.close()
  })
  it('compares full original bytes and inode immediately before rename, preserving concurrent bookkeeping edits', () => {
    let path = ''; const files = own({ fsync(fd) { expect(fstatSync(fd).isFile()).toBe(true); writeFileSync(path, '{"userEdit":"preserve me"}') } })
    path = files.paths.claudeConfig; write(path, '{"old":true}'); const before = files.readSnapshot(path)
    expect(() => files.writeAtomic(path, '{"old":false}', before)).toThrow('CLI_MCP_FILE_CONFLICT')
    expect(readFileSync(path, 'utf8')).toBe('{"userEdit":"preserve me"}'); expect(readdirSync(home).some(name => name.endsWith('.tmp'))).toBe(false)
  })
  it('retains failed actual FD close, blocks publication and joins it only on explicit retry', async () => {
    let refusing = false; const close = vi.fn((fd: number) => { if (refusing) throw new Error('private close error'); closeSync(fd) })
    const files = own({ close }); write(files.paths.claudeConfig, '{"old":true}'); const before = files.readSnapshot(files.paths.claudeConfig)
    refusing = true; expect(() => files.writeAtomic(before.path, '{"old":false}', before)).toThrow('CLI_MCP_FILE_CLOSE_PENDING')
    expect(readFileSync(before.path, 'utf8')).toBe('{"old":true}'); expect(files.inflightCount).toBeGreaterThan(0)
    await expect(files.close()).rejects.toThrow('CLI_MCP_FILE_CLOSE_PENDING'); refusing = false; await files.close(); expect(files.inflightCount).toBe(0)
  })
  it('closes accepted raw read FD after caller revocation and refuses inherited retired scopes', async () => {
    let allowed = true; const close = vi.fn(closeSync), files = own({ close, read(...args) { const size = readSync(...args); allowed = false; return size } })
    write(files.paths.claudeConfig, '{}')
    await expect(files.withRequestGuard(async () => files.readSnapshot(files.paths.claudeConfig), () => { if (!allowed) throw new Error('INVALID_REQUEST') }, new AbortController().signal)).rejects.toThrow('INVALID_REQUEST')
    expect(close).toHaveBeenCalledOnce(); expect(files.inflightCount).toBe(0)
    allowed = true; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let inherited!: Promise<unknown>
    await files.withRequestGuard(async () => { inherited = gate.then(() => files.preflight()).catch(error => error) }, () => {}, new AbortController().signal)
    release(); expect((await inherited as Error).message).toBe('CLI_MCP_REQUEST_RETIRED')
  })
  it('retains valid JSONC comments, unknown values, array trivia, BOM and duplicate-key refusal', () => {
    const original = '\uFEFF{\n  // account comment\n  "account": { "secret": "untouched", "unknown": [1,2] },\n  "mcp": { "docs": { "type":"local", "command":["node", /* keep argument note */ "old"], "other":42 } },\n  // tools comment\n  "tools": { "docs_search":false, "unrelated":true },\n}\n'
    const doc = parseJsonDocument(original); (doc.value.mcp as { docs: { command: string[] } }).docs.command = ['node', 'new']; delete (doc.value.tools as Record<string, unknown>).docs_search
    const changed = preserveJsonDocument(doc, original)
    expect(changed.startsWith('\uFEFF')).toBe(true); for (const comment of ['// account comment', '/* keep argument note */', '// tools comment']) expect(changed).toContain(comment)
    expect(changed).toContain('"account": { "secret": "untouched", "unknown": [1,2] }'); expect(JSON.parse(stripJsonComments(changed).text.trimStart()).mcp.docs.command).toEqual(['node', 'new'])
    expect(() => validatePortableJsonText('{"mcp":{},"mcp":{}}')).toThrow('CLI_MCP_JSON_AMBIGUOUS')
    expect(() => validatePortableJsonText('['.repeat(66) + '0' + ']'.repeat(66))).toThrow('CLI_MCP_JSON_LIMIT')
  })
  it('uses actual three stores, preserving unknown JSON/TOML sections, comments and existing server secrets', () => {
    const files = own(); write(files.paths.claudeConfig, '{"accountToken":"untouched","mcpServers":{"docs":{"command":"node","env":{"API_KEY":"saved-secret"},"custom":true}}}')
    write(files.paths.opencode, '{\n // keep this note\n "model":"unrelated", "mcp":{"docs":{"type":"local","command":["node"],"custom":true}}\n}')
    write(files.paths.codex, '# global note\nmodel="unrelated"\n[mcp_servers.docs] # server note\ncommand="node" # command note\ncustom="keep"\n\n[projects."/repo"]\ntrust_level="trusted"\n')
    const stores = createDefaultStores({}, home, files)
    for (const store of stores) expect(store.apply(store.load().fingerprint, () => ({ kind: 'setToolEnabled', name: 'docs', tool: 'search', enabled: false })).ok).toBe(true)
    expect(readFileSync(files.paths.claudeConfig, 'utf8')).toContain('"API_KEY":"saved-secret"'); expect(readFileSync(files.paths.claudeConfig, 'utf8')).toContain('"accountToken":"untouched"')
    expect(readFileSync(files.paths.opencode, 'utf8')).toContain('// keep this note'); expect(readFileSync(files.paths.opencode, 'utf8')).toContain('"model":"unrelated"')
    const toml = readFileSync(files.paths.codex, 'utf8'); for (const text of ['# global note', '# server note', '# command note', 'custom = "keep"', '[projects."/repo"]\ntrust_level="trusted"']) expect(toml).toContain(text)
    expect(stores.map(store => store.load().servers[0].disabledTools)).toEqual([['search'], ['search'], ['search']])
  })
})
