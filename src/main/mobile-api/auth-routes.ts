import { createHash, randomInt, randomUUID } from 'crypto'
import { HttpError } from '../http-utils'
import { deps, notifyDesktop, type MobileRoute } from './state'

const PIN_EXPIRY_SECONDS = 60
const PIN_MAX_ATTEMPTS = 3

let pendingPin: { pin: string; pairCodeId: string; expiresAt: number } | null = null

export function getPendingPin(): { pin: string; pairCodeId: string; expiresAt: number } | null {
  if (!pendingPin) return null
  if (Math.floor(Date.now() / 1000) > pendingPin.expiresAt) {
    pendingPin = null
    return null
  }
  return pendingPin
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseDeviceName(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Windows/i.test(userAgent)) return 'Windows Browser'
  if (/Mac/i.test(userAgent)) return 'Mac Browser'
  return 'Unknown device'
}


export const authRoutes: MobileRoute[] = [
  {
    // The phone sends the one-time code from the QR; the desktop shows a PIN.
    method: 'POST',
    path: '/api/auth/pair/initiate',
    handle: ({ params }) => {
      const { db } = deps
      const { code } = params as { code?: string }
      if (!code) throw new HttpError(400, 'code is required')

      const now = Math.floor(Date.now() / 1000)
      const validCode = db.getSetting(`mobile_init_code_${code}`)
      const validUntil = db.getSetting(`mobile_init_code_${code}_exp`)
      if (!validCode || !validUntil || now > parseInt(validUntil)) {
        throw new HttpError(401, 'Invalid or expired QR code. Please scan a new QR code.')
      }
      // Single use.
      db.deleteSetting(`mobile_init_code_${code}`)
      db.deleteSetting(`mobile_init_code_${code}_exp`)

      const pin = String(randomInt(100000, 1000000))
      const pairCodeId = randomUUID()
      db.createMobilePairCode(pairCodeId, pin, now + PIN_EXPIRY_SECONDS)

      // Kept so the renderer can fetch it if Settings isn't open when the event fires.
      pendingPin = { pin, pairCodeId, expiresAt: now + PIN_EXPIRY_SECONDS }
      notifyDesktop?.('mobile:pairing-initiated', { pin, pairCodeId, expiresAt: now + PIN_EXPIRY_SECONDS })

      return { pairCodeId, expiresIn: PIN_EXPIRY_SECONDS }
    }
  },
  {
    method: 'POST',
    path: '/api/auth/pair/verify',
    handle: ({ params, req }) => {
      const { db } = deps
      const { pairCodeId, pin } = params as { pairCodeId?: string; pin?: string }
      if (!pairCodeId || !pin) throw new HttpError(400, 'pairCodeId and pin are required')

      const now = Math.floor(Date.now() / 1000)
      const record = db.getMobilePairCode(pairCodeId)

      if (!record) throw new HttpError(401, 'Invalid pairing session')
      if (now > record.expires_at) {
        db.deleteMobilePairCode(pairCodeId)
        throw new HttpError(401, 'PIN expired. Please scan the QR code again.')
      }

      const attempts = db.incrementPairCodeAttempts(pairCodeId)
      if (attempts > PIN_MAX_ATTEMPTS) {
        db.deleteMobilePairCode(pairCodeId)
        throw new HttpError(401, 'Too many incorrect attempts. Please scan the QR code again.')
      }

      if (record.pin !== pin.trim()) {
        const remaining = PIN_MAX_ATTEMPTS - attempts
        throw new HttpError(401, `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`)
      }

      pendingPin = null
      db.deleteMobilePairCode(pairCodeId)
      const sessionToken = randomUUID()
      const sessionId = randomUUID()
      const deviceName = parseDeviceName(req.headers['user-agent'] || 'Unknown device')
      db.createMobileSession(sessionId, hashToken(sessionToken), deviceName)
      notifyDesktop?.('mobile:device-connected', { sessionId, deviceName })

      return { sessionToken, sessionId, deviceName }
    }
  },
  { method: 'GET', path: '/api/auth/sessions', handle: () => deps.db.getMobileSessions() }
]
