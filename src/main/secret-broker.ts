import { app } from 'electron'
import type { DatabaseManager } from './database'
import { SecretBroker } from './secret-broker-core'
import { writeSecretShellWrapper as writePortableShellWrapper } from './secret-shell'
export { buildWindowsSecretShellScript } from './secret-shell'

let broker: { source: DatabaseManager; owner: SecretBroker } | null = null
const retired = new Set<SecretBroker>()
let closing = false

export function getSecretBrokerPort(): number | null { return broker?.owner.port ?? null }

export function registerSecretSession(token: string, agentId: string, secretIds: string[]): void {
  if (closing || !broker) throw new Error('SECRET_BROKER_UNAVAILABLE')
  broker.owner.register(token, agentId, secretIds)
}

export function unregisterSecretSession(token: string): void { broker?.owner.unregister(token) }

export function startSecretBroker(db: DatabaseManager): Promise<number> {
  if (closing) return Promise.reject(new Error('SECRET_BROKER_CLOSED'))
  if (broker && broker.source !== db) return Promise.reject(new Error('SECRET_BROKER_SOURCE_IN_USE'))
  broker ??= { source: db, owner: new SecretBroker(db) }
  return broker.owner.start()
}

/** Reusable stop; retired listeners remain owned until final close joins them. */
export function stopSecretBroker(): void {
  if (!broker) return
  const owner = broker.owner
  broker = null
  retired.add(owner)
  owner.shutdown()
}

export function shutdownSecretBroker(): void {
  closing = true
  stopSecretBroker()
}

export async function closeSecretBroker(timeoutMs = 2000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) {
    throw new RangeError('Secret broker shutdown deadline must be an integer from 1 to 3000 ms')
  }
  shutdownSecretBroker()
  await Promise.all([...retired].map(async owner => { await owner.close(timeoutMs); retired.delete(owner) }))
}

export function writeSecretShellWrapper(): string {
  if (closing) throw new Error('SECRET_BROKER_CLOSED')
  return writePortableShellWrapper(app.getPath('userData'))
}
