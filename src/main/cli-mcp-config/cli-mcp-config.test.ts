import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MASKED_SECRET } from '../../shared/cli-mcp-config'
import { CliMcpConfigManager, createDefaultStores } from './index'
import { ClaudeCodeMcpStore } from './claude-code'
import { OpencodeMcpStore } from './opencode'
import { CodexMcpStore } from './codex'
import { looksLikeSecret, resolveReferences } from './secrets'
import { stripJsonComments } from './file-store'

let home: string

const CLAUDE_JSON = {
  numStartups: 12,
  theme: 'dark',
  mcpServers: {
    github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
    docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }
  },
  projects: { '/home/me/repo': { allowedTools: [] } }
}

const CLAUDE_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(git:*)'], deny: ['mcp__github__delete_repository', 'WebFetch'] }
}

const OPENCODE_JSON = `{
  // OpenCode config with a comment
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "mcp": {
    "github": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-github"], "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" } },
    "docs": { "type": "remote", "url": "https://docs.example.com/mcp", "enabled": false, "headers": { "X-Team": "core" } }
  },
  "tools": { "github_delete_repository": false, "write": true },
}
`

const CODEX_TOML = `model = "gpt-5"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env_vars = ["GITHUB_TOKEN"]
disabled_tools = ["delete_repository"]

[mcp_servers.github.env]
LOG_LEVEL = "info"

[mcp_servers.docs]
url = "https://docs.example.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"
enabled = false

[projects."/home/me/repo"]
trust_level = "trusted"
`

function writeFixtures(): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify(CLAUDE_JSON, null, 2) + '\n')
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(CLAUDE_SETTINGS, null, 2) + '\n')
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), OPENCODE_JSON)
  writeFileSync(join(home, '.codex', 'config.toml'), CODEX_TOML)
}

function manager(probe = vi.fn()): CliMcpConfigManager {
  return new CliMcpConfigManager({ stores: createDefaultStores({}, home), env: { DOCS_TOKEN: 'resolved-token' }, probe })
}

const read = (...parts: string[]): string => readFileSync(join(home, ...parts), 'utf-8')
/** The lines of one `[mcp_servers.<name>]` table (not its subtables) in config.toml. */
const codexTable = (name: string): string => {
  const lines = read('.codex', 'config.toml').split('\n')
  const start = lines.indexOf(`[mcp_servers.${name}]`)
  if (start === -1) return ''
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('[')) end++
  return lines.slice(start, end).join('\n')
}
const readJson = (...parts: string[]): Record<string, unknown> => JSON.parse(read(...parts))

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), '20x-cli-mcp-'))
  writeFixtures()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('import: unified snapshot', () => {
  it('discovers every server of every CLI and keeps the owner', () => {
    const snap = manager().snapshot()
    expect(snap.clis.map((c) => [c.cli, c.error])).toEqual([['claude-code', undefined], ['opencode', undefined], ['codex', undefined]])
    expect(snap.servers.map((s) => `${s.cli}/${s.name}`)).toEqual([
      'claude-code/docs', 'codex/docs', 'opencode/docs',
      'claude-code/github', 'codex/github', 'opencode/github'
    ])
  })

  it('parses Claude Code entries and reads deny rules as disabled tools', () => {
    const snap = manager().snapshot()
    const github = snap.servers.find((s) => s.cli === 'claude-code' && s.name === 'github')!
    expect(github.definition).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] })
    expect(github.enabled).toBe(true)
    expect(github.disabledTools).toEqual(['delete_repository'])
    const docs = snap.servers.find((s) => s.cli === 'claude-code' && s.name === 'docs')!
    expect(docs.definition).toMatchObject({ transport: 'http', url: 'https://docs.example.com/mcp' })
  })

  it('parses OpenCode JSONC, translates {env:} references and reads tools/enabled', () => {
    const snap = manager().snapshot()
    const opencode = snap.clis.find((c) => c.cli === 'opencode')!
    expect(opencode.notes[0]).toMatch(/comments/)
    const github = snap.servers.find((s) => s.cli === 'opencode' && s.name === 'github')!
    expect(github.definition).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } })
    expect(github.disabledTools).toEqual(['delete_repository'])
    const docs = snap.servers.find((s) => s.cli === 'opencode' && s.name === 'docs')!
    expect(docs.enabled).toBe(false)
    expect(docs.definition.headers).toEqual({ 'X-Team': 'core' })
  })

  it('parses Codex TOML, mapping env_vars and bearer_token_env_var to references', () => {
    const snap = manager().snapshot()
    const github = snap.servers.find((s) => s.cli === 'codex' && s.name === 'github')!
    expect(github.definition.env).toEqual({ LOG_LEVEL: 'info', GITHUB_TOKEN: '${GITHUB_TOKEN}' })
    expect(github.disabledTools).toEqual(['delete_repository'])
    const docs = snap.servers.find((s) => s.cli === 'codex' && s.name === 'docs')!
    expect(docs.enabled).toBe(false)
    expect(docs.definition.headers).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}' })
  })

  it('masks secret-looking values and never the references', () => {
    const snap = manager().snapshot()
    const claudeGithub = snap.servers.find((s) => s.cli === 'claude-code' && s.name === 'github')!
    expect(claudeGithub.definition.env).toEqual({ GITHUB_TOKEN: MASKED_SECRET })
    expect(claudeGithub.maskedKeys.env).toEqual(['GITHUB_TOKEN'])
    const claudeDocs = snap.servers.find((s) => s.cli === 'claude-code' && s.name === 'docs')!
    expect(claudeDocs.definition.headers).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}' })
    expect(claudeDocs.maskedKeys.headers).toEqual([])
    expect(JSON.stringify(snap)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('reports a parse error for one CLI without hiding the others', () => {
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(join(home, '.claude.json'), '{ not json')
    const snap = manager().snapshot()
    expect(snap.clis.find((c) => c.cli === 'claude-code')!.error).toBeTruthy()
    expect(snap.servers.every((s) => s.cli !== 'claude-code')).toBe(true)
    expect(snap.servers.filter((s) => s.cli === 'opencode')).toHaveLength(2)
  })

  it('flags invalid entries found on disk', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { broken: { type: 'http', url: 'not a url' } } }))
    const snap = manager().snapshot()
    expect(snap.servers.find((s) => s.name === 'broken')!.issues).toEqual(['"not a url" is not a valid URL.'])
  })
})

