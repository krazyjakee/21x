import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from '../main/chat/providers/types'

/** Actual provider streams across Chat, Commander, briefing and Captain recap
 * factories. A retained provider cannot dispatch with an obsolete credential. */
export class ProductionProviderOwner {
  private closing = false
  private changing = false
  private generation = 0
  private controller = new AbortController()
  private readonly work = new Set<Promise<void>>()
  wrap(provider: ChatProvider): ChatProvider {
    if (this.closing || this.changing) throw new Error('PROVIDER_CONFIGURATION_UNAVAILABLE')
    const generation = this.generation
    return { id: provider.id, model: provider.model, contextWindow: provider.contextWindow, supportsImages: provider.supportsImages,
      stream: (request, signal) => this.stream(provider, generation, request, signal) }
  }
  private async *stream(provider: ChatProvider, generation: number, request: ChatProviderRequest, signal: AbortSignal): AsyncGenerator<ChatProviderEvent> {
        if (this.closing || this.changing || generation !== this.generation) throw new Error('PROVIDER_CONFIGURATION_UNAVAILABLE')
        let finish!: () => void
        const receipt = new Promise<void>(resolve => { finish = resolve })
        this.work.add(receipt)
        const combined = AbortSignal.any([signal, this.controller.signal])
        try { for await (const event of provider.stream(request, combined)) yield event }
        finally { this.work.delete(receipt); finish() }
  }
  beginMutation(): { drain(): Promise<void>; release(): void } {
    if (this.closing || this.changing) throw new Error('PROVIDER_CONFIGURATION_UNAVAILABLE')
    this.changing = true; this.generation++; this.controller.abort()
    let released = false
    return { drain: () => this.drain(), release: () => {
      if (released) return
      released = true; this.changing = false; this.controller = new AbortController()
    } }
  }
  shutdown(): void { this.closing = true; this.controller.abort() }
  async drain(): Promise<void> { while (this.work.size) await Promise.allSettled([...this.work]) }
}
