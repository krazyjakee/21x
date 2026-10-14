import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { NATIVE_NOTIFICATION_CODECS, type NativeNotificationOperation } from '../src/shared/native-notification-codecs'
it('exports actual encoded native notification requests and exact rejection cases for Rust parity', () => {
  const positive: Array<[NativeNotificationOperation, unknown[]]> = [['app:getNotificationPermission', []], ['app:requestNotificationPermission', []], ['notifications:show', ['Review', '']], ['notifications:show', ['é'.repeat(80), '😀'.repeat(512)]], ['notifications:show', ['Review', '\tLine1\r\nLine2']]]
  const requests: Array<{ operation: string; payload: unknown; valid: boolean }> = positive.map(([operation, args]) => ({ operation, payload: NATIVE_NOTIFICATION_CODECS[operation].encodeArguments(args as never), valid: true }))
  for (const [operation, payload] of [['notifications:show', { title: 'Review', body: '', action: 'private' }], ['notifications:show', { title: 'é'.repeat(81), body: '' }], ['notifications:show', { title: 'Review', body: '😀'.repeat(513) }], ['notifications:show', { title: 'Review', body: '\u001b[31m' }], ['app:getNotificationPermission', { permission: 'granted' }], ['host.notification.status', { title: 'Review', body: '' }]] as const) {
    const codec = NATIVE_NOTIFICATION_CODECS[operation as NativeNotificationOperation]
    if (codec) expect(() => codec.decodeArguments(payload)).toThrow()
    requests.push({ operation, payload, valid: false })
  }
  expect(requests).toHaveLength(11)
  if (process.env.TWENTYONEX_NATIVE_NOTIFICATION_CORPUS_OUT) writeFileSync(process.env.TWENTYONEX_NATIVE_NOTIFICATION_CORPUS_OUT, JSON.stringify({ version: 1, requests }, null, 2) + '\n', { mode: 0o600 })
})
