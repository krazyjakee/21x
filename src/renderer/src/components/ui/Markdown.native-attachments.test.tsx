import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Buffer } from 'node:buffer'
import { createElectronHost, installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { retireAttachmentImagePreviews } from '@/lib/attachment-image-preview'
import { Markdown } from './Markdown'

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }))
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGMUVDJmYGBgYGBgYoABAAdGAGpAmhbFAAAAAElFTkSuQmCC'
const GIF = 'R0lGODdhAwACAIEAABEiMwAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7'
const WEBP = 'UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoDAAIAAUAmJYwCdAFAAAD++xnLAkrVm6cszhXnwAA='
const image = { mimeType: 'image/png', data: PNG }
const id = (index = 1) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const url = (index = 1) => `app-attachment://Task_A/${id(index)}`
const markup = (count = 1, start = 1) => Array.from({ length: count }, (_, index) => `![saved${index + start}](${url(index + start)})`).join('\n\n')
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture(ui = true) {
  let documentId = 'document-1'
  let read = async (_payload: Record<string, unknown>): Promise<unknown> => image
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', ...(ui ? { uiLeaseId: documentId } : {}) }
    const value = await read(args?.payload as Record<string, unknown>)
    return { engineEpoch: 'engine-1', result: { defined: true, value } }
  })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi)
  const release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  return { host, release, invoke, setRead: (next: typeof read) => { read = next }, nextDocument: () => { documentId = 'document-2' },
    calls: () => invoke.mock.calls.filter(([, args]) => args?.operation === 'attachments:readImage') }
}
let f: Awaited<ReturnType<typeof fixture>>
const legacy = window.electronAPI
const createUrl = vi.fn<(blob: Blob) => string>(), revokeUrl = vi.fn<(url: string) => void>()
let blobSequence = 0
const finishRaw: Array<() => void> = []
beforeEach(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  vi.stubGlobal('IntersectionObserver', undefined)
  createUrl.mockReset(); revokeUrl.mockReset(); blobSequence = 0
  createUrl.mockImplementation(() => `blob:controlled-${++blobSequence}`)
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl })
  f = await fixture()
})
afterEach(async () => {
  cleanup(); retireAttachmentImagePreviews()
  await act(async () => { for (const finish of finishRaw.splice(0)) finish(); f.release(); await Promise.resolve() })
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})

