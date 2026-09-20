import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    mkdtempSync: vi.fn((prefix: string) => { state.directory = fs.mkdtempSync(prefix); return state.directory }),
    writeFileSync: vi.fn((path: string, data: string | Uint8Array, options: unknown) => {
      if (path.endsWith('image-2.png')) throw new Error('simulated disk failure')
      fs.writeFileSync(path, data, options as Parameters<typeof fs.writeFileSync>[2])
    })
  }
})

import { existsSync, rmSync } from 'fs'
import { CodexSubscriptionChatProvider } from './codex-subscription'

afterEach(() => { if (state.directory) rmSync(state.directory, { recursive: true, force: true }) })

it('cleans up earlier private images when preparing a later image fails', async () => {
  const provider = new CodexSubscriptionChatProvider({ model: 'gpt-5', findExecutable: async () => 'unused-codex' })
  const image = { name: 'screenshot.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }
  const stream = provider.stream({ messages: [{ role: 'user', content: 'private screenshot', images: [image, image] }], tools: [], toolChoice: 'auto' }, new AbortController().signal)
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('Codex could not process the attached images.')
  expect(state.directory).not.toBe('')
  expect(existsSync(state.directory)).toBe(false)
})
