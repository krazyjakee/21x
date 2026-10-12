import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptPage, TranscriptPageRequest } from '@shared/transcript-page'
import type { TauriDesktopApi } from './tauri-desktop-transport'
import { mountSyntheticTaskSlice } from '../../../tauri-spike/task-slice'

const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  read: vi.fn<(taskId: string, page: TranscriptPageRequest, options: { signal: AbortSignal }) => Promise<TranscriptPage>>()
}))
vi.mock('./desktop-client', () => ({ DesktopClient: class {
  connection = { status: 'ready', engineEpoch: 'fixture' }
  async connect() {}
  subscribe(operation: string, callback: (value: unknown) => void) { fixture.listeners.set(operation, callback) }
  async invoke(operation: string, args: [string, TranscriptPageRequest], options: { signal: AbortSignal }) {
    if (operation === 'db:getTasks') return [{ id: 'task-1', title: 'First task' }, { id: 'task-2', title: 'Second task' }]
    if (operation === 'agentSession:getTranscriptPage') return fixture.read(args[0], args[1], options)
    throw new Error('Unexpected fixture operation')
  }
  dispose() {}
} }))
vi.mock('./tauri-desktop-transport', () => ({ createTauriDesktopTransport: () => ({}), getTauriEngineEpoch: async () => 'fixture' }))

function reply(taskId: string, request: TranscriptPageRequest, watermark = 1): TranscriptPage {
  return { version: 1, taskId, mode: request.mode, after: request.after, watermark, hasMore: false,
    cursor: request.mode === 'snapshot' ? 1 : watermark,
    parts: request.mode === 'snapshot' ? [{ taskId, partId: 'part', seq: 1, rev: watermark, content: `Saved ${taskId}`, role: 'assistant', createdAt: 1, updatedAt: 1 }] : [] }
}
function click(index = 0): void { document.querySelectorAll<HTMLButtonElement>('#database-tasks button')[index].click() }
function invalidate(maxRev: number): void { fixture.listeners.get('transcript:changed')!({ taskId: 'task-1', parts: [], maxRev, reloadRequired: true }) }
beforeEach(async () => {
  fixture.listeners.clear(); fixture.read.mockReset()
  fixture.read.mockImplementation(async (taskId, request) => reply(taskId, request))
  document.body.innerHTML = '<section id="database-slice" hidden><p id="database-status"></p><ul id="database-tasks"></ul><pre id="database-transcript"></pre><form id="database-create"><input id="database-title"><button>Create</button></form></section>'
  await mountSyntheticTaskSlice({} as TauriDesktopApi)
})
afterEach(() => { window.dispatchEvent(new Event('beforeunload')); document.body.replaceChildren() })

describe('mounted Tauri transcript recovery', () => {
  it('renders a selected task after snapshot and delta hydration', async () => {
    click()
    await vi.waitFor(() => expect(document.querySelector('#database-transcript')!.textContent).toBe('Saved task-1'))
    expect(fixture.read.mock.calls.map(call => call[1].mode)).toEqual(['snapshot', 'delta'])
    expect(document.querySelector('#database-status')!.textContent).not.toContain('failed')
  })

  it('coalesces repeated overflow events while a read is active', async () => {
    let release!: (page: TranscriptPage) => void
    fixture.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    fixture.read.mockImplementation(async (taskId, request) => reply(taskId, request, 4))
    click()
    await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(1))
    invalidate(2); invalidate(4)
    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.read.mock.calls[0][2].signal.aborted).toBe(false)
    release(reply('task-1', { version: 1, mode: 'snapshot', after: 0 }, 1))
    await vi.waitFor(() => expect(document.querySelector('#database-transcript')!.textContent).toBe('Saved task-1'))
    expect(fixture.read).toHaveBeenCalledTimes(2)
  })

  it('ignores an old task reply after selection changes', async () => {
    let release!: (page: TranscriptPage) => void
    fixture.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    click()
    await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(1))
    click(1)
    await vi.waitFor(() => expect(document.querySelector('#database-transcript')!.textContent).toBe('Saved task-2'))
    release(reply('task-1', { version: 1, mode: 'snapshot', after: 0 }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.querySelector('#database-transcript')!.textContent).toBe('Saved task-2')
  })
})