it('reads literal saved IDs with the actual native codec/document receipt, keeps streamed text stable and revokes once', async () => {
  const view = render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toHaveAttribute('src', 'blob:controlled-1'))
  expect(f.calls()).toHaveLength(1)
  expect(f.calls()[0][1]).toMatchObject({ operation: 'attachments:readImage', payload: { taskId: 'Task_A', attachmentId: id() }, uiLease: 'document-1' })
  expect(createUrl.mock.calls[0][0]).toMatchObject({ type: 'image/png', size: Buffer.from(PNG, 'base64').length })
  view.rerender(<Markdown>{markup() + '\n\nMore streamed text'}</Markdown>)
  expect(f.calls()).toHaveLength(1)
  view.unmount(); expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:controlled-1')
})
it.each([
  `app-attachment://Task_A/${id()}?path=/private`, `app-attachment://Task_A/${id()}#fragment`,
  `app-attachment://Task_A%2fother/${id()}`, `app-attachment://Task_A/${id()}/extra`,
  'app-attachment://Task_A/not-a-saved-id', `app-attachment://user@Task_A/${id()}`
])('refuses nonliteral attachment URL without scheme fallback: %s', async source => {
  const view = render(<Markdown>{`![invalid](${source})`}</Markdown>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable'))
  expect(f.calls()).toHaveLength(0); expect(view.container.querySelector('img')).toBeNull()
})
it('keeps native legacy attachment hyperlinks inert with guidance to existing saved-file controls', () => {
  const onLink = vi.fn(), view = render(<Markdown onLinkClick={onLink}>{`[report](${url()})`}</Markdown>)
  fireEvent.click(screen.getByText('report'))
  expect(view.container.querySelector('a')).toBeNull(); expect(onLink).not.toHaveBeenCalled()
  expect(screen.getByText('report')).toHaveAttribute('title', 'Use Open or Download in attachments.')
  expect(f.calls()).toHaveLength(0)
})
it('preserves Electron image/link scheme behavior without a native preview', () => {
  const release = installDesktopHost(createElectronHost(() => legacy))
  try {
    const view = render(<Markdown>{`${markup()}\n\n[report](${url()})`}</Markdown>)
    expect(screen.getByAltText('saved1')).toHaveAttribute('src', url()); expect(view.container.querySelector('a')).toHaveAttribute('href', url())
    expect(createUrl).not.toHaveBeenCalled(); expect(f.calls()).toHaveLength(0)
  } finally { cleanup(); release() }
})
it.each([{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/gif', data: GIF }, { mimeType: 'image/webp', data: WEBP }])('creates only a validated $mimeType blob', async result => {
  f.setRead(async () => result); render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toHaveAttribute('src', 'blob:controlled-1'))
  expect(createUrl.mock.calls[0][0].type).toBe(result.mimeType)
})
it('reports unavailable without exposing private errors or falling back', async () => {
  f.setRead(async () => { throw new Error('private-profile-canary /private/token') })
  const view = render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable'))
  expect(view.container.textContent).not.toContain('canary'); expect(view.container.querySelector('img')).toBeNull()
  expect(createUrl).not.toHaveBeenCalled(); expect(f.calls()).toHaveLength(1)
})
it('refuses missing physical-document receipt before native invocation', async () => {
  f.release(); f = await fixture(false); render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable'))
  expect(f.calls()).toHaveLength(0); expect(createUrl).not.toHaveBeenCalled()
})
it('discards late unmounted result, retaining its read slot through settlement', async () => {
  const pending = held<unknown>(); finishRaw.push(() => pending.resolve(image)); f.setRead(() => pending.promise)
  const view = render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(f.calls()).toHaveLength(1)); view.unmount()
  await act(async () => { pending.resolve(image) }); expect(createUrl).not.toHaveBeenCalled()
})
it('releases old blob on reconnect and refuses held old results after replacement', async () => {
  const view = render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toBeInTheDocument())
  const pending = held<unknown>(); finishRaw.push(() => pending.resolve(image)); f.setRead(() => pending.promise)
  await act(async () => { f.nextDocument(); await f.host.reconnect() })
  expect(revokeUrl).toHaveBeenCalledWith('blob:controlled-1'); expect(view.container.querySelector('img')).toBeNull()
  await waitFor(() => expect(f.calls()).toHaveLength(2)); f.setRead(async () => image)
  await act(async () => { await f.host.reconnect(); pending.resolve(image) })
  await waitFor(() => expect(screen.getByAltText('saved1')).toHaveAttribute('src', 'blob:controlled-2'))
  expect(f.calls()).toHaveLength(3); expect(createUrl).toHaveBeenCalledTimes(2)
  expect(f.calls()[2][1]).toMatchObject({ uiLease: 'document-2' })
})
it('permits only the exact saved-image read while durable mutation recovery is pending', async () => {
  const recovery = held<void>(); finishRaw.push(() => recovery.resolve())
  f.host.setRehydrator(() => recovery.promise)
  const reconnecting = f.host.reconnect(); void reconnecting.catch(() => {})
  await waitFor(() => expect(f.host.connection.status).toBe('ready'))
  expect(f.host.hydrationPending).toBe(true)
  render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toHaveAttribute('src', 'blob:controlled-1'))
  await expect(f.host.api.db.deleteTask('Task_A')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.invoke.mock.calls.some(([, args]) => args?.operation === 'db:deleteTask')).toBe(false)
  await act(async () => { recovery.resolve(); await reconnecting })
  expect(f.calls()).toHaveLength(1)
})
it('releases on pagehide and retires observer without reopening on a ready notice', async () => {
  const off = vi.fn(), subscribe = f.host.subscribeConnection
  vi.spyOn(f.host, 'subscribeConnection').mockImplementation(listener => { const stop = subscribe(listener); return () => { off(); stop() } })
  const view = render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toBeInTheDocument())
  act(() => window.dispatchEvent(new Event('pagehide')))
  expect(view.container.querySelector('img')).toBeNull(); expect(revokeUrl).toHaveBeenCalledOnce(); expect(off).toHaveBeenCalledOnce()
  await act(async () => { await f.host.reconnect() }); expect(f.calls()).toHaveLength(1)
  view.unmount(); expect(off).toHaveBeenCalledOnce()
})
it('releases resident budget immediately on browser decode refusal', async () => {
  render(<Markdown>{markup()}</Markdown>)
  await waitFor(() => expect(screen.getByAltText('saved1')).toBeInTheDocument())
  fireEvent.error(screen.getByAltText('saved1'))
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:controlled-1')
  expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable'); expect(f.calls()).toHaveLength(1)
})
it('admits at most four reads and 64 queued across components, removing unseen queued work on unmount', async () => {
  const pending = held<unknown>(); finishRaw.push(() => pending.resolve(image)); f.setRead(() => pending.promise)
  const first = render(<Markdown>{markup(35)}</Markdown>), second = render(<Markdown>{markup(34, 36)}</Markdown>)
  await waitFor(() => expect(f.calls()).toHaveLength(4)); expect(screen.getAllByText(/Image preview unavailable/)).toHaveLength(1)
  first.unmount(); second.unmount(); await act(async () => { pending.resolve(image) })
  expect(f.calls()).toHaveLength(4); expect(createUrl).not.toHaveBeenCalled()
})
it('bounds resident images across Markdown components and releases capacity for a later view', async () => {
  const first = render(<Markdown>{markup(8)}</Markdown>), second = render(<Markdown>{markup(8, 9)}</Markdown>)
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(16))
  const refused = render(<Markdown>{markup(1, 17)}</Markdown>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable')); expect(createUrl).toHaveBeenCalledTimes(16)
  first.unmount(); refused.unmount(); render(<Markdown>{markup(1, 17)}</Markdown>)
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(9))
  expect(revokeUrl).toHaveBeenCalledTimes(8); second.unmount()
})
// Container admission fixtures exercise dimensions/size; not entropy decoding.
function policyPng(width: number, height: number, size = Buffer.from(PNG, 'base64').length) {
  const original = Buffer.from(PNG, 'base64'), bytes = Buffer.alloc(size)
  if (size === original.length) original.copy(bytes)
  else {
    const end = original.length - 12, extra = size - original.length - 12
    original.subarray(0, end).copy(bytes); bytes.writeUInt32BE(extra, end); bytes.write('IDAT', end + 4)
    original.subarray(end).copy(bytes, size - 12)
  }
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return { mimeType: 'image/png', data: bytes.toString('base64') }
}
it('bounds canvas/frame pixels independently of resident count across components', async () => {
  f.setRead(async () => policyPng(2048, 2048)); render(<Markdown>{markup(2)}</Markdown>)
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2)); render(<Markdown>{markup(1, 3)}</Markdown>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable')); expect(createUrl).toHaveBeenCalledTimes(2)
})
it('bounds resident encoded bytes independently of image count/canvas', async () => {
  const boundedImage = policyPng(3, 2, 512 * 1024)
  f.setRead(async () => boundedImage)
  // Join this controlled immediate-response graph before asserting. Repeated
  // finite base64/container validation can occupy more than waitFor's 1s on
  // the staged Node runtime; no production bound or test deadline is changed.
  await act(async () => { render(<Markdown>{markup(9)}</Markdown>); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(screen.getAllByRole('img')).toHaveLength(8)
  expect(screen.getByRole('status')).toHaveTextContent('Image preview unavailable'); expect(createUrl).toHaveBeenCalledTimes(8)
})
it('reads only visible previews and drops resident URL outside the viewport', async () => {
  let callback!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class { constructor(receive: IntersectionObserverCallback) { callback = receive } observe() {} disconnect = disconnect })
  const view = render(<Markdown>{markup()}</Markdown>); expect(f.calls()).toHaveLength(0)
  act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  await waitFor(() => expect(screen.getByAltText('saved1')).toBeInTheDocument())
  act(() => callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(view.container.querySelector('img')).toBeNull(); expect(revokeUrl).toHaveBeenCalledOnce()
  view.unmount(); expect(disconnect).toHaveBeenCalledOnce()
  act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)); expect(f.calls()).toHaveLength(1)
})
