import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'url'
import { isMainWindowUrl } from './main-window-url'

const INDEX = '/opt/20x/resources/app.asar/out/renderer/index.html'
const indexUrl = pathToFileURL(INDEX).href

describe('isMainWindowUrl', () => {
  describe('packaged build', () => {
    it('accepts the renderer index, including in-app hash routes', () => {
      expect(isMainWindowUrl(indexUrl, null, INDEX)).toBe(true)
      expect(isMainWindowUrl(`${indexUrl}#/tasks/1`, null, INDEX)).toBe(true)
    })

    it.each([
      'http://localhost:5173/',
      'http://localhost:@evil.com/',
      pathToFileURL('/tmp/dropped.html').href,
      pathToFileURL('/opt/20x/resources/app.asar/out/renderer/../../../../../tmp/x.html').href,
      'https://example.com/',
      'not a url'
    ])('rejects %s', (url) => {
      expect(isMainWindowUrl(url, null, INDEX)).toBe(false)
    })
  })

  describe('dev server', () => {
    const dev = 'http://localhost:5173'

    it('accepts the dev server origin', () => {
      expect(isMainWindowUrl('http://localhost:5173/#/settings', dev, INDEX)).toBe(true)
    })

    it.each([
      'http://localhost:3000/',
      'http://localhost:@evil.com/',
      'http://localhost:5173.evil.com/',
      indexUrl
    ])('rejects %s', (url) => {
      expect(isMainWindowUrl(url, dev, INDEX)).toBe(false)
    })
  })
})
