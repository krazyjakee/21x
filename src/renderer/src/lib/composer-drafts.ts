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
const receivers = new Map<string, (returned: ComposerDraft) => void>()

export function readComposerDraft(key: string | undefined): ComposerDraft | undefined {
  return key ? drafts.get(key) : undefined
}

/** Keeps a draft under its conversation; an empty one clears the entry. */
export function keepComposerDraft(key: string, draft: ComposerDraft): void {
  if (draft.text || draft.images?.length || draft.attachments?.length) drafts.set(key, draft)
  else drafts.delete(key)
}

/** A composer on screen takes returned words itself; its draft is only read on mount. */
export function receiveReturnedDrafts(key: string, receiver: (returned: ComposerDraft) => void): () => void {
  receivers.set(key, receiver)
  return () => {
    if (receivers.get(key) === receiver) receivers.delete(key)
  }
}

/** Hands words that could not be sent back to their conversation, keeping what is already there. */
export function returnToComposerDraft(key: string, returned: ComposerDraft): void {
  const receiver = receivers.get(key)
  if (receiver) {
    receiver(returned)
    return
  }
  const draft = drafts.get(key)
  keepComposerDraft(key, {
    text: [draft?.text, returned.text].filter(Boolean).join('\n\n'),
    images: [...(draft?.images ?? []), ...(returned.images ?? [])],
    attachments: [...(draft?.attachments ?? []), ...(returned.attachments ?? []).filter((item) => !draft?.attachments?.some((held) => held.id === item.id))]
  })
}

/** For tests: the store outlives each rendered tree. */
export function clearComposerDrafts(): void {
  drafts.clear()
  receivers.clear()
}
