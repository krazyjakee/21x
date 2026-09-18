import { useState, useEffect, useCallback } from 'react'
import { mobileApi } from '@/lib/ipc-client'

interface MobileSession {
  id: string
  device_name: string
  paired_at: number
  last_seen: number
}

/** Paired devices plus the short-lived PIN a phone asks for after scanning the QR code. */
export function useMobilePairing() {
  const [pairingPin, setPairingPin] = useState<string | null>(null)
  const [pinSecondsLeft, setPinSecondsLeft] = useState(0)
  const [sessions, setSessions] = useState<MobileSession[]>([])

  useEffect(() => {
    let disposed = false
    let tickTimer: ReturnType<typeof setTimeout> | undefined

    const activatePin = (pin: string, expiresAt: number) => {
      clearTimeout(tickTimer)
      setPairingPin(pin)
      const tick = () => {
        const left = Math.max(0, Math.floor(expiresAt - Date.now() / 1000))
        setPinSecondsLeft(left)
        if (left > 0) tickTimer = setTimeout(tick, 1000)
        else setPairingPin(null)
      }
      tick()
    }

    const unsubscribers = [
      mobileApi.onPairingInitiated(({ pin, expiresAt }) => activatePin(pin, expiresAt)),
      mobileApi.onDeviceConnected(async () => {
        const next = await mobileApi.getSessions()
        if (disposed) return
        setSessions(next)
        setPairingPin(null)
      })
    ]

    const load = async () => {
      try {
        const next = await mobileApi.getSessions()
        if (!disposed) setSessions(next)
      } catch { /* ignore */ }

      // Restore a pending PIN if the phone scanned the QR while this tab was not mounted
      const pending = await mobileApi.getPendingPin()
      if (pending && !disposed) activatePin(pending.pin, pending.expiresAt)
    }
    load()

    return () => {
      disposed = true
      clearTimeout(tickTimer)
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  const revokeSession = useCallback(async (id: string) => {
    await mobileApi.revokeSession(id)
    setSessions((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const revokeAllSessions = useCallback(async () => {
    await mobileApi.revokeAllSessions()
    setSessions([])
  }, [])

  return { pairingPin, pinSecondsLeft, sessions, revokeSession, revokeAllSessions }
}
