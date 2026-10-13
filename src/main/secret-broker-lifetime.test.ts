import { describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import type { DatabaseManager } from './database'
import { closeSecretBroker, getSecretBrokerPort, registerSecretSession, shutdownSecretBroker, startSecretBroker, stopSecretBroker, writeSecretShellWrapper } from './secret-broker'

describe('application secret broker owner', () => {
  it('owns stopped generations, coalesces startup, rejects source replacement and fences final shutdown', async () => {
    const db = { getSecretsWithValues: vi.fn(() => []) } as unknown as DatabaseManager
    const firstStart = startSecretBroker(db)
    expect(startSecretBroker(db)).toBe(firstStart)
    const firstPort = await firstStart
    await expect(startSecretBroker({} as DatabaseManager)).rejects.toThrow('SECRET_BROKER_SOURCE_IN_USE')
    stopSecretBroker()
    expect(getSecretBrokerPort()).toBeNull()
    expect(() => registerSecretSession('late', 'agent', [])).toThrow('SECRET_BROKER_UNAVAILABLE')
    const secondPort = await startSecretBroker(db)
    expect(secondPort).not.toBe(firstPort)
    shutdownSecretBroker()
    const pathReads = vi.mocked(app.getPath).mock.calls.length
    await expect(startSecretBroker(db)).rejects.toThrow('SECRET_BROKER_CLOSED')
    expect(() => writeSecretShellWrapper()).toThrow('SECRET_BROKER_CLOSED')
    expect(vi.mocked(app.getPath).mock.calls).toHaveLength(pathReads)
    await closeSecretBroker()
    await expect(fetch(`http://127.0.0.1:${firstPort}/secrets/export`)).rejects.toThrow()
    await expect(fetch(`http://127.0.0.1:${secondPort}/secrets/export`)).rejects.toThrow()
    expect(db.getSecretsWithValues).not.toHaveBeenCalled()
  })
})
