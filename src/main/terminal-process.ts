import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readlink } from 'fs/promises'
import { guardChildStreams, writeToChildStdin } from './child-stream-guards'
import { execFileAsync } from './find-executable'
import type { TerminalHandle, PtyOptions } from './terminal-service-core'

export function resolveShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
  return candidates.find((s) => existsSync(s)) || '/bin/sh'
}

export function createNodePty(
  { shellPath, cols, rows, cwd, onData, onExit }: PtyOptions,
  // The standalone bootstrap passes its staged native module explicitly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty: Pick<typeof import('node-pty'), 'spawn'> = require('node-pty')
): TerminalHandle {
  const ptyProcess = pty.spawn(shellPath, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.HOME || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  let exited = false
  const subscriptions: { data?: { dispose(): void }; exit?: { dispose(): void } } = {}
  const dispose = (subscription: { dispose(): void } | undefined): void => {
    try { subscription?.dispose() } catch { /* Actual close must still reach the owner. */ }
  }
  subscriptions.data = ptyProcess.onData((data: string) => { if (!exited) onData(data) })
  subscriptions.exit = ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    if (exited) return
    exited = true
    // A kill request is not listener retirement. Preserve both subscriptions
    // through the real native exit, then release them before owner teardown.
    dispose(subscriptions.data); dispose(subscriptions.exit)
    onExit(ptyProcess.pid, exitCode, signal)
  })
  if (exited) dispose(subscriptions.exit)

  return {
    write: (data: string) => { if (exited) return false; ptyProcess.write(data); return undefined },
    resize: (c: number, r: number) => { if (exited) throw new Error('TERMINAL_PROCESS_EXITED'); ptyProcess.resize(c, r) },
    kill: () => { if (!exited) ptyProcess.kill() },
    pid: ptyProcess.pid,
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

export function createPythonPty({ shellPath, cols, rows, cwd, onData, onExit }: PtyOptions): TerminalHandle {
  const child = spawn('python3', ['-u', '-c', PYTHON_PTY_SCRIPT, shellPath, String(cols || 80), String(rows || 24)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: cwd || process.env.HOME || process.cwd(),
    env: { ...process.env } as Record<string, string>,
  })

  // Every pipe needs an error listener before the first write. The shell can
  // exit at any moment, and an unhandled EPIPE on its stdin crashes the main
  // process.
  guardChildStreams(child, 'Terminal')

  // stderr is forwarded too, e.g. for shell startup errors.
  const forward = (data: Buffer): void => {
    const str = data.toString()
    onData(str)
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)
  child.on('error', (error) => console.warn('[Terminal] Process error:', error.message))
  // A process exit can precede pipe close; retain the owner until close.
  child.on('close', (code, signal) => onExit(child.pid || 0, code, signal))

  return {
    // A `writable` check alone races the child's exit; the write itself must
    // not throw either.
    write: (data: string) => writeToChildStdin(child, data, 'Terminal'),
    kill: () => { child.kill('SIGTERM') },
    pid: child.pid || 0,
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
async function deepestDescendant(pid: number, isCurrent: () => boolean): Promise<number> {
  let deepest = pid
  for (let depth = 0; depth < 6 && isCurrent(); depth++) {
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

export async function terminalProcessCwd(pid: number, isCurrent: () => boolean): Promise<string | null> {
  if (process.platform === 'win32' || !isCurrent()) return null
  const deepest = await deepestDescendant(pid, isCurrent)
  return isCurrent() ? processCwd(deepest) : null
}