describe('update and disable round-trips', () => {
  it('disables and re-enables a server per CLI, touching nothing else', () => {
    const m = manager()
    let snap = m.snapshot()
    const fp = (cli: 'claude-code' | 'opencode' | 'codex'): string => snap.clis.find((c) => c.cli === cli)!.fingerprint

    const claude = m.setEnabled({ cli: 'claude-code', name: 'github', enabled: false, expectedFingerprint: fp('claude-code') })
    expect(claude.results[0].ok).toBe(true)
    let settings = readJson('.claude', 'settings.json') as { permissions: { allow: string[]; deny: string[] }; model: string }
    expect(settings.permissions.deny).toEqual(['mcp__github__delete_repository', 'WebFetch', 'mcp__github'])
    expect(settings.permissions.allow).toEqual(['Bash(git:*)'])
    expect(settings.model).toBe('opus')
    expect(readJson('.claude.json')).toEqual(CLAUDE_JSON) // servers file untouched
    snap = claude.snapshot
    expect(snap.servers.find((s) => s.cli === 'claude-code' && s.name === 'github')!.enabled).toBe(false)

    const opencode = m.setEnabled({ cli: 'opencode', name: 'github', enabled: false, expectedFingerprint: fp('opencode') })
    expect(opencode.results[0].ok).toBe(true)
    const oc = readJson('.config', 'opencode', 'opencode.json') as { mcp: Record<string, { enabled?: boolean }>; theme: string; tools: Record<string, boolean> }
    expect(oc.mcp.github.enabled).toBe(false)
    expect(oc.theme).toBe('tokyonight')
    expect(oc.tools).toEqual({ github_delete_repository: false, write: true })
    snap = opencode.snapshot

    const codex = m.setEnabled({ cli: 'codex', name: 'github', enabled: false, expectedFingerprint: fp('codex') })
    expect(codex.results[0].ok).toBe(true)
    const toml = read('.codex', 'config.toml')
    expect(codexTable('github')).toContain('enabled = false')
    expect(toml).toContain('[projects."/home/me/repo"]\ntrust_level = "trusted"')
    expect(toml).toContain('LOG_LEVEL = "info"')
    snap = codex.snapshot
    expect(snap.servers.filter((s) => s.name === 'github').every((s) => !s.enabled)).toBe(true)

    // Back on: flags are removed rather than set to true.
    m.setEnabled({ cli: 'claude-code', name: 'github', enabled: true })
    m.setEnabled({ cli: 'opencode', name: 'github', enabled: true })
    m.setEnabled({ cli: 'codex', name: 'github', enabled: true })
    settings = readJson('.claude', 'settings.json') as typeof settings
    expect(settings.permissions.deny).toEqual(['mcp__github__delete_repository', 'WebFetch'])
    expect((readJson('.config', 'opencode', 'opencode.json') as { mcp: Record<string, { enabled?: boolean }> }).mcp.github.enabled).toBeUndefined()
    expect(codexTable('github')).not.toContain('enabled = false')
    expect(m.snapshot().servers.filter((s) => s.name === 'github').every((s) => s.enabled)).toBe(true)
  })

  it('adds one server to several CLIs in each native shape, and edits it', () => {
    const m = manager()
    const add = m.upsert({
      targets: ['claude-code', 'opencode', 'codex'],
      name: 'fs',
      definition: { transport: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { ROOT: '/tmp' } }
    })
    expect(add.results.map((r) => r.ok)).toEqual([true, true, true])
    expect((readJson('.claude.json') as { mcpServers: Record<string, unknown> }).mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { ROOT: '/tmp' } })
    expect((readJson('.config', 'opencode', 'opencode.json') as { mcp: Record<string, unknown> }).mcp.fs).toEqual({ type: 'local', command: ['npx', '-y', 'server-fs', '/tmp'], environment: { ROOT: '/tmp' } })
    expect(read('.codex', 'config.toml')).toContain('[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "server-fs", "/tmp"]\n\n[mcp_servers.fs.env]\nROOT = "/tmp"')
    expect(add.snapshot.servers.filter((s) => s.name === 'fs')).toHaveLength(3)

    const edit = m.upsert({
      targets: ['codex'],
      name: 'fs-renamed',
      previousName: 'fs',
      definition: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} }
    })
    expect(edit.results[0].ok).toBe(true)
    const toml = read('.codex', 'config.toml')
    expect(toml).not.toContain('[mcp_servers.fs]')
    expect(toml).toContain('[mcp_servers.fs-renamed]\ncommand = "node"\nargs = ["server.js"]')
    expect(toml).not.toContain('ROOT = ')
  })

  it('keeps unknown keys of an existing entry when editing it', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { x: { command: 'a', args: [], customFlag: true } } }))
    const m = manager()
    m.upsert({ targets: ['claude-code'], name: 'x', definition: { transport: 'stdio', command: 'b', args: ['c'] } })
    expect((readJson('.claude.json') as { mcpServers: Record<string, unknown> }).mcpServers.x).toEqual({ customFlag: true, type: 'stdio', command: 'b', args: ['c'] })
  })

  it('removes a server together with its dangling tool rules', () => {
    const m = manager()
    expect(m.remove({ cli: 'claude-code', name: 'github' }).results[0].ok).toBe(true)
    expect((readJson('.claude', 'settings.json') as { permissions: { deny: string[] } }).permissions.deny).toEqual(['WebFetch'])
    expect((readJson('.claude.json') as { mcpServers: Record<string, unknown> }).mcpServers).toEqual({ docs: CLAUDE_JSON.mcpServers.docs })

    expect(m.remove({ cli: 'opencode', name: 'github' }).results[0].ok).toBe(true)
    const oc = readJson('.config', 'opencode', 'opencode.json') as { mcp: Record<string, unknown>; tools: Record<string, boolean> }
    expect(Object.keys(oc.mcp)).toEqual(['docs'])
    expect(oc.tools).toEqual({ write: true })

    expect(m.remove({ cli: 'codex', name: 'github' }).results[0].ok).toBe(true)
    expect(read('.codex', 'config.toml')).toBe('model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\nenabled = false\n\n[projects."/home/me/repo"]\ntrust_level = "trusted"\n')

    const missing = m.remove({ cli: 'codex', name: 'nope' })
    expect(missing.results[0].ok).toBe(false)
    expect(missing.results[0].error).toMatch(/no MCP server named "nope"/)
  })

  it('validates before writing', () => {
    const m = manager()
    const bad = m.upsert({ targets: ['codex', 'claude-code'], name: 'bad name', definition: { transport: 'http', url: 'ftp://x' } })
    expect(bad.results[0].ok).toBe(false)
    expect(bad.results[0].error).toMatch(/Codex server names/)
    expect(bad.results[1].error).toMatch(/http or https/)
    expect(read('.codex', 'config.toml')).toBe(CODEX_TOML)
  })
})

