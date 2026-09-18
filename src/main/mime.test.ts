import { describe, it, expect } from 'vitest'
import { extensionForMimeType, hasKnownExtension, mimeTypeForPath, sniffMimeType } from './mime'

describe('mime', () => {
  it('maps extensions case-insensitively with an octet-stream fallback', () => {
    expect(mimeTypeForPath('/a/b/Photo.PNG')).toBe('image/png')
    expect(mimeTypeForPath('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(mimeTypeForPath('notes')).toBe('application/octet-stream')
    expect(hasKnownExtension('a.zip')).toBe(true)
    expect(hasKnownExtension('a.bin')).toBe(false)
  })

  it('returns the preferred extension for a MIME type', () => {
    expect(extensionForMimeType('image/jpeg')).toBe('.jpg')
    expect(extensionForMimeType('text/plain')).toBe('.txt')
    expect(extensionForMimeType('application/x-unknown')).toBe('')
  })

  it('sniffs common magic bytes', () => {
    expect(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(sniffMimeType(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
    expect(sniffMimeType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip')
    expect(sniffMimeType(Buffer.from('hello'))).toBeNull()
    expect(sniffMimeType(Buffer.from('ab'))).toBeNull()
  })
})
