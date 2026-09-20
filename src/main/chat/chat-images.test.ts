import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/chat'
import {
  MAX_CHAT_IMAGE_BYTES,
  chatImageErrors,
  validateChatImageInputs,
  type ChatImageInput
} from '../../shared/chat-images'
import { AnthropicChatProvider } from './providers/anthropic'
import { OpenAICompatibleChatProvider } from './providers/openai-compatible'
import { ClaudeCodeSubscriptionChatProvider, type SdkUserMessage } from './providers/claude-code-subscription'
import { CodexSubscriptionChatProvider, codexExecArgs, type CodexExecInput } from './providers/codex-subscription'
import { extractPromptImages } from './providers/prompt-images'
import type { ChatProviderEvent, ChatProviderRequest, FetchLike } from './providers/types'

/** Image payloads (#144): validation and what each provider puts on the wire. */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0]
const BMP_MAGIC = [0x42, 0x4d]

function imageBase64(magic: number[], size = 64): string {
  const bytes = Buffer.alloc(size)
  Buffer.from(magic).copy(bytes)
  return bytes.toString('base64')
}

const png = (name = 'shot.png', size = 64): ChatImageInput => ({ name, mimeType: 'image/png', data: imageBase64(PNG_MAGIC, size) })

async function drain(iterable: AsyncIterable<ChatProviderEvent>): Promise<ChatProviderEvent[]> {
  const out: ChatProviderEvent[] = []
  for await (const event of iterable) out.push(event)
  return out
}

function requestWith(messages: ChatMessage[]): ChatProviderRequest {
  return { messages, tools: [], toolChoice: 'auto' }
}