describe('per-tool filtering', () => {
  it('writes each CLI\'s native per-tool switch and reads it back', () => {
    const m = manager()
    m.setToolEnabled({ cli: 'claude-code', name: 'docs', tool: 'search', enabled: false })
    m.setToolEnabled({ cli: 'opencode', name: 'docs', tool: 'search', enabled: false })
    m.setToolEnabled({ cli: 'codex', name: 'docs', tool: 'search', enabled: false })

    expect((readJson('.claude', 'settings.json') as { permissions: { deny: string[] } }).permissions.deny).toContain('mcp__docs__search')
    expect((readJson('.config', 'opencode', 'opencode.json') as { tools: Record<string, boolean> }).tools.docs_search).toBe(false)
    expect(codexTable('docs')).toContain('disabled_tools = ["search"]')

    const snap = m.snapshot()
    expect(snap.servers.filter((s) => s.name === 'docs').map((s) => s.disabledTools)).toEqual([['search'], ['search'], ['search']])

    m.setToolEnabled({ cli: 'claude-code', name: 'docs', tool: 'search', enabled: true })
    m.setToolEnabled({ cli: 'opencode', name: 'docs', tool: 'search', enabled: true })
    m.setToolEnabled({ cli: 'codex', name: 'docs', tool: 'search', enabled: true })
    expect(m.snapshot().servers.filter((s) => s.name === 'docs').map((s) => s.disabledTools)).toEqual([[], [], []])
    expect(read('.codex', 'config.toml')).not.toContain('disabled_tools = []')
    expect((readJson('.config', 'opencode', 'opencode.json') as { tools: Record<string, boolean> }).tools).toEqual({ github_delete_repository: false, write: true })
  })

  it('normalizes names in Claude Code and OpenCode tool ids', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'my server': { command: 'x' } } }))
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { 'my server': { type: 'local', command: ['x'] } } }))
    const m = manager()
    m.setToolEnabled({ cli: 'claude-code', name: 'my server', tool: 'do', enabled: false })
    m.setToolEnabled({ cli: 'opencode', name: 'my server', tool: 'do', enabled: false })
    expect((readJson('.claude', 'settings.json') as { permissions: { deny: string[] } }).permissions.deny).toContain('mcp__my_server__do')
    expect((readJson('.config', 'opencode', 'opencode.json') as { tools: Record<string, boolean> }).tools).toEqual({ my_server_do: false })
    expect(m.snapshot().servers.filter((s) => s.name === 'my server').map((s) => s.disabledTools)).toEqual([['do'], ['do']])
  })

  it('keeps discovered tools from a probe in the snapshot', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 'connected', toolCount: 2, tools: [{ name: 'search', description: 'Search' }, { name: 'read', description: 'Read' }] })
    const m = manager(probe)
    const result = await m.probe({ cli: 'codex', name: 'docs' })
    expect(result.status).toBe('connected')
    expect(probe).toHaveBeenCalledWith({ name: 'docs', type: 'remote', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer resolved-token' } })
    const docs = m.snapshot().servers.find((s) => s.cli === 'codex' && s.name === 'docs')!
    expect(docs.tools?.map((t) => t.name)).toEqual(['search', 'read'])
    expect(docs.probe?.status).toBe('connected')
  })

  it('names unset references when a probe fails', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 'failed', error: 'HTTP 401' })
    const m = new CliMcpConfigManager({ stores: createDefaultStores({}, home), env: {}, probe })
    const result = await m.probe({ cli: 'claude-code', name: 'docs' })
    expect(result.status).toBe('failed')
    expect(result.error).toBe('HTTP 401 (unset environment variable: DOCS_TOKEN)')
    expect(result.unresolvedReferences).toEqual(['DOCS_TOKEN'])
  })
})

