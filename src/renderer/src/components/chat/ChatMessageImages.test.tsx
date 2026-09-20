import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatMessageImages } from './ChatMessageImages'
const images = [{ id: 'one', name: 'screen.png', mime_type: 'image/png' as const, size: 64 }]
beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows an accessible unavailable image for load failures without retry loops', async () => {
  const load = vi.fn().mockRejectedValue(new Error('gone'))
  render(<ChatMessageImages images={images} load={load} />)
  await screen.findByRole('img', { name: 'Unavailable image: screen.png' })
  expect(load).toHaveBeenCalledTimes(1)
})

it('handles corrupt cached bytes without reloading the same image', async () => {
  const load = vi.fn()
  render(<ChatMessageImages images={images} load={load} cached={() => 'data:image/png;base64,bad'} />)
  fireEvent.error(screen.getByRole('img', { name: 'screen.png' }))
  await waitFor(() => expect(screen.getByRole('img', { name: 'Unavailable image: screen.png' })).toBeInTheDocument())
  expect(load).not.toHaveBeenCalled()
})


it('loads only visible history thumbnails and releases URLs after leaving the viewport', async () => {
  let intersect!: IntersectionObserverCallback
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe = observe
    disconnect = disconnect
  })
  const load = vi.fn().mockResolvedValue('data:image/png;base64,AAAA')
  const view = render(<ChatMessageImages images={images} load={load} />)
  const wrapper = screen.getByTestId('chat-message-image')
  expect(observe).toHaveBeenCalledWith(wrapper)
  expect(load).not.toHaveBeenCalled()
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  await screen.findByRole('img', { name: 'screen.png' })
  expect(load).toHaveBeenCalledTimes(1)
  act(() => intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByTestId('chat-message-image')).toBe(wrapper)
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  await screen.findByRole('img', { name: 'screen.png' })
  expect(load).toHaveBeenCalledTimes(2)
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})
