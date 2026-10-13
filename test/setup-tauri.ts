import { afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { AuthenticatedSecretStorage } from '../src/main/platform/authenticated-secret-storage'
import { configureSecretStorage } from '../src/main/platform/secret-storage'

if (process.versions.electron) throw new Error('Standalone Node is required for portable tests')
const key = randomBytes(32)
const storage = new AuthenticatedSecretStorage(key, 'portable-test-fixture')
key.fill(0)
configureSecretStorage(storage)
afterAll(() => storage.dispose())
