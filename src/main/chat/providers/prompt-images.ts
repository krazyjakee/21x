import type { ChatMessage } from '../../../shared/chat'
import type { ChatImageInput } from '../../../shared/chat-images'

/**
 * The subscription transports (Claude Code, Codex CLI) send the conversation
 * as JSON inside one prompt. Image bytes must not go into that text: they are
 * handed over as real images next to the prompt, and the JSON keeps a numbered
 * reference in their place so the model knows which message each belongs to.
 */

export const PROMPT_IMAGE_NOTE =
  'Images the user attached are provided with this prompt, numbered in order; in CONVERSATION_JSON a user message lists them as {"attached_image": N, "name": ...}.'

export interface PromptImages {
  /** The history with every image replaced by its reference. */
  messages: unknown[]
  /** The images, in reference order (1-based in the references). */
  images: ChatImageInput[]
}

export function extractPromptImages(messages: ChatMessage[]): PromptImages {
  const images: ChatImageInput[] = []
  const out = messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length) return message
    const refs = message.images.map((image) => {
      images.push(image)
      return { attached_image: images.length, name: image.name }
    })
    return { role: 'user', content: message.content, images: refs }
  })
  return { messages: out, images }
}