describe('external-edit conflict detection', () => {
  it('refuses to write when the file changed since the snapshot and succeeds after a reload', () => {
    const m = manager()
    const stale = m.snapshot()
    const staleFp = stale.clis.find((c) => c.cli === 'codex')!.fingerprint

    // Someone edits config.toml in an editor meanwhile.
    writeFileSync(join(home, '.codex', 'config.toml'), CODEX_TOML + '\n[mcp_servers.other]\ncommand = "other"\n')

    const refused = m.setEnabled({ cli: 'codex', name: 'github', enabled: false, expectedFingerprint: staleFp })
    expect(refused.results[0].ok).toBe(false)
    expect(refused.results[0].conflict).toMatchObject({ cli: 'codex', expectedFingerprint: staleFp })
    expect(refused.results[0].conflict!.currentFingerprint).not.toBe(staleFp)
    expect(read('.codex', 'config.toml')).toContain('[mcp_servers.other]')
    expect(read('.codex', 'config.toml')).not.toContain('enabled = false\n\n[mcp_servers.github.env]')

    const freshFp = refused.snapshot.clis.find((c) => c.cli === 'codex')!.fingerprint
    const applied = m.setEnabled({ cli: 'codex', name: 'github', enabled: false, expectedFingerprint: freshFp })
    expect(applied.results[0].ok).toBe(true)
    expect(read('.codex', 'config.toml')).toContain('[mcp_servers.other]\ncommand = "other"')
    expect(codexTable('github')).toContain('enabled = false')
  })

  it('detects a change to either Claude Code file', () => {
    const m = manager()
    const fp = m.snapshot().clis.find((c) => c.cli === 'claude-code')!.fingerprint
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [] } }))
    const refused = m.setToolEnabled({ cli: 'claude-code', name: 'github', tool: 'x', enabled: false, expectedFingerprint: fp })
    expect(refused.results[0].conflict?.paths).toEqual([join(home, '.claude.json'), join(home, '.claude', 'settings.json')])
  })

  it('ignores changes outside the MCP view, such as Claude Code bookkeeping, and keeps them', () => {
    const m = manager()
    const fp = m.snapshot().clis.find((c) => c.cli === 'claude-code')!.fingerprint
    const config = readJson('.claude.json') as Record<string, unknown>
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ ...config, numStartups: 42 }, null, 2) + '\n')

    const applied = m.setToolEnabled({ cli: 'claude-code', name: 'github', tool: 'x', enabled: false, expectedFingerprint: fp })
    expect(applied.results[0].ok).toBe(true)
    expect((readJson('.claude.json') as { numStartups: number }).numStartups).toBe(42)
  })

  it('writes without a check when no fingerprint is given', () => {
    const m = manager()
    writeFileSync(join(home, '.codex', 'config.toml'), CODEX_TOML + '\n[mcp_servers.other]\ncommand = "other"\n')
    expect(m.setEnabled({ cli: 'codex', name: 'other', enabled: false }).results[0].ok).toBe(true)
  })

  it('reports a missing config file as a conflict once it appears', () => {
    rmSync(join(home, '.codex', 'config.toml'))
    const m = manager()
    const fp = m.snapshot().clis.find((c) => c.cli === 'codex')!.fingerprint
    writeFileSync(join(home, '.codex', 'config.toml'), CODEX_TOML)
    expect(m.upsert({ targets: ['codex'], name: 'n', definition: { transport: 'stdio', command: 'x' }, expectedFingerprints: { codex: fp } }).results[0].conflict).toBeTruthy()
  })
})

