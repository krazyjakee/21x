import { expect, it } from 'vitest'
import { productionBootstrapMessage } from './tauri-desktop-transport'

it('projects only known startup failures into fixed redacted provisioning guidance', () => {
  const status = (code: string, phase: string) => ({ protocolVersion: 1, production: true, available: false, startupFailure: { code, phase, path: '/private/profile', error: 'private credential detail' } })
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-delegation-missing'))).toBe('Desktop process supervision is unavailable. Provision the native environment and relaunch the app. Changes are paused.')
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-windows-private-fd3-unavailable'))).toContain('Windows yet')
  expect(productionBootstrapMessage(status('INVALID_RESULT', 'production-manifest-digest'))).toContain('resources could not be verified')
  for (const phase of ['production-resources', 'production-manifest-build-digest', 'production-manifest-build-identity']) expect(productionBootstrapMessage(status('INVALID_RESULT', phase))).toContain('resources could not be verified')
  expect(productionBootstrapMessage(status('PROFILE_IN_USE', 'profile-lock'))).toContain('Another desktop service owns this profile')
  expect(productionBootstrapMessage(status('SECRET_STORE_UNAVAILABLE', 'credentials'))).toContain('protected credential store is unavailable')
  expect(productionBootstrapMessage(status('PRIVATE:/path', 'private credential detail'))).toBeNull()
  expect(productionBootstrapMessage(status('PRODUCTION_CONTAINMENT_UNAVAILABLE', '/private/profile'))).toBeNull()
  expect(productionBootstrapMessage({ ...status('PRODUCTION_CONTAINMENT_UNAVAILABLE', 'production-delegation-missing'), production: false })).toBeNull()
  expect(JSON.stringify(productionBootstrapMessage(status('PROFILE_IN_USE', 'profile-lock')))).not.toContain('private')
})
