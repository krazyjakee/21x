/**
 * Cleanup of leaked stdio MCP server processes.
 *
 * Every agent session attaches the task-management MCP server as a stdio child
 * process. Those children exit only when the process that owns their stdin pipe
 * exits, so they survive for as long as the agent CLI or the shared
 * `opencode serve` process does — hours or days.
 *
 * Shutdown used to run a blind `pkill -f task-management-mcp.js`. With two 20x
 * instances running (a packaged app and a dev build, which is normal on a
 * developer machine) quitting one instance killed the live MCP children of the
 * other, and its running agents lost every task-management tool. The selection
 * below is therefore scoped: only our own descendants, plus processes that have
 * already lost their parent, are killed.
 *
 * Windows used to run `taskkill /FI "WINDOWTITLE eq task-management-mcp*"`,
 * which matched nothing: a windowless node.exe has no title. It now reads the
 * process table through CIM and goes through the same scoped selection.
 */

import { execFile } from 'child_process'
import { setTimeout as sleep } from 'timers/promises'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** One row of the process table. */
export type ProcessRow = { pid: number; ppid: number; command: string }

/**
 * The stdio servers 20x spawns. Matched as a substring of the command.
 *
 * `codex app-server --stdio` is here for the boot pass. The Codex adapter stops
 * its own children now, and sweeps the ones that escape while it is running,
 * but neither survives a FORCE-QUIT: the app-servers are reparented to launchd,
 * each holding around a gigabyte and a duplicated
 * `@google-cloud/observability-mcp` child, and nothing collects them until the
 * machine reboots. At boot this instance has no descendants yet, so only those
 * parentless leftovers match; at shutdown it takes our own, after
 * `stopAllSessions` has had its turn. The substring covers both halves of the
 * pair — the node wrapper and the vendored binary run the same arguments.
 */
export const MCP_SCRIPT_MARKERS = ['task-management-mcp.js', 'codex app-server --stdio'] as const

/**
 * PowerShell script that prints the Windows process table in the same
 * `pid ppid command` shape as `ps -eo pid=,ppid=,command=`, so both platforms
 * share one parser. Contains no double quotes, so it survives being passed as a
 * single `-Command` argument.
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"

/**
 * Parses the output of `ps -eo pid=,ppid=,command=` (or
 * {@link WINDOWS_PROCESS_TABLE_SCRIPT}). Rows that do not start with two
 * integers are ignored.
 */
export function parseProcessTable(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of psOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

/**
 * Reads the Unix process table with `ps -eo pid=,ppid=,command=`. Bounded,
 * because callers run it at boot and inside a held-open quit.
 */
export async function readProcessTable(timeoutMs = 20_000): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,command='], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs
  })
  return parseProcessTable(stdout)
}

/**
 * SIGTERM, a grace period, then SIGKILL for whatever ignored it.
 *
 * There is a pid-reuse window between reading the table and signalling: a
 * selected process could exit and its number be handed to something else.
 * `kill(pid, 0)` proves a process exists, never that it is the same one. It is
 * not closable without a pidfd (Linux) or a kqueue handle per process, and a
 * second of window against days of leaked resources is the right trade.
 */
export async function terminatePids(pids: readonly number[], graceMs = 1500): Promise<void> {
  if (pids.length === 0) return
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone between the listing and the signal.
    }
  }
  await sleep(graceMs)
  for (const pid of pids) {
    try {
      process.kill(pid, 0) // throws when the process is gone
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone, which is the outcome we wanted.
    }
  }
}

/** All transitive children of `rootPid`, excluding `rootPid` itself. */
export function collectDescendantPids(rows: ProcessRow[], rootPid: number): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByParent.set(row.ppid, [row.pid])
  }

  const descendants = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const child of childrenByParent.get(current) ?? []) {
      // Guard against a cyclic or self-parented table so this cannot spin.
      if (child === current || descendants.has(child)) continue
      descendants.add(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * The MCP server processes that this instance may kill:
 *   - its own descendants, which no other instance can be using, and
 *   - orphans, whose owner is already gone.
 *
 * On Unix an orphan is reparented to pid 1. Windows does not reparent, so there
 * an orphan is a process whose parent pid is no longer in the table. A reused
 * parent pid only hides an orphan; it never exposes a live instance's child.
 *
 * MCP servers held by a live process that is not ours are left alone.
 */
export function selectKillableMcpPids(
  rows: ProcessRow[],
  ownPid: number,
  markers: readonly string[] = MCP_SCRIPT_MARKERS,
  platform: NodeJS.Platform = process.platform
): number[] {
  const descendants = collectDescendantPids(rows, ownPid)
  const livePids = new Set(rows.map((row) => row.pid))
  const isOrphan = (row: ProcessRow): boolean =>
    platform === 'win32' ? !livePids.has(row.ppid) : row.ppid === 1
  const killable: number[] = []
  for (const row of rows) {
    if (row.pid === ownPid) continue
    if (!markers.some((marker) => row.command.includes(marker))) continue
    if (descendants.has(row.pid) || isOrphan(row)) killable.push(row.pid)
  }
  return killable
}
