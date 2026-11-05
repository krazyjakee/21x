/**
 * Node half of the Tauri crash log: <Tauri profile>/logs/crash.log. The native
 * host appends to the same file (src-tauri/engine/src/production_crash.rs), with
 * the same bound. Linux only for now.
 *
 * It listens with `uncaughtExceptionMonitor`, which observes and changes nothing:
 * the service still ends as it always did. An `uncaughtException` or
 * `unhandledRejection` listener would keep a broken service running instead.
 * With no rejection listener, Node raises a rejection as an uncaught exception
 * and this monitor reports its origin.
 *
 * Any error message can quote a prompt, a token or a command line, and no filter
 * can recognise all of them. So an entry keeps the error's name, code, syscall and
 * stack frames, and keeps its message only when it is a bare constant.
 */
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { isBenignStreamError } from '../main/child-stream-guards'

/** One full log plus one rotated log is the most this ever keeps on disk. */
export const MAX_CRASH_LOG_BYTES = 1024 * 1024
const MAX_FRAMES = 32
const MAX_FRAME_LENGTH = 300
const FRAME = /^\s+at\s.*(?::\d+:\d+\)?|<anonymous>\)?|\(native\)|\(index \d+\))$/
const CONSTANT = /^[A-Z][A-Z0-9_]{1,63}$/
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type CrashKind = 'uncaught-exception' | 'unhandled-rejection' | 'benign-stream-error'
type CrashMonitor = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void
interface CrashSource {
  on(event: 'uncaughtExceptionMonitor', listener: CrashMonitor): unknown
  off(event: 'uncaughtExceptionMonitor', listener: CrashMonitor): unknown
}

function stackFrames(stack: string, message: string): string[] {
  // The header holds the message, whose own lines could pass for frames.
  const start = message ? stack.indexOf(message) : -1
  const body = start < 0 ? stack : stack.slice(start + message.length)
  return body.split('\n').filter(line => FRAME.test(line)).slice(0, MAX_FRAMES)
    .map(line => line.replace(/\?[^\s:)]*/g, '').slice(0, MAX_FRAME_LENGTH))
}

export function crashEntry(kind: CrashKind, error: unknown, now = new Date()): string {
  const lines = [`\n${'─'.repeat(60)}`, `[${now.toISOString()}] ${kind}`]
  if (!(error instanceof Error)) {
    lines.push(`Value: ${error === null ? 'null' : typeof error} (not an Error)`)
    return `${lines.join('\n')}\n`
  }
  const { code, syscall } = error as NodeJS.ErrnoException
  lines.push(`Error: ${IDENTIFIER.test(error.name) ? error.name : 'Error'}`)
  if (typeof code === 'string' && CONSTANT.test(code)) lines.push(`Code: ${code}`)
  if (typeof syscall === 'string' && IDENTIFIER.test(syscall)) lines.push(`Syscall: ${syscall}`)
  lines.push(`Message: ${CONSTANT.test(error.message) ? error.message : `withheld (${error.message.length} characters)`}`)
  lines.push('Stack:', ...stackFrames(error.stack ?? '', error.message))
  return `${lines.join('\n')}\n`
}

/** Never throws, and refuses a planted link at the folder or the file. */
export function appendCrashEntry(directory: string, entry: string): void {
  try {
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (!lstatSync(directory).isDirectory()) return
    chmodSync(directory, 0o700)
    const file = join(directory, 'crash.log')
    let existing: Stats | null = null
    try { existing = lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Two writers can rotate at once. The cost is losing the older rotated
    // entries; neither file can pass the bound.
    if (existing?.isFile() && existing.size + Buffer.byteLength(entry) > MAX_CRASH_LOG_BYTES) renameSync(file, `${file}.1`)
    const descriptor = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const info = fstatSync(descriptor)
      if (!info.isFile() || info.nlink !== 1) return
      fchmodSync(descriptor, 0o600)
      writeSync(descriptor, entry)
    } finally { closeSync(descriptor) }
  } catch { /* A crash log must never add a failure of its own. */ }
}

/** Call only once the profile lock is held. Returns the removal. */
export function installProductionCrashLog(profileRoot: string, source: CrashSource = process, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'linux') return () => {}
  const directory = join(profileRoot, 'logs')
  const monitor: CrashMonitor = (error, origin) => {
    try {
      const kind = isBenignStreamError(error) ? 'benign-stream-error' : origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception'
      appendCrashEntry(directory, crashEntry(kind, error))
    } catch { /* A hostile getter on the thrown value ends here. */ }
  }
  source.on('uncaughtExceptionMonitor', monitor)
  return () => { source.off('uncaughtExceptionMonitor', monitor) }
}