describe('secrets', () => {
  it('recognises secret-looking keys and long opaque values, but never references', () => {
    expect(looksLikeSecret('env', 'GITHUB_TOKEN', 'abc')).toBe(true)
    expect(looksLikeSecret('env', 'ROOT', '/tmp')).toBe(false)
    expect(looksLikeSecret('env', 'ROOT', 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(looksLikeSecret('env', 'GITHUB_TOKEN', '${GITHUB_TOKEN}')).toBe(false)
    expect(looksLikeSecret('header', 'Authorization', 'Bearer x')).toBe(true)
    expect(looksLikeSecret('header', 'X-Team', 'core')).toBe(false)
  })

  it('never writes a new plaintext secret; each CLI gets its own reference form', () => {
    const m = manager()
    const result = m.upsert({
      targets: ['claude-code', 'opencode', 'codex'],
      name: 'svc',
      definition: { transport: 'stdio', command: 'svc', env: { API_KEY: 'sk-live-0123456789abcdef', MODE: 'fast' } }
    })
    expect(result.results.every((r) => r.ok)).toBe(true)
    expect(result.results[0].warnings.join(' ')).toMatch(/API_KEY.*reference/)
    for (const file of [read('.claude.json'), read('.config', 'opencode', 'opencode.json'), read('.codex', 'config.toml')]) {
      expect(file).not.toContain('sk-live-0123456789abcdef')
    }
    expect((readJson('.claude.json') as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers.svc.env).toEqual({ API_KEY: '${API_KEY}', MODE: 'fast' })
    expect((readJson('.config', 'opencode', 'opencode.json') as { mcp: Record<string, { environment: Record<string, string> }> }).mcp.svc.environment).toEqual({ API_KEY: '{env:API_KEY}', MODE: 'fast' })
    expect(read('.codex', 'config.toml')).toContain('env_vars = ["API_KEY"]\n\n[mcp_servers.svc.env]\nMODE = "fast"')
  })

  it('writes remote header secrets as Codex env_http_headers / bearer_token_env_var', () => {
    const m = manager()
    m.upsert({
      targets: ['codex'],
      name: 'remote',
      definition: { transport: 'http', url: 'https://r.example.com/mcp', headers: { Authorization: 'Bearer ${R_TOKEN}', 'X-Api-Key': 'plain-key-value-that-is-long-enough-1234', 'X-Team': 'core' } }
    })
    const toml = read('.codex', 'config.toml')
    expect(toml).toContain('bearer_token_env_var = "R_TOKEN"')
    expect(toml).toContain('[mcp_servers.remote.http_headers]\nX-Team = "core"')
    expect(toml).toContain('[mcp_servers.remote.env_http_headers]\nX-Api-Key = "MCP_REMOTE_X_API_KEY"')
    expect(toml).not.toContain('plain-key-value')
    const remote = m.snapshot().servers.find((s) => s.cli === 'codex' && s.name === 'remote')!
    expect(remote.definition.headers).toEqual({ 'X-Team': 'core', 'X-Api-Key': '${MCP_REMOTE_X_API_KEY}', Authorization: 'Bearer ${R_TOKEN}' })
  })

  it('keeps the on-disk value when the masked placeholder is sent back', () => {
    const m = manager()
    const result = m.upsert({
      targets: ['claude-code'],
      name: 'github',
      definition: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github', '--verbose'], env: { GITHUB_TOKEN: MASKED_SECRET } }
    })
    expect(result.results[0].ok).toBe(true)
    const entry = (readJson('.claude.json') as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }).mcpServers.github
    expect(entry.args).toEqual(['-y', '@modelcontextprotocol/server-github', '--verbose'])
    expect(entry.env).toEqual({ GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
  })

  it('resolves references with defaults for probes', () => {
    expect(resolveReferences({ A: '${X}', B: 'v-${Y:-dflt}', C: 'plain' }, { X: '1' })).toEqual({ values: { A: '1', B: 'v-dflt', C: 'plain' }, unresolved: [] })
    expect(resolveReferences({ A: '${MISSING}' }, {})).toEqual({ values: { A: '' }, unresolved: ['MISSING'] })
  })
})

describe('stores in isolation', () => {
  it('reads opencode.jsonc when opencode.json is absent and honours OPENCODE_CONFIG', () => {
    rmSync(join(home, '.config', 'opencode', 'opencode.json'))
    writeFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), '{ "mcp": { "a": { "type": "local", "command": ["a"] } } }')
    expect(new OpencodeMcpStore({ homeDir: home, env: {} }).load().servers.map((s) => s.name)).toEqual(['a'])
    const custom = join(home, 'custom.json')
    writeFileSync(custom, '{ "mcp": { "b": { "type": "remote", "url": "https://b" } } }')
    expect(new OpencodeMcpStore({ homeDir: home, env: { OPENCODE_CONFIG: custom } }).load().servers.map((s) => s.name)).toEqual(['b'])
  })

  it('honours CODEX_HOME', () => {
    const codexHome = join(home, 'codex-home')
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.z]\ncommand = "z"\n')
    expect(new CodexMcpStore({ homeDir: home, env: { CODEX_HOME: codexHome } }).load().servers.map((s) => s.name)).toEqual(['z'])
  })

  it('treats missing files as empty and creates them on first write', () => {
    rmSync(join(home, '.claude.json'))
    rmSync(join(home, '.claude', 'settings.json'))
    const store = new ClaudeCodeMcpStore({ homeDir: home })
    expect(store.load()).toMatchObject({ servers: [], error: undefined })
    const result = store.apply(undefined, () => ({ kind: 'upsert', name: 'n', definition: { transport: 'stdio', command: 'x' } }))
    expect(result.ok).toBe(true)
    expect(readJson('.claude.json')).toEqual({ mcpServers: { n: { type: 'stdio', command: 'x', args: [] } } })
  })

  it('strips comments and trailing commas but not slashes inside strings', () => {
    expect(JSON.parse(stripJsonComments('{ "u": "https://x//y", /* c */ "a": [1,], } // t').text)).toEqual({ u: 'https://x//y', a: [1] })
  })
})
