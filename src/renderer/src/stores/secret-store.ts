import { create } from 'zustand'
import type { Secret, CreateSecretDTO, UpdateSecretDTO } from '@/types'
import { secretApi } from '@/lib/ipc-client'
import { captureDesktopRead } from '@/lib/desktop-api'
import { createDesktopSnapshotReader } from '@/lib/desktop-snapshot'

interface SecretState {
  secrets: Secret[]
  isLoading: boolean
  error: string | null

  fetchSecrets: () => Promise<void>
  createSecret: (data: CreateSecretDTO) => Promise<Secret | null>
  updateSecret: (id: string, data: UpdateSecretDTO) => Promise<Secret | null>
  deleteSecret: (id: string) => Promise<boolean>
}

let requested = false, documentGeneration = 0
export function retireSecretDesktopState(): void {
  requested = false; documentGeneration++; secretSnapshot.dispose()
  window.removeEventListener('pagehide', retireSecretDesktopState)
}
function ownDocument() { window.addEventListener('pagehide', retireSecretDesktopState, { once: true }) }
function captureSecretIntent() {
  ownDocument()
  const generation = documentGeneration, scope = captureDesktopRead()
  return () => generation === documentGeneration && scope.isCurrent()
}

export const useSecretStore = create<SecretState>((set) => ({
  secrets: [],
  isLoading: false,
  error: null,

  fetchSecrets: async () => {
    ownDocument(); requested = true
    secretSnapshot.invalidate()
    await secretSnapshot.refresh().catch(() => {})
  },

  createSecret: async (data) => {
    const current = captureSecretIntent()
    try {
      const secret = await secretApi.create(data)
      if (!current()) return secret
      requested = true; secretSnapshot.invalidate()
      set((state) => ({ secrets: [...state.secrets.filter(item => item.id !== secret.id), secret] }))
      return secret
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  updateSecret: async (id, data) => {
    const current = captureSecretIntent()
    try {
      const updated = await secretApi.update(id, data)
      if (updated && current()) {
        requested = true; secretSnapshot.invalidate()
        set((state) => ({
          secrets: state.secrets.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      if (current()) set({ error: String(err) })
      return null
    }
  },

  deleteSecret: async (id) => {
    const current = captureSecretIntent()
    try {
      const success = await secretApi.delete(id)
      if (success && current()) {
        requested = true; secretSnapshot.invalidate()
        set((state) => ({
          secrets: state.secrets.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      if (current()) set({ error: String(err) })
      return false
    }
  }
}))

const secretSnapshot = createDesktopSnapshotReader({
  read: () => secretApi.getAll(),
  start: () => useSecretStore.setState({ isLoading: true, error: null }),
  apply: secrets => useSecretStore.setState({ secrets, isLoading: false, error: null }),
  fail: error => useSecretStore.setState({ isLoading: false, error: String(error) })
})
/** Metadata only; never reads a credential value or replays a write. */
export async function rehydrateSecretDesktopState(): Promise<void> {
  if (!requested) return
  ownDocument(); secretSnapshot.invalidate()
  await secretSnapshot.refresh()
}
if (import.meta.hot) import.meta.hot.dispose(retireSecretDesktopState)
