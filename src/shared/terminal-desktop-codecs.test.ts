import { describe, expect, it } from 'vitest'
import { TERMINAL_COMMAND_CODECS, TERMINAL_EVENT_CODECS, TERMINAL_DESKTOP_LIMITS, type TerminalDesktopOperation } from './terminal-desktop-codecs'

describe('exact native terminal codecs', () => {
  it('round-trips the six APIs and preserves real PID, null cwd, and void results', () => {
    const cases: Array<[TerminalDesktopOperation, unknown[]]> = [
      ['terminal:create', ['panel-1', 80, 24, '/server-selected/workspace']],
      ['terminal:write', ['panel-1', 'printf hello\r\x03\0']], ['terminal:resize', ['panel-1', 100, 40]],
      ['terminal:kill', ['panel-1', 4242]], ['terminal:getCwd', ['panel-1', 4242]], ['terminal:getBuffer', ['panel-1', 200]]
    ]
    for (const [operation, args] of cases) {
      const codec = TERMINAL_COMMAND_CODECS[operation]
      expect(codec.decodeArguments(codec.encodeArguments(args as never))).toEqual(args)
    }
    expect(TERMINAL_COMMAND_CODECS['terminal:create'].decodeResult({ pid: 4242 })).toEqual({ pid: 4242 })
    expect(TERMINAL_COMMAND_CODECS['terminal:getCwd'].decodeResult({ cwd: null })).toEqual({ cwd: null })
    expect(TERMINAL_COMMAND_CODECS['terminal:kill'].encodeResult(undefined)).toEqual({ defined: false })
    expect(TERMINAL_COMMAND_CODECS['terminal:write'].validateWireResult({ defined: false })).toBe(true)
    expect(TERMINAL_COMMAND_CODECS['terminal:write'].validateWireResult({ defined: true, value: null })).toBe(false)
    expect(TERMINAL_COMMAND_CODECS['terminal:write'].validateWireResult({ defined: true, value: undefined })).toBe(false)
    expect(TERMINAL_COMMAND_CODECS['terminal:kill'].decodeArguments({ id: 'panel-1' })).toEqual(['panel-1'])
  })
  it('rejects payload identity, replacement, shell/environment and arbitrary unknown fields', () => {
    for (const field of ['caller', 'engineEpoch', 'generation', 'replace', 'shellPath', 'env', 'projectId']) {
      expect(() => TERMINAL_COMMAND_CODECS['terminal:create'].decodeArguments({ id: 'panel-1', cols: 80, rows: 24, [field]: 'untrusted' })).toThrow()
    }
    expect(() => TERMINAL_COMMAND_CODECS['terminal:kill'].decodeArguments({ id: 'panel-1', pid: 4242 })).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:create'].encodeArguments(['../outside', 80, 24])).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:create'].encodeArguments(['panel-1', 0, 24])).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:create'].encodeArguments(['panel-1', 80, 24, '/path\0suffix'])).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:getCwd'].encodeArguments(['panel-1', -1])).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:getBuffer'].encodeArguments(['panel-1', 501])).toThrow()
    expect(TERMINAL_COMMAND_CODECS['terminal:create'].validateWireResult({ defined: true, value: { pid: 0 } })).toBe(false)
  })
  it('bounds UTF-8 writes, path bytes, event chunks, retained lines and encoded replay without truncation', () => {
    expect(() => TERMINAL_COMMAND_CODECS['terminal:write'].encodeArguments(['panel-1', 'x'.repeat(TERMINAL_DESKTOP_LIMITS.writeBytes)])).not.toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:write'].encodeArguments(['panel-1', '💬'.repeat(TERMINAL_DESKTOP_LIMITS.writeBytes / 4 + 1)])).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:create'].encodeArguments(['panel-1', 80, 24, '/'.concat('x'.repeat(TERMINAL_DESKTOP_LIMITS.pathBytes))])).toThrow()
    expect(() => TERMINAL_EVENT_CODECS['terminal:data'].encodePayload({ id: 'panel-1', data: 'x'.repeat(TERMINAL_DESKTOP_LIMITS.eventBytes + 1) })).toThrow()
    const original = { lines: ['first', 'retained \t line', 'last'] }
    expect(TERMINAL_COMMAND_CODECS['terminal:getBuffer'].decodeResult(original)).toEqual(original)
    expect(() => TERMINAL_COMMAND_CODECS['terminal:getBuffer'].encodeResult({ lines: Array(501).fill('line') })).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:getBuffer'].encodeResult({ lines: ['\0'.repeat(TERMINAL_DESKTOP_LIMITS.bufferBytes / 6)] })).toThrow()
    expect(() => TERMINAL_COMMAND_CODECS['terminal:getBuffer'].encodeResult({ lines: ['x'.repeat(TERMINAL_DESKTOP_LIMITS.bufferBytes)] })).toThrow()
  })
  it('keeps control bytes and actual exit identity while refusing nonstring byte objects and false exits', () => {
    const event = { id: 'panel-1', data: '\x1b[31mred\x1b[0m\r\n\x07\0' }
    expect(TERMINAL_EVENT_CODECS['terminal:data'].decodePayload(TERMINAL_EVENT_CODECS['terminal:data'].encodePayload(event))).toEqual(event)
    expect(TERMINAL_EVENT_CODECS['terminal:data'].validatePayload({ id: 'panel-1', data: new Uint8Array([1]) })).toBe(false)
    expect(TERMINAL_EVENT_CODECS['terminal:exit'].validatePayload({ id: 'panel-1', requested: true })).toBe(false)
    expect(TERMINAL_EVENT_CODECS['terminal:exit'].decodePayload({ id: 'panel-1' })).toEqual({ id: 'panel-1' })
  })
})
