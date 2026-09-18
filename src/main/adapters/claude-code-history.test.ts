import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => home.dir
}))

import { cleanSessionFile, loadSessionHistory } from './claude-code-history'

const SESSION_ID = '0b5e2d3c-1111-4222-8333-944445555666'
const WORKSPACE = '/work/space'

function writeSession(entries: unknown[]): string {
  const dir = join(home.dir, '.claude', 'projects', '-work-space')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${SESSION_ID}.jsonl`)
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return file
}

describe('claude-code-history', () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), 'claude-history-'))
  })

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true })
  })

  // Claude Code stores typed user prompts as a plain string, not a block array.
  const stringPrompt = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello there' } }
  const assistantReply = {
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }
  }
  const emptyText = { type: 'assistant', uuid: 'a2', message: { id: 'msg_2', content: [{ type: 'text', text: '  ' }] } }

  it('loads history that contains string message content', () => {
    writeSession([stringPrompt, assistantReply])

    const messages = loadSessionHistory(SESSION_ID, WORKSPACE)

    expect(messages.flatMap((message) => message.parts.map((part) => part.text))).toContain('Hi!')
  })

  it('removes empty text blocks while keeping string-content prompts', () => {
    const file = writeSession([stringPrompt, emptyText, assistantReply])

    cleanSessionFile(SESSION_ID, WORKSPACE)

    const uuids = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line).uuid)
    expect(uuids).toEqual(['u1', 'a1'])
  })
})
