import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const script = readFileSync(resolve('src-tauri/src/artifact-frame-proof.js'), 'utf8')

function frame(native?: { core: { invoke: ReturnType<typeof vi.fn> }; event: { listen: ReturnType<typeof vi.fn> } }) {
  const completed: Record<string, unknown>[] = []
  let receive!: (event: unknown) => void
  const parent = {
    get document(): never { throw new Error('Opaque origin') },
    get __TAURI__(): never { throw new Error('Opaque origin') },
    postMessage(message: { kind: string; command?: string }) {
      if (message.kind === 'artifact-attempt') {
        queueMicrotask(() => receive({ source: parent, data: { kind: 'artifact-result', command: message.command, denied: true } }))
      } else if (message.kind === 'artifact-complete') completed.push(message)
    }
  }
  const window = { __TAURI__: native, addEventListener: (_name: string, callback: typeof receive) => { receive = callback } }
  runInNewContext(script, { window, parent, setTimeout, clearTimeout })
  receive({ source: parent, data: { kind: 'artifact-start', engineEpoch: 'current-epoch' } })
  return { completed, receive, parent }
}

describe('opaque artifact frame diagnostic', () => {
  afterEach(() => vi.useRealTimers())

  it('records API absence without inventing direct native denials', async () => {
    const { completed } = frame()
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]).toMatchObject({ frameBridgeAbsent: true, directAttempted: false,
      directDesktopDenied: false, directStatusDenied: false, directListenDenied: false,
      parentAccessDenied: true, parentGlobalDenied: true, relayDesktopDenied: true, relayStatusDenied: true, relayListenDenied: true })
  })

  it.each([{ code: 'UNAUTHORIZED' }, 'plugin:event|listen not allowed'])('requires native authorization errors when APIs are injected: %s', async error => {
    const native = { core: { invoke: vi.fn(async () => { throw error }) }, event: { listen: vi.fn(async () => { throw error }) } }
    const { completed } = frame(native)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(native.core.invoke).toHaveBeenNthCalledWith(1, 'desktop_invoke', {
      operation: 'db:getTasks', payload: {}, engineEpoch: 'current-epoch'
    })
    expect(native.core.invoke).toHaveBeenNthCalledWith(2, 'engine_status', {})
    expect(native.event.listen).toHaveBeenCalledWith('desktop:event', expect.any(Function))
    expect(completed[0]).toMatchObject({ frameBridgeAbsent: false, directAttempted: true,
      directDesktopDenied: true, directStatusDenied: true, directListenDenied: true,
      directDeadlineReached: false, directUnrecognizedFailure: false, directAccepted: false })
  })

  it('fails direct authorization if a native call or subscription succeeds', async () => {
    const unlisten = vi.fn()
    const native = { core: { invoke: vi.fn(async () => ({})) }, event: { listen: vi.fn(async () => unlisten) } }
    const { completed } = frame(native)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]).toMatchObject({ directDesktopDenied: false, directStatusDenied: false,
      directListenDenied: false, directAccepted: true })
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('does not mistake an unknown transport failure for native authorization denial', async () => {
    const native = { core: { invoke: vi.fn(async () => { throw new Error('Network failed') }) },
      event: { listen: vi.fn(async () => { throw new Error('Callback unavailable') }) } }
    const { completed } = frame(native)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]).toMatchObject({ directDesktopDenied: false, directStatusDenied: false,
      directListenDenied: false, directUnrecognizedFailure: true, directAccepted: false })
  })

  it('keeps a native deadline distinct from a recognized authorization denial', async () => {
    vi.useFakeTimers()
    const native = { core: { invoke: vi.fn(() => new Promise(() => {})) }, event: { listen: vi.fn(() => new Promise(() => {})) } }
    const { completed } = frame(native)
    await vi.advanceTimersByTimeAsync(6001)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ directDesktopDenied: false, directStatusDenied: false,
      directListenDenied: false, directDeadlineReached: true, directUnrecognizedFailure: false })
  })
})
