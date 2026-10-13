import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const matcher = readFileSync(resolve('src-tauri/src/artifact-denial-matcher.js'), 'utf8')
const script = readFileSync(resolve('src-tauri/src/artifact-frame-proof.js'), 'utf8').replace('__21X_DENIAL_MATCHER__', matcher)

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
  const window = { __TAURI__: native, origin: 'null', location: { protocol: 'artifact-proof:', hostname: 'localhost' },
    addEventListener: (_name: string, callback: typeof receive) => { receive = callback } }
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

  it.each(['native-code', 'release-acl', 'debug-acl'])('requires native authorization errors when APIs are injected: %s', async format => {
    const error = (raw: string, pretty: string) => format === 'native-code' ? { code: 'UNAUTHORIZED' }
      : format === 'release-acl' ? `Command ${raw} not allowed by ACL`
        : `${pretty} not allowed on window "artifact-proof", webview "artifact-proof", URL: local\n\nallowed on: [windows: "main", URL: local]\n\nreferenced by: capability: main, permission: allow-command`
    const native = { core: { invoke: vi.fn(async command => { throw error(command, command) }) },
      event: { listen: vi.fn(async () => { throw error('plugin:event|listen', 'event.listen') }) } }
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

  it.each(['engine_status not allowed. Command not found', 'event.listen not allowed. Plugin not found',
    'Network permission denied', 'desktop_invoke not authorized', 'Command other_command not allowed by ACL'])
  ('rejects unrelated denial text and missing native commands: %s', async error => {
    const native = { core: { invoke: vi.fn(async () => { throw error }) },
      event: { listen: vi.fn(async () => { throw error }) } }
    const { completed } = frame(native)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]).toMatchObject({ directDesktopDenied: false, directStatusDenied: false,
      directListenDenied: false, directUnrecognizedFailure: true, directAccepted: false })
  })

  it.each([
    ['Origin header is not a valid URL', 'directInvalidOrigin'],
    ['missing Origin header', 'directMissingOrigin']
  ])('classifies pinned origin parser error without treating it as authorization: %s', async (error, key) => {
    const native = { core: { invoke: vi.fn(async () => { throw error }) },
      event: { listen: vi.fn(async () => { throw error }) } }
    const { completed } = frame(native)
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(completed[0]).toMatchObject({ [key]: true, directStringError: true,
      directDesktopDenied: false, directStatusDenied: false, directListenDenied: false,
      directUnrecognizedFailure: true, directAccepted: false, directDeadlineReached: false })
    expect(completed[0]).toMatchObject({
      directDesktopOriginRejected: key === 'directInvalidOrigin',
      directStatusOriginRejected: key === 'directInvalidOrigin',
      directListenOriginRejected: key === 'directInvalidOrigin'
    })
  })
})