describe('validateChatImageInputs (main-side IPC validation)', () => {
  it('accepts supported images and takes the type from the bytes', () => {
    const [image] = validateChatImageInputs([{ name: 'a.jpg', mimeType: 'image/png', data: imageBase64(JPEG_MAGIC) }])
    expect(image).toMatchObject({ name: 'a.jpg', mimeType: 'image/jpeg', size: 64 })
  })

  it('returns nothing for a message without images', () => {
    expect(validateChatImageInputs(undefined)).toEqual([])
    expect(validateChatImageInputs(null)).toEqual([])
  })

  it('refuses an unsupported type, by declaration or by content', () => {
    expect(() => validateChatImageInputs([{ name: 'a.bmp', mimeType: 'image/bmp', data: imageBase64(BMP_MAGIC) }]))
      .toThrow(chatImageErrors.unsupportedType('a.bmp'))
    expect(() => validateChatImageInputs([{ name: 'fake.png', mimeType: 'image/png', data: imageBase64(BMP_MAGIC) }]))
      .toThrow(chatImageErrors.unsupportedType('fake.png'))
    expect(() => validateChatImageInputs([{ name: 'x.svg', mimeType: 'image/svg+xml', data: imageBase64(PNG_MAGIC) }]))
      .toThrow(/isn't a supported image type/)
  })

  it('refuses an image over the size limit', () => {
    const big = png('big.png', MAX_CHAT_IMAGE_BYTES + 3)
    expect(() => validateChatImageInputs([big])).toThrow(/big.png" is 5.0 MB. Images must be 5.0 MB or smaller/)
  })

  it('refuses more than five images and a total over 20 MB', () => {
    expect(() => validateChatImageInputs(Array.from({ length: 6 }, (_, i) => png(`${i}.png`)))).toThrow(chatImageErrors.tooMany())
    const near = (i: number) => png(`${i}.png`, MAX_CHAT_IMAGE_BYTES - 3)
    expect(() => validateChatImageInputs([near(1), near(2), near(3), near(4), near(5)])).toThrow(chatImageErrors.totalTooLarge())
  })

  it('refuses data that is not base64 and strips paths from names', () => {
    expect(() => validateChatImageInputs([{ name: 'a.png', mimeType: 'image/png', data: 'not base64!' }])).toThrow(/Couldn't read "a.png"/)
    expect(() => validateChatImageInputs('nope')).toThrow('Images must be a list')
    const [image] = validateChatImageInputs([{ ...png(), name: '../../etc/passwd.png' }])
    expect(image.name).toBe('passwd.png')
  })
})

describe('provider payloads', () => {
  const history: ChatMessage[] = [{ role: 'user', content: 'What is on screen?', images: [png('one.png'), png('two.png')] }]

  it('Anthropic sends base64 image blocks before the text', async () => {
    let body: Record<string, unknown> | null = null
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      const events = [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } }
      ]
      const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const provider = new AnthropicChatProvider({ apiKey: 'k', model: 'claude-x', fetch })
    expect(provider.supportsImages).toBe(true)
    await drain(provider.stream(requestWith(history), new AbortController().signal))
    const messages = (body as unknown as { messages: Array<{ content: unknown }> }).messages
    expect(messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: history[0].role === 'user' ? history[0].images![0].data : '' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: expect.any(String) } },
      { type: 'text', text: 'What is on screen?' }
    ])
  })

  it('Anthropic keeps plain text messages as strings', async () => {
    let body: { messages: Array<{ content: unknown }> } | null = null
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const provider = new AnthropicChatProvider({ apiKey: 'k', fetch })
    await drain(provider.stream(requestWith([{ role: 'user', content: 'hi' }]), new AbortController().signal)).catch(() => [])
    expect(body!.messages[0].content).toBe('hi')
  })

  it('OpenAI-compatible sends image_url parts with data URLs', async () => {
    let body: { messages: Array<{ role: string; content: unknown }> } | null = null
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      })
    })
    const provider = new OpenAICompatibleChatProvider({ model: 'gpt-4o', apiKey: 'k', fetch })
    expect(provider.supportsImages).toBe(true)
    await drain(provider.stream(requestWith(history), new AbortController().signal))
    const user = body!.messages.find((m) => m.role === 'user')!
    expect(user.content).toEqual([
      { type: 'text', text: 'What is on screen?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png().data}` } },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }
    ])
  })

  it('Claude Code subscription streams one user message with image blocks, and no bytes in the prompt text', async () => {
    const prompts: unknown[] = []
    const query = vi.fn((input: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      prompts.push(input.prompt)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, structured_output: { response: 'A chart.', tool_calls: [] }, usage: {} }
        }
      }
    })
    const provider = new ClaudeCodeSubscriptionChatProvider({ model: 'claude-sub', query, findExecutable: async () => '/bin/claude' })
    expect(provider.supportsImages).toBe(true)
    await expect(drain(provider.stream(requestWith(history), new AbortController().signal)))
      .resolves.toContainEqual({ type: 'text_delta', text: 'A chart.' })

    const prompt = prompts[0] as AsyncIterable<SdkUserMessage>
    expect(typeof prompt).not.toBe('string')
    const streamed: SdkUserMessage[] = []
    for await (const message of prompt) streamed.push(message)
    expect(streamed).toHaveLength(1)
    const [text, ...images] = streamed[0].message.content
    expect(text.type).toBe('text')
    expect(String(text.text)).toContain('"attached_image":1')
    expect(String(text.text)).not.toContain(png().data)
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png().data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png().data } }
    ])
  })

  it('Claude Code subscription keeps a plain string prompt without images', async () => {
    const query = vi.fn((_input: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', is_error: false, structured_output: { response: 'ok', tool_calls: [] }, usage: {} }
      }
    }))
    const provider = new ClaudeCodeSubscriptionChatProvider({ model: 'claude-sub', query, findExecutable: async () => '/bin/claude' })
    await drain(provider.stream(requestWith([{ role: 'user', content: 'hi' }]), new AbortController().signal))
    expect(typeof query.mock.calls[0][0].prompt).toBe('string')
  })

  it('Codex subscription hands images to the CLI and references them in the prompt', async () => {
    const calls: CodexExecInput[] = []
    const provider = new CodexSubscriptionChatProvider({
      model: 'gpt-5',
      findExecutable: async () => '/bin/codex',
      execute: async (input) => {
        calls.push(input)
        return JSON.stringify({ response: 'Two screenshots.', tool_calls: [] })
      }
    })
    expect(provider.supportsImages).toBe(true)
    await drain(provider.stream(requestWith(history), new AbortController().signal))
    expect(calls[0].images?.map((i) => i.name)).toEqual(['one.png', 'two.png'])
    expect(calls[0].prompt).toContain('{"attached_image":2,"name":"two.png"}')
    expect(calls[0].prompt).not.toContain(png().data)
  })

  it('codex exec receives the images as one comma-separated --image value before the stdin marker', () => {
    const args = codexExecArgs({ model: 'gpt-5' }, { schema: 's.json', output: 'o.json', images: ['image-1.png', 'image-2.jpg'] })
    expect(args).toContain('--image')
    expect(args[args.indexOf('--image') + 1]).toBe('image-1.png,image-2.jpg')
    expect(args[args.length - 1]).toBe('-')
    expect(codexExecArgs({ model: 'gpt-5' }, { schema: 's', output: 'o', images: [] })).not.toContain('--image')
  })

  it('extractPromptImages numbers images across the whole history', () => {
    const { messages, images } = extractPromptImages([
      { role: 'user', content: 'first', images: [png('a.png')] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second', images: [png('b.png')] }
    ])
    expect(images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(messages[2]).toEqual({ role: 'user', content: 'second', images: [{ attached_image: 2, name: 'b.png' }] })
  })
})
