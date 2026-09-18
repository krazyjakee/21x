import { describe, it, expect } from 'vitest'
import { parseTomlMcpDocument, parseTomlValue, removeTomlMcpServer, renderTomlMcpServer, upsertTomlMcpServer } from './toml-mcp'

const FIXTURE = `# Codex config
model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.filesystem]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-filesystem", # inline comment
  "/home/me"
]
enabled = true
startup_timeout_sec = 20
disabled_tools = ["delete_file"]

[mcp_servers.filesystem.env]
LOG_LEVEL = "debug"

[mcp_servers."remote one"]
url = "https://example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
http_headers = { "X-Team" = "core" }
some_date = 1979-05-27T07:32:00Z

[projects."/home/me/repo"]
trust_level = "trusted"
`

describe('parseTomlValue', () => {
  it('parses strings, numbers, booleans, arrays and inline tables', () => {
    expect(parseTomlValue('"a \\"quoted\\" \\u00e9"')).toBe('a "quoted" é')
    expect(parseTomlValue("'C:\\path'")).toBe('C:\\path')
    expect(parseTomlValue('1_000')).toBe(1000)
    expect(parseTomlValue('-2.5')).toBe(-2.5)
    expect(parseTomlValue('true')).toBe(true)
    expect(parseTomlValue('[1, "two", [3]]')).toEqual([1, 'two', [3]])
    expect(parseTomlValue('{ a = "b", c.d = 1, e = { f = false } }')).toEqual({ a: 'b', c: { d: 1 }, e: { f: false } })
  })

  it('rejects date-times so they stay as raw lines', () => {
    expect(() => parseTomlValue('1979-05-27T07:32:00Z')).toThrow()
  })
})

describe('parseTomlMcpDocument', () => {
  it('reads every mcp_servers table including quoted names and subtables', () => {
    const doc = parseTomlMcpDocument(FIXTURE)
    expect([...doc.servers.keys()]).toEqual(['filesystem', 'remote one'])
    const fs = doc.servers.get('filesystem')!
    expect(fs.values.command).toBe('npx')
    expect(fs.values.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/home/me'])
    expect(fs.values.enabled).toBe(true)
    expect(fs.values.startup_timeout_sec).toBe(20)
    expect(fs.values.disabled_tools).toEqual(['delete_file'])
    expect(fs.values.env).toEqual({ LOG_LEVEL: 'debug' })

    const remote = doc.servers.get('remote one')!
    expect(remote.values.url).toBe('https://example.com/mcp')
    expect(remote.values.bearer_token_env_var).toBe('EXAMPLE_TOKEN')
    expect(remote.values.http_headers).toEqual({ 'X-Team': 'core' })
    expect(remote.rawLines).toEqual([{ path: [], line: 'some_date = 1979-05-27T07:32:00Z' }])
  })

  it('reads inline-table servers under a bare [mcp_servers] header', () => {
    const doc = parseTomlMcpDocument('[mcp_servers]\nfoo = { command = "foo", args = ["a"] }\n')
    expect(doc.servers.get('foo')?.values).toEqual({ command: 'foo', args: ['a'] })
  })
})

describe('upsertTomlMcpServer / removeTomlMcpServer', () => {
  it('rewrites one server in place and leaves every other line untouched', () => {
    const doc = parseTomlMcpDocument(FIXTURE)
    const fs = doc.servers.get('filesystem')!
    fs.values.enabled = false
    const out = upsertTomlMcpServer(doc, fs)

    expect(out).toContain('# Codex config\nmodel = "gpt-5"\napproval_policy = "on-request"\n')
    expect(out).toContain('[projects."/home/me/repo"]\ntrust_level = "trusted"\n')
    expect(out).toContain('[mcp_servers."remote one"]\nurl = "https://example.com/mcp"')
    expect(out).toContain('some_date = 1979-05-27T07:32:00Z')

    const reparsed = parseTomlMcpDocument(out)
    expect(reparsed.servers.get('filesystem')!.values).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/me'],
      enabled: false,
      startup_timeout_sec: 20,
      disabled_tools: ['delete_file'],
      env: { LOG_LEVEL: 'debug' }
    })
    // Only one copy of the table survives.
    expect(out.match(/\[mcp_servers\.filesystem\]/g)).toHaveLength(1)
    expect(out.match(/\[mcp_servers\.filesystem\.env\]/g)).toHaveLength(1)
  })

  it('preserves unparsed lines through a rewrite', () => {
    const doc = parseTomlMcpDocument(FIXTURE)
    const remote = doc.servers.get('remote one')!
    remote.values.enabled = false
    const out = upsertTomlMcpServer(doc, remote)
    expect(out).toContain('some_date = 1979-05-27T07:32:00Z')
    expect(parseTomlMcpDocument(out).servers.get('remote one')!.values.enabled).toBe(false)
  })

  it('appends a new server at the end and removes a server cleanly', () => {
    const doc = parseTomlMcpDocument(FIXTURE)
    const added = upsertTomlMcpServer(doc, { name: 'new-one', values: { command: 'x', env: { A: 'b' } }, rawLines: [] })
    expect(added.trimEnd().endsWith('[mcp_servers.new-one.env]\nA = "b"')).toBe(true)
    expect(parseTomlMcpDocument(added).servers.size).toBe(3)

    const removed = removeTomlMcpServer(parseTomlMcpDocument(added), 'filesystem')
    const reparsed = parseTomlMcpDocument(removed)
    expect([...reparsed.servers.keys()]).toEqual(['remote one', 'new-one'])
    expect(removed).not.toContain('LOG_LEVEL')
    expect(removed).toContain('[projects."/home/me/repo"]')
  })

  it('renders keys that need quoting and escapes string values', () => {
    const lines = renderTomlMcpServer({ name: 'my server', values: { command: 'a"b', http_headers: { 'X-Y': 'v' } }, rawLines: [] })
    expect(lines).toEqual(['[mcp_servers."my server"]', 'command = "a\\"b"', '', '[mcp_servers."my server".http_headers]', 'X-Y = "v"'])
  })
})
