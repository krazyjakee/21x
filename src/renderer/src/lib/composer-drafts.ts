import type { ComposerAttachment } from '@/components/agents/transcript/TranscriptComposer'
import type { ChatImageAttachment } from '@/hooks/use-chat-attachments'

/**
 * Unsent words, kept per conversation.
 *
 * The Captain column and the dashboard box are one control that talks to
 * whichever project is current, so words typed for one Captain must not stay
 * on screen to be sent to the next. Each conversation's draft is put aside
 * when the user flips away and handed back when they return. It lives as long
 * as the window: the composers have never survived a reload.
 */
export interface ComposerDraft {
  text: string
  images?: ChatImageAttachment[]
  attachments?: ComposerAttachment[]
}

const drafts = new Map<string, ComposerDraft>()

export function readComposerDraft(key: string | undefined): ComposerDraft | undefined {
  return key ? drafts.get(key) : undefined
}

/** Keeps a draft under its conversation; an empty one clears the entry. */
export function keepComposerDraft(key: string, draft: ComposerDraft): void {
  if (draft.text || draft.images?.length || draft.attachments?.length) drafts.set(key, draft)
  else drafts.delete(key)
}

/** For tests: the store outlives each rendered tree. */
export function clearComposerDrafts(): void {
  drafts.clear()
}
