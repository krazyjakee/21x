import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

const terminalCreate = vi.fn()
const terminalWrite = vi.fn()
const terminalResize = vi.fn()
const terminalKill = vi.fn()
const terminalGetCwd = vi.fn()
const terminalOnData = vi.fn((_callback: (event: { id: string; data: string }) => void) => vi.fn())
const terminalOnExit = vi.fn((_callback: (event: { id: string }) => void) => vi.fn())
const renderedData = vi.fn()

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    textarea = document.createElement('textarea')
    element?: HTMLElement
    loadAddon() {}
    open(container: HTMLElement) {
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      this.element.appendChild(screen)
      container.appendChild(this.element)
    }
    focus() {}
    clear() {}
    write(data: string) { renderedData(data) }
    dispose() {}
    onData() {
      return { dispose: vi.fn() }
    }
    onKey() {
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

import { TerminalPanelContent } from './TerminalPanelContent'
import { useCanvasStore } from '@/stores/canvas-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TerminalPanelContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCanvasStore.setState({ viewport: { x: 0, y: 0, zoom: 1 } })
    terminalWrite.mockResolvedValue(undefined)
    terminalResize.mockResolvedValue(undefined)
    terminalKill.mockResolvedValue(undefined)

    Object.defineProperty(window, 'electronAPI', {
      value: {
        ...(window.electronAPI ?? {}),
        terminal: {
          create: terminalCreate,
          write: terminalWrite,
          resize: terminalResize,
          kill: terminalKill,
          getCwd: terminalGetCwd,
          getBuffer: vi.fn(),
          onData: terminalOnData,
          onExit: terminalOnExit,
        },
      },
      configurable: true,
      writable: true,
    })

    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 480,
      top: 0,
      left: 0,
      right: 640,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('cancels the delayed focus check when its terminal unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    terminalCreate.mockResolvedValue({ pid: 444 })
    terminalGetCwd.mockResolvedValue({ cwd: null })
    const panel = render(<TerminalPanelContent terminalId="panel-focus" cwd="/tmp" />)
    await act(async () => {})
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    panel.unmount()
    await act(async () => {})
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(terminalKill).toHaveBeenCalledWith('panel-focus', 444)
  })

  it('subscribes before create so initial terminal output is rendered', async () => {
    terminalCreate.mockImplementationOnce(async () => {
      expect(terminalOnData).toHaveBeenCalledOnce()
      expect(terminalOnExit).toHaveBeenCalledOnce()
      const listener = terminalOnData.mock.calls[0]?.[0] as ((event: { id: string; data: string }) => void) | undefined
      if (!listener) throw new Error('Missing pre-create terminal listener')
      listener({ id: 'panel-early', data: 'Initial shell prompt' })
      return { pid: 444 }
    })
    terminalGetCwd.mockResolvedValue({ cwd: null })
    render(<TerminalPanelContent terminalId="panel-early" />)
    await waitFor(() => expect(renderedData).toHaveBeenCalledWith('Initial shell prompt'))
  })

  it('kills only the PTY instance that owned the cleanup', async () => {
    const firstCwd = deferred<{ cwd: string | null }>()
    const secondCwd = deferred<{ cwd: string | null }>()

    terminalCreate.mockResolvedValueOnce({ pid: 111 }).mockResolvedValueOnce({ pid: 222 })
    terminalGetCwd.mockImplementationOnce(() => firstCwd.promise).mockImplementationOnce(() => secondCwd.promise)

    const first = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(1)
    })

    first.unmount()

    const second = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(2)
    })

    expect(terminalGetCwd).toHaveBeenNthCalledWith(1, 'panel-1', 111)

    firstCwd.resolve({ cwd: '/tmp/one' })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 111)
    })

    second.unmount()
    expect(terminalGetCwd).toHaveBeenNthCalledWith(2, 'panel-1', 222)

    secondCwd.resolve({ cwd: '/tmp/two' })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 222)
    })
  })

  it('kills a PTY that resolves after its component instance already unmounted', async () => {
    const firstCreate = deferred<{ pid: number }>()
    const secondCwd = deferred<{ cwd: string | null }>()

    terminalCreate
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce({ pid: 222 })
    terminalGetCwd.mockImplementationOnce(() => secondCwd.promise)

    const first = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(1)
    })

    first.unmount()

    const second = render(<TerminalPanelContent terminalId="panel-1" cwd="/tmp" />)
    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalledTimes(2)
    })

    firstCreate.resolve({ pid: 111 })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 111)
    })

    expect(terminalGetCwd).not.toHaveBeenCalled()

    second.unmount()
    expect(terminalGetCwd).toHaveBeenNthCalledWith(1, 'panel-1', 222)

    secondCwd.resolve({ cwd: '/tmp/two' })
    await waitFor(() => {
      expect(terminalKill).toHaveBeenCalledWith('panel-1', 222)
    })
  })

  it('keeps terminal rendering unchanged and adjusts xterm mouse coordinates inside the zoomed canvas', async () => {
    terminalCreate.mockResolvedValue({ pid: 333 })
    terminalGetCwd.mockResolvedValue({ cwd: null })

    // Committed canvas zoom is now read from the store, not a prop.
    useCanvasStore.setState({ viewport: { x: 0, y: 0, zoom: 0.5 } })

    const { container } = render(
      <TerminalPanelContent terminalId="panel-1" cwd="/tmp" />
    )

    const terminal = container.querySelector('.xterm-container') as HTMLElement
    const xterm = container.querySelector('.xterm') as HTMLElement
    const screen = container.querySelector('.xterm-screen') as HTMLElement

    expect(terminal.style.width).toBe('')
    expect(terminal.style.height).toBe('')
    expect(terminal.style.transform).toBe('')

    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      width: 320,
      height: 240,
      top: 20,
      left: 10,
      right: 330,
      bottom: 260,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })
    const mouseDownHandler = vi.fn((event: MouseEvent) => {
      expect(event.clientX).toBe(70)
      expect(event.clientY).toBe(120)
    })
    xterm.addEventListener('mousedown', mouseDownHandler)

    screen.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 70,
      button: 0,
      buttons: 1,
    }))

    expect(mouseDownHandler).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(terminalCreate).toHaveBeenCalled()
    })
  })
})
