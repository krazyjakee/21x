import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MAX_CHAT_IMAGE_BYTES, chatImageErrors } from '@shared/chat-images'
import { clipboard, imageFile } from './paste-fixtures'

/**
 * The paste behaviour every chat composer shares (#144). Each composer that
 * uses `useChatAttachments` + `<AttachmentTray>` runs this suite, so a surface
 * that drifts (or drops the wiring) fails here.
 */
export function describeChatImagePaste(surface: string, mount: () => Promise<HTMLTextAreaElement>): void {
  describe(`${surface}: pasting images (shared suite)`, () => {
    const chips = () => screen.queryAllByTestId('chat-attachment-chip')
    const announcer = () => screen.getByTestId('chat-attachment-announcer')

    it('attaches a pasted image as a labelled thumbnail chip and announces it', async () => {
      const field = await mount()
      const notCancelled = fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('diagram.png')] }) })
      expect(notCancelled).toBe(false)
      await waitFor(() => expect(chips()).toHaveLength(1))
      const chip = chips()[0]
      expect(within(chip).getByRole('img', { name: 'diagram.png' }).getAttribute('src')).toMatch(/^data:image\/png;base64,/)
      expect(within(chip).getByRole('button', { name: 'Remove image diagram.png' })).toBeTruthy()
      expect(screen.getByRole('list', { name: 'Attached images' })).toBeTruthy()
      expect(announcer().textContent).toBe('Image attached: diagram.png')
    })

    it('removes an image from the keyboard, announces it and returns focus to the text field', async () => {
      const field = await mount()
      fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('a.png'), imageFile('b.png', 'image/png', 65)] }) })
      await waitFor(() => expect(chips()).toHaveLength(2))

      const removeA = screen.getByRole('button', { name: 'Remove image a.png' })
      removeA.focus()
      fireEvent.click(removeA)
      expect(chips()).toHaveLength(1)
      expect(announcer().textContent).toBe('Image removed: a.png')
      // Focus stays in the tray while images remain...
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove image b.png' }))

      fireEvent.click(screen.getByRole('button', { name: 'Remove image b.png' }))
      expect(chips()).toHaveLength(0)
      // ...then goes back to the text.
      expect(document.activeElement).toBe(field)
    })

    it('mixed paste: lets the text paste natively and attaches the image', async () => {
      const field = await mount()
      const notCancelled = fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('a.png')], text: 'caption' }) })
      expect(notCancelled).toBe(true)
      await waitFor(() => expect(chips()).toHaveLength(1))
    })

    it('leaves a plain text paste untouched', async () => {
      const field = await mount()
      const notCancelled = fireEvent.paste(field, { clipboardData: clipboard({ text: 'just words', html: '<p>just words</p>' }) })
      expect(notCancelled).toBe(true)
      expect(screen.queryByTestId('chat-attachment-tray')).toBeNull()
      expect(announcer().textContent).toBe('')
    })

    it('shows inline errors for an unsupported type and an oversize image', async () => {
      const field = await mount()
      fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('scan.bmp', 'image/bmp')] }) })
      expect(await screen.findByText(chatImageErrors.unsupportedType('scan.bmp'))).toBeTruthy()

      fireEvent.paste(field, { clipboardData: clipboard({ files: [imageFile('huge.png', 'image/png', MAX_CHAT_IMAGE_BYTES + 1)] }) })
      expect(await screen.findByText(chatImageErrors.tooLarge('huge.png', MAX_CHAT_IMAGE_BYTES + 1))).toBeTruthy()
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(chips()).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })
}
