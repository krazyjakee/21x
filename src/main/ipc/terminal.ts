import { guardedIpcSend } from '../guarded-ipc-send'
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readlink } from 'fs/promises'
import { guardChildStreams, writeToChildStdin } from '../child-stream-guards'
import { execFileAsync } from '../find-executable'

// Each terminal is identified by a renderer-chosen ID. The renderer creates,
// writes and resizes terminals via IPC and receives output via 'terminal:data'.
//
// On macOS/Linux a real PTY comes from Python's pty module. This avoids
// node-pty (which requires a native module rebuild for Electron) and macOS
// `script` (which fails with piped stdio). Windows uses node-pty / ConPTY.

/** Lines kept per terminal for agent log queries. */
const TERMINAL_BUFFER_MAX_LINES = 500

const ANSI_ESCAPES = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

interface TerminalHandle {
  write: (data: string) => void
  resize?: (cols: number, rows: number) => void
  kill: () => void
  pid: number
  /** Recent output lines, ANSI-stripped, capped at TERMINAL_BUFFER_MAX_LINES. */
  outputBuffer: string[]
}

interface PtyOptions {
  shellPath: string
  cols: number
  rows: number
  cwd?: string
  onData: (data: string) => void
  onExit: (pid: number, code: unknown, signal: unknown) => void
}

function resolveShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
  return candidates.find((s) => existsSync(s)) || '/bin/sh'
}

function appendToBuffer(buffer: string[], raw: string): void {
  for (const line of raw.replace(ANSI_ESCAPES, '').split('\n')) {
    if (line.trim()) buffer.push(line)
  }
  if (buffer.length > TERMINAL_BUFFER_MAX_LINES) buffer.splice(0, buffer.length - TERMINAL_BUFFER_MAX_LINES)
}

function createNodePty({ shellPath, cols, rows, cwd, onData, onExit }: PtyOptions): TerminalHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty')
  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.HOME || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  const outputBuffer: string[] = []
  ptyProcess.onData((data: string) => {
    appendToBuffer(outputBuffer, data)
    onData(data)
  })
  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => onExit(ptyProcess.pid, exitCode, signal))

  return {
    write: (data: string) => {
      // node-pty throws once the pty is gone. Losing keystrokes to a dead
      // terminal is acceptable; crashing the application is not.
      try {
        ptyProcess.write(data)
      } catch { /* the pty went away */ }
    },
    resize: (c: number, r: number) => ptyProcess.resize(c, r),
    kill: () => {
      try { ptyProcess.kill() } catch { /* already exited */ }
    },
    pid: ptyProcess.pid,
    outputBuffer,
  }
}

/**
 * Python's pty.openpty() creates a real PTY master/slave pair; the script forks
 * and execs the shell on the slave side, then bridges stdin -> master and
 * master -> stdout with select(). Our side only ever sees regular pipes, so
 * there are no tcgetattr issues, yet the shell gets a fully interactive
 * terminal with colors and cursor control.
 */
const PYTHON_PTY_SCRIPT = `
import pty, os, sys, select, signal, struct, fcntl, termios

shell = sys.argv[1]
cols = int(sys.argv[2])
rows = int(sys.argv[3])

master, slave = pty.openpty()

# Set initial window size on the PTY
winsize = struct.pack('HHHH', rows, cols, 0, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)

pid = os.fork()
if pid == 0:
    # Child: set up slave as controlling terminal
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    env = dict(os.environ)
    env['TERM'] = 'xterm-256color'
    env['COLUMNS'] = str(cols)
    env['LINES'] = str(rows)
    os.execvpe(shell, [shell], env)
else:
    # Parent: bridge stdin <-> master fd
    os.close(slave)
    # Make stdin non-blocking
    import errno
    stdin_fd = sys.stdin.fileno()
    fl = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    try:
        while True:
            try:
                rlist, _, _ = select.select([master, stdin_fd], [], [], 0.05)
            except (select.error, ValueError):
                break
            if master in rlist:
                try:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except OSError:
                    break
            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        break
                    os.write(master, data)
                except OSError as e:
                    if e.errno != errno.EAGAIN:
                        break
    except KeyboardInterrupt:
        pass
    finally:
        os.close(master)
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        os.waitpid(pid, 0)
`

