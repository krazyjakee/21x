import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { execFile, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  listSystemVoices,
  parseEspeakVoices,
  parseSayVoices,
  parseWindowsVoices,
  pickDefaultSystemVoice,
  systemVoiceId,
  systemVoiceName,
  VoiceSystemVoicesOwner,
  type VoiceSystemVoicesHost,
} from './voice-system-voices'

/**
 * The system voice is the half of the design that costs nothing, so its list
 * has to be read correctly on all three systems. The parsers are tested against
 * real output rather than against the machine this runs on.
 */

describe('parseSayVoices', () => {
  const SAY_OUTPUT = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Majed               ar_001   # مرحبًا! اسمي ماجد.',
    '',
  ].join('\n')

  it('reads a name that holds spaces and brackets', () => {
    const voices = parseSayVoices(SAY_OUTPUT)
    const eddy = voices.find((v) => v.label.startsWith('Eddy'))
    expect(eddy?.label).toBe('Eddy (English (UK))')
    expect(eddy?.language).toBe('en-GB')
    expect(eddy?.id).toBe('system:Eddy (English (UK))')
  })

  it('reads every voice and marks them all as system voices', () => {
    const voices = parseSayVoices(SAY_OUTPUT)
    expect(voices).toHaveLength(5)
    expect(voices.every((v) => v.engine === 'system' && v.speakerId === 0)).toBe(true)
  })

  it('reads a language tag that holds digits', () => {
    const majed = parseSayVoices(SAY_OUTPUT).find((v) => v.label === 'Majed')
    expect(majed?.language).toBe('ar-001')
  })

  it('ignores an empty line', () => {
    expect(parseSayVoices('\n\n')).toEqual([])
  })
})

describe('portable system voice enumeration owner', () => {
  it('refuses executable effects when the actual host capability is unavailable', async () => {
    const execute = vi.fn<typeof execFile>()
    const owner = new VoiceSystemVoicesOwner({ platform: 'linux', capability: 'unavailable', executable: null, env: {}, execFile: execute as unknown as typeof execFile, assertCurrent() {} })
    expect(await owner.list()).toEqual([]); expect(execute).not.toHaveBeenCalled(); await owner.close()
    expect(() => owner.list()).toThrow('VOICE_SYSTEM_VOICES_CLOSED')
  })
  it('retains early error callbacks until actual close, including ignored termination and retry', async () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn(() => true)
    // Spawn failures can deliver execFile callback before native close. This
    // synchronous callback also checks that child assignment is never assumed.
    const execute = ((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => { callback(new Error('Private executable path'), '', ''); return child }) as VoiceSystemVoicesHost['execFile']
    const owner = new VoiceSystemVoicesOwner({ platform: 'linux', capability: 'available', executable: process.execPath, env: {}, execFile: execute as unknown as typeof execFile, assertCurrent() {} })
    const listing = owner.list(); const failure = listing.catch(error => error)
    expect(owner.inflightCount).toBe(1)
    await expect(owner.close(5)).rejects.toThrow('VOICE_SYSTEM_VOICES_SHUTDOWN_INCOMPLETE')
    expect(owner.inflightCount).toBe(1); expect(child.kill).toHaveBeenCalled()
    child.emit('close', -1, null); expect(await failure).toBeInstanceOf(Error)
    await owner.close(); expect(owner.inflightCount).toBe(0)
  })
  it('waits for buffered output after close before accepting a list and rechecks current ownership', async () => {
    const child = new EventEmitter() as ChildProcess; child.kill = vi.fn(() => true)
    let callback!: (error: Error | null, stdout: string, stderr: string) => void, current = true
    const execute = ((_file: string, _args: string[], _options: unknown, done: typeof callback) => { callback = done; return child }) as VoiceSystemVoicesHost['execFile']
    const owner = new VoiceSystemVoicesOwner({ platform: 'darwin', capability: 'available', executable: process.execPath, env: {}, execFile: execute as unknown as typeof execFile, assertCurrent() { if (!current) throw new Error('Owner withdrawn') } })
    const listing = owner.list(); const failure = listing.catch(error => error); child.emit('close', 0, null)
    expect(owner.inflightCount).toBe(1); current = false; callback(null, 'Samantha en_US # Hello', '')
    expect(await failure).toBeInstanceOf(Error); await owner.close(); expect(owner.inflightCount).toBe(0)
  })
  it.skipIf(Boolean(process.versions.electron))('owns a real Node execFile spawn-error through native close without exposing its path', async () => {
    const owner = new VoiceSystemVoicesOwner({ platform: 'linux', capability: 'available', executable: join(tmpdir(), '21x-nonexistent-system-voice-command'), env: {}, execFile, assertCurrent() {} })
    try { const listing = owner.list(); expect(owner.inflightCount).toBe(1); expect(await listing).toEqual([]); expect(owner.inflightCount).toBe(0) }
    finally { await owner.close() }
  })
})

describe('parseWindowsVoices', () => {
  it('reads the name, the language and the sex', () => {
    const voices = parseWindowsVoices('Microsoft Zira Desktop|en-US|Female\r\nMicrosoft David|en-US|Male\r\n')
    expect(voices).toHaveLength(2)
    expect(voices[0].id).toBe('system:Microsoft Zira Desktop')
    expect(voices[0].language).toBe('en-US')
    expect(voices[0].description).toBe('Female.')
  })

  it('ignores a line with no language', () => {
    expect(parseWindowsVoices('rubbish\n')).toEqual([])
  })
})

describe('parseEspeakVoices', () => {
  it('reads the language and the name', () => {
    const output = [
      'Pty Language       Age/Gender VoiceName          File                 Other Languages',
      ' 5  en-gb          --/M      English (Great Britain)  gmw/en',
      ' 5  en-us          --/M      English (America)        gmw/en-US',
    ].join('\n')
    const voices = parseEspeakVoices(output)
    expect(voices).toHaveLength(2)
    expect(voices[0].id).toBe('system:en-gb')
    expect(voices[0].label).toBe('English (Great Britain)')
  })
})

describe('the chosen voice', () => {
  it('prefers an English voice', () => {
    const voices = parseSayVoices(
      ['Anna                de_DE    # Hallo!', 'Samantha            en_US    # Hello!'].join('\n')
    )
    expect(pickDefaultSystemVoice(voices)?.label).toBe('Samantha')
  })

  it('takes the first voice when none is English', () => {
    const voices = parseSayVoices('Anna                de_DE    # Hallo!')
    expect(pickDefaultSystemVoice(voices)?.label).toBe('Anna')
  })

  it('returns nothing when the system has no voice', () => {
    expect(pickDefaultSystemVoice([])).toBeNull()
  })
})

describe('voice IDs', () => {
  it('round-trips a name', () => {
    expect(systemVoiceName(systemVoiceId('Microsoft Zira Desktop'))).toBe('Microsoft Zira Desktop')
  })

  it('reads nothing out of an ID that is not a system voice', () => {
    expect(systemVoiceName('local:kokoro-en-v0_19:1')).toBe('')
  })
})

describe('listSystemVoices', () => {
  it('reports no voice on a system 20x cannot speak on', async () => {
    await expect(listSystemVoices('aix' as NodeJS.Platform)).resolves.toEqual([])
  })
})
