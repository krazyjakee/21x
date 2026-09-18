import { describe, it, expect } from 'vitest'
import {
  parseProcessTable,
  collectDescendantPids,
  selectKillableMcpPids,
  WINDOWS_PROCESS_TABLE_SCRIPT
} from './mcp-process-cleanup'

const MCP = '/path/to/Electron /repo/out/main/mcp-servers/task-management-mcp.js'

describe('parseProcessTable', () => {
  it('parses pid, ppid and the full command', () => {
    const rows = parseProcessTable(['  100     1 /usr/bin/opencode serve --port=4096', ' 101   100 ' + MCP].join('\n'))
    expect(rows).toEqual([
      { pid: 100, ppid: 1, command: '/usr/bin/opencode serve --port=4096' },
      { pid: 101, ppid: 100, command: MCP }
    ])
  })

  it('ignores the header and any malformed line', () => {
    const rows = parseProcessTable(['  PID  PPID COMMAND', '', ' 7 3 node x.js'].join('\n'))
    expect(rows).toEqual([{ pid: 7, ppid: 3, command: 'node x.js' }])
  })
})

describe('collectDescendantPids', () => {
  it('collects children through several levels', () => {
    const rows = parseProcessTable(
      [' 10 1 20x', ' 11 10 claude', ' 12 11 ' + MCP, ' 13 1 other-app'].join('\n')
    )
    expect(collectDescendantPids(rows, 10)).toEqual(new Set([11, 12]))
  })

  it('terminates on a self-parented row', () => {
    const rows = parseProcessTable([' 10 1 20x', ' 11 11 weird'].join('\n'))
    expect(collectDescendantPids(rows, 10)).toEqual(new Set())
  })
})

describe('selectKillableMcpPids', () => {
  it('kills its own MCP grandchild', () => {
    const rows = parseProcessTable([' 10 1 20x-main', ' 11 10 claude', ' 12 11 ' + MCP].join('\n'))
    expect(selectKillableMcpPids(rows, 10)).toEqual([12])
  })

  it('keeps the MCP children of another live instance', () => {
    // pid 20 is a second 20x instance with a running agent — its MCP child (22)
    // must survive our shutdown. This is the regression the blind pkill caused.
    const rows = parseProcessTable(
      [' 10 1 20x-main-ours', ' 11 10 claude', ' 12 11 ' + MCP, ' 20 1 20x-main-theirs', ' 21 20 claude', ' 22 21 ' + MCP].join('\n')
    )
    expect(selectKillableMcpPids(rows, 10)).toEqual([12])
  })

  it('kills parentless MCP processes, whose owner is already gone', () => {
    const rows = parseProcessTable([' 10 1 20x-main', ' 99 1 ' + MCP].join('\n'))
    expect(selectKillableMcpPids(rows, 10)).toEqual([99])
  })

  it('ignores processes that are not MCP servers', () => {
    const rows = parseProcessTable([' 10 1 20x-main', ' 11 10 node unrelated.js'].join('\n'))
    expect(selectKillableMcpPids(rows, 10)).toEqual([])
  })

  it('never selects the calling process itself', () => {
    const rows = parseProcessTable([' 10 1 ' + MCP].join('\n'))
    expect(selectKillableMcpPids(rows, 10)).toEqual([])
  })
})

describe('Windows process table', () => {
  const WIN_MCP = 'node C:\\Users\\u\\AppData\\Local\\Programs\\21x\\resources\\app.asar.unpacked\\out\\main\\mcp-servers\\task-management-mcp.js'

  it('parses CRLF output from the CIM query', () => {
    const rows = parseProcessTable(['10 4 C:\\21x\\21x.exe', '12 10 ' + WIN_MCP, ''].join('\r\n'))
    expect(rows).toEqual([
      { pid: 10, ppid: 4, command: 'C:\\21x\\21x.exe' },
      { pid: 12, ppid: 10, command: WIN_MCP }
    ])
  })

  it('treats a missing parent as orphaned, since Windows does not reparent', () => {
    const rows = parseProcessTable(['10 4 21x.exe', '99 555 ' + WIN_MCP].join('\n'))
    expect(selectKillableMcpPids(rows, 10, undefined, 'win32')).toEqual([99])
    // The Unix rule (ppid 1) must not apply: 555 is gone but is not 1.
    expect(selectKillableMcpPids(rows, 10, undefined, 'linux')).toEqual([])
  })

  it('keeps the MCP children of another live instance', () => {
    const rows = parseProcessTable(
      ['10 4 21x.exe', '11 10 claude.exe', '12 11 ' + WIN_MCP, '20 4 21x.exe', '21 20 claude.exe', '22 21 ' + WIN_MCP].join('\n')
    )
    expect(selectKillableMcpPids(rows, 10, undefined, 'win32')).toEqual([12])
  })

  it('does not treat a live parent with pid 1 as special on Windows', () => {
    const rows = parseProcessTable(['1 0 something', '10 4 21x.exe', '99 1 ' + WIN_MCP].join('\n'))
    expect(selectKillableMcpPids(rows, 10, undefined, 'win32')).toEqual([])
  })

  it('keeps the query free of double quotes so it passes as one -Command argument', () => {
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).not.toContain('"')
  })
})
