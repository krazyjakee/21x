import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCrashEntry, crashEntry, installProductionCrashLog, MAX_CRASH_LOG_BYTES } from './production-crash-log'

const roots: string[] = []
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), '21x-crash-log-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const stream = (code: string): NodeJS.ErrnoException => Object.assign(new Error('write failed'), { code, syscall: 'write' })
const mode = (path: string): number => statSync(path).mode & 0o777
const logged = (root: string): string => readFileSync(join(root, 'logs', 'crash.log'), 'utf8')

describe('Tauri service crash log', () => {
  it('records uncaught errors and rejections with timestamp, kind, error and stack', () => {
    const root = profile(), source = new EventEmitter()
    installProductionCrashLog(root, source, 'linux')
    source.emit('uncaughtExceptionMonitor', new TypeError('NOT_A_FUNCTION'), 'uncaughtException')
    source.emit('uncaughtExceptionMonitor', new RangeError('OUT_OF_RANGE'), 'unhandledRejection')
    const text = logged(root)
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] uncaught-exception\nError: TypeError\nMessage: NOT_A_FUNCTION\nStack:\n\s+at /)
    expect(text).toMatch(/\] unhandled-rejection\nError: RangeError\nMessage: OUT_OF_RANGE\nStack:\n\s+at /)
    expect(text).toContain('production-crash-log.test.ts:')
  })

  it('marks a benign stream error, using the shared filter', () => {
    const root = profile(), source = new EventEmitter()
    installProductionCrashLog(root, source, 'linux')
    source.emit('uncaughtExceptionMonitor', stream('EPIPE'), 'uncaughtException')
    source.emit('uncaughtExceptionMonitor', stream('EACCES'), 'uncaughtException')
    const text = logged(root)
    expect(text).toMatch(/\] benign-stream-error\nError: Error\nCode: EPIPE\nSyscall: write\n/)
    expect(text).toMatch(/\] uncaught-exception\nError: Error\nCode: EACCES\nSyscall: write\n/)
  })

  it('withholds every message that is not a bare constant', () => {
    const secrets = ['Authorization: Bearer sk-ant-api03-abcdefghijklmnop', 'npm --token=ghp_0123456789abcdefghij publish', 'PROMPT the user typed in confidence',
      'https://example.test/hook?token=abc123', '{"message":"private transcript text"}', 'lowercase_constant_with_secret']
    for (const message of secrets) {
      const entry = crashEntry('uncaught-exception', new Error(message))
      expect(entry).toContain(`Message: withheld (${message.length} characters)`)
      expect(entry).not.toContain(message)
    }
    let parsed: unknown
    try { JSON.parse('private prompt text') } catch (error) { parsed = error }
    expect(crashEntry('uncaught-exception', parsed)).not.toContain('private prompt')
  })

  it('does not let a message or a query string pass as a stack frame', () => {
    const error = new Error('first line\n    at secretToken (file:///private.mjs:1:1)\n    at another private line')
    expect(crashEntry('uncaught-exception', error)).not.toMatch(/secretToken|another private/)
    const forged = new Error('ok')
    forged.stack = 'Error: ok\n    at run (file:///service/engine.mjs?token=abc123:10:5)\n    prompt text that is no frame\n    at prompt text with no location'
    const entry = crashEntry('uncaught-exception', forged)
    expect(entry).toContain('    at run (file:///service/engine.mjs:10:5)')
    expect(entry).not.toMatch(/abc123|prompt text/)
  })

  it('never reads environment or arguments, and records only the type of a thrown value', () => {
    const entry = crashEntry('unhandled-rejection', 'the rejected string is private')
    expect(entry).toContain('Value: string (not an Error)')
    expect(entry).not.toContain('private')
    expect(crashEntry('unhandled-rejection', null)).toContain('Value: null (not an Error)')
    const root = profile(), source = new EventEmitter(), marker = 'crash-log-environment-marker'
    process.env.TWENTYONEX_CRASH_LOG_TEST = marker; process.argv.push(marker)
    try {
      installProductionCrashLog(root, source, 'linux')
      source.emit('uncaughtExceptionMonitor', new Error('FAILED'), 'uncaughtException')
    } finally { delete process.env.TWENTYONEX_CRASH_LOG_TEST; process.argv.pop() }
    expect(logged(root)).not.toContain(marker)
  })

  it('bounds its own entry however deep the stack is', () => {
    const error = new Error('DEEP')
    error.stack = `Error: DEEP\n${`    at ${'x'.repeat(5000)} (file:///a.mjs:1:1)\n`.repeat(500)}`
    expect(Buffer.byteLength(crashEntry('uncaught-exception', error))).toBeLessThan(10_500)
  })

  it('keeps the folder 0700 and the file 0600, tightening what already exists', () => {
    const root = profile(), directory = join(root, 'logs'), file = join(directory, 'crash.log')
    appendCrashEntry(directory, 'first\n')
    expect(mode(directory)).toBe(0o700)
    expect(mode(file)).toBe(0o600)
    chmodSync(directory, 0o755); chmodSync(file, 0o644)
    appendCrashEntry(directory, 'second\n')
    expect(mode(directory)).toBe(0o700)
    expect(mode(file)).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
  })

  it('rotates once at the bound and keeps a single old file', () => {
    const root = profile(), directory = join(root, 'logs'), file = join(directory, 'crash.log')
    mkdirSync(directory)
    writeFileSync(file, 'x'.repeat(MAX_CRASH_LOG_BYTES - 1))
    appendCrashEntry(directory, 'entry\n')
    expect(readFileSync(file, 'utf8')).toBe('entry\n')
    expect(statSync(`${file}.1`).size).toBe(MAX_CRASH_LOG_BYTES - 1)
    writeFileSync(file, 'y'.repeat(MAX_CRASH_LOG_BYTES))
    appendCrashEntry(directory, 'later\n')
    expect(readdirSync(directory).sort()).toEqual(['crash.log', 'crash.log.1'])
    expect(readFileSync(`${file}.1`, 'utf8').startsWith('y')).toBe(true)
    expect(statSync(`${file}.1`).size).toBe(MAX_CRASH_LOG_BYTES)
  })

  it('refuses planted links and hard links, and never throws', () => {
    const root = profile(), elsewhere = join(root, 'elsewhere'), target = join(root, 'target')
    mkdirSync(elsewhere); writeFileSync(target, 'untouched')
    const linkedFolder = join(root, 'linked-folder'); symlinkSync(elsewhere, linkedFolder)
    appendCrashEntry(linkedFolder, 'entry\n')
    expect(readdirSync(elsewhere)).toEqual([])
    const folder = join(root, 'logs'); mkdirSync(folder)
    symlinkSync(target, join(folder, 'crash.log'))
    appendCrashEntry(folder, 'entry\n')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    rmSync(join(folder, 'crash.log')); linkSync(target, join(folder, 'crash.log'))
    appendCrashEntry(folder, 'entry\n')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    const blocked = join(root, 'blocked'); writeFileSync(blocked, 'a file where the folder goes')
    expect(() => appendCrashEntry(blocked, 'entry\n')).not.toThrow()
    expect(() => appendCrashEntry(join(blocked, 'below'), 'entry\n')).not.toThrow()
    expect(readFileSync(blocked, 'utf8')).toBe('a file where the folder goes')
  })

  it('survives a thrown value with hostile getters', () => {
    const root = profile(), source = new EventEmitter()
    installProductionCrashLog(root, source, 'linux')
    const hostile = Object.defineProperty(new Error('x'), 'stack', { get() { throw new Error('getter') } })
    expect(() => source.emit('uncaughtExceptionMonitor', hostile, 'uncaughtException')).not.toThrow()
  })

  it('writes nothing until something crashes, and stops when removed', () => {
    const root = profile(), source = new EventEmitter()
    const remove = installProductionCrashLog(root, source, 'linux')
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(1)
    remove()
    expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(0)
    source.emit('uncaughtExceptionMonitor', new Error('LATE'), 'uncaughtException')
    expect(existsSync(join(root, 'logs'))).toBe(false)
  })

  it('makes no behaviour claim on Windows or macOS', () => {
    const root = profile(), source = new EventEmitter(), on = vi.spyOn(source, 'on')
    for (const platform of ['win32', 'darwin'] as const) installProductionCrashLog(root, source, platform)()
    expect(on).not.toHaveBeenCalled()
    expect(lstatSync(root).isDirectory()).toBe(true)
    expect(existsSync(join(root, 'logs'))).toBe(false)
  })
})