function createPythonPty({ shellPath, cols, rows, cwd, onData, onExit }: PtyOptions): TerminalHandle {
  const child = spawn('python3', ['-u', '-c', PYTHON_PTY_SCRIPT, shellPath, String(cols || 80), String(rows || 24)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: cwd || process.env.HOME || process.cwd(),
    env: { ...process.env } as Record<string, string>,
  })

  // Every pipe needs an error listener before the first write. The shell can
  // exit at any moment, and an unhandled EPIPE on its stdin crashes the main
  // process.
  guardChildStreams(child, 'Terminal')

  const outputBuffer: string[] = []
  // stderr is forwarded too, e.g. for shell startup errors.
  const forward = (data: Buffer): void => {
    const str = data.toString()
    appendToBuffer(outputBuffer, str)
    onData(str)
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)
  child.on('exit', (code, signal) => onExit(child.pid || 0, code, signal))

  return {
    // A `writable` check alone races the child's exit; the write itself must
    // not throw either.
    write: (data: string) => writeToChildStdin(child, data, 'Terminal'),
    kill: () => {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    },
    pid: child.pid || 0,
    outputBuffer,
  }
}

/** Direct children of a process; empty when there are none (pgrep exits 1). */
async function childPids(pid: number, timeout: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout })
    return stdout.split('\n').map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The PTY process forks the shell, so the shell's cwd is what matters, not
 * the PTY's. Follow the most recently forked child down (at most 6 levels)
 * to reach whatever is running in the foreground.
 */
async function deepestDescendant(pid: number): Promise<number> {
  let deepest = pid
  for (let depth = 0; depth < 6; depth++) {
    const children = await childPids(deepest, depth === 0 ? 2000 : 1000)
    if (children.length === 0) break
    deepest = children[children.length - 1]
  }
  return deepest
}

async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf-8', timeout: 2000 })
    const cwdLine = stdout.split('\n').find((l) => l.startsWith('n/'))
    return cwdLine ? cwdLine.slice(1) : null
  } catch {
    return null
  }
}

export function registerTerminalHandlers(): void {
  const terminals = new Map<string, TerminalHandle>()

  ipcMain.handle('terminal:create', async (event, { id, cols, rows, cwd }: { id: string; cols: number; rows: number; cwd?: string }) => {
    // Respawn after exit reuses the ID, so replace any existing terminal.
    const existing = terminals.get(id)
    if (existing) {
      try { existing.kill() } catch { /* already exited */ }
      terminals.delete(id)
    }

    const sender = event.sender
    const shellPath = resolveShell()
    console.log(`[Terminal] Creating terminal id=${id} shell=${shellPath} cols=${cols} rows=${rows} cwd=${cwd || '(default)'}`)

    const options: PtyOptions = {
      shellPath,
      cols,
      rows,
      cwd,
      onData: (data) => {
        if (!sender.isDestroyed()) guardedIpcSend(sender, 'terminal:data', { id, data })
      },
      onExit: (pid, code, signal) => {
        console.log(`[Terminal] PTY exited id=${id} code=${code} signal=${signal} pid=${pid}`)
        // When terminal:create replaces a PTY, the old one's exit fires
        // asynchronously and must NOT remove the new handle.
        if (terminals.get(id)?.pid !== pid) return
        terminals.delete(id)
        if (!sender.isDestroyed()) guardedIpcSend(sender, 'terminal:exit', { id })
      },
    }

    const handle = process.platform === 'win32' ? createNodePty(options) : createPythonPty(options)
    terminals.set(id, handle)
    return { pid: handle.pid }
  })

  ipcMain.handle('terminal:write', (_, { id, data }: { id: string; data: string }) => {
    const term = terminals.get(id)
    if (!term) {
      console.log(`[Terminal] write to dead terminal id=${id}`)
      return { alive: false }
    }
    term.write(data)
    return { alive: true }
  })

  ipcMain.handle('terminal:resize', (_, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    terminals.get(id)?.resize?.(cols, rows)
  })

  ipcMain.handle('terminal:getBuffer', (_, { id, lines }: { id: string; lines?: number }) => {
    const term = terminals.get(id)
    if (!term) return { lines: [] }
    return { lines: term.outputBuffer.slice(-Math.min(lines || 200, TERMINAL_BUFFER_MAX_LINES)) }
  })

  ipcMain.handle('terminal:kill', (_, { id, expectedPid }: { id: string; expectedPid?: number }) => {
    const term = terminals.get(id)
    if (!term) return
    // Ignore stale cleanup calls from an older terminal instance.
    if (expectedPid !== undefined && term.pid !== expectedPid) return
    term.kill()
    terminals.delete(id)
  })

  // Polled by the renderer, so every lookup is async and never blocks main.
  ipcMain.handle('terminal:getCwd', async (_, { id, expectedPid }: { id: string; expectedPid?: number }) => {
    const term = terminals.get(id)
    if (!term || process.platform === 'win32') return { cwd: null }
    if (expectedPid !== undefined && term.pid !== expectedPid) return { cwd: null }
    return { cwd: await processCwd(await deepestDescendant(term.pid)) }
  })
}
