import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { initializeSkillDesktopState, rehydrateSkillDesktopState, useSkillStore } from './skill-store'
import { rehydrateSecretDesktopState, retireSecretDesktopState, useSecretStore } from './secret-store'

const skill = (id = 'skill_fixture', overrides = {}) => ({ id, name: id, description: '', content: 'Synthetic skill',
  confidence: 0.5, uses: 0, last_used: null, tags: [], preferred_model: null, project_id: null,
  version: 1, created_at: '2026-10-17', updated_at: '2026-10-17', ...overrides })
const secret = (id = 'secret_fixture', overrides = {}) => ({ id, name: id, description: '', env_var_name: 'SYNTHETIC_VALUE',
  created_at: '2026-10-17', updated_at: '2026-10-17', ...overrides })
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture() {
  let sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>()
  const values = new Map<string, unknown>([['skills:getAll', []], ['secrets:getAll', []], ['db:deleteTask', true]])
  const handlers = new Map<string, () => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1' }
    const operation = String(args?.operation)
    const value = handlers.has(operation) ? await handlers.get(operation)!() : values.get(operation)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
    if (name === 'desktop:event') receivers.add(receive)
    return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi)
  const release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  const changed = (kind = 'updated') => {
    for (const receive of [...receivers]) receive({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: 'engine-1', sequence: ++sequence,
      operation: 'skills:changed', payload: { skillId: 'skill_fixture', kind } } })
  }
  return { host, release, values, handlers, changed, invoke, calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation).length }
}
let f: Awaited<ReturnType<typeof fixture>>
let releaseSkills: () => void
const legacy = window.electronAPI
const finish: Array<() => void> = []
beforeEach(async () => {
  initializeSkillDesktopState()(); retireSecretDesktopState()
  f = await fixture(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  releaseSkills = initializeSkillDesktopState()
  useSkillStore.setState({ skills: [], selectedSkillId: null, scopeFilter: 'all', isLoading: false, error: null })
  useSecretStore.setState({ secrets: [], isLoading: false, error: null })
})
afterEach(async () => {
  releaseSkills(); retireSecretDesktopState(); f.release()
  for (const resolve of finish.splice(0)) resolve()
  await Promise.resolve()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
  initializeSkillDesktopState()
})

it('does not recover unused metadata caches or invoke a write', async () => {
  await Promise.all([rehydrateSkillDesktopState(), rehydrateSecretDesktopState()])
  expect(f.invoke.mock.calls.map(([command]) => command)).toEqual(['engine_status'])
})

it.each(['create', 'update', 'delete', 'setProject'] as const)('preserves accepted skill %s against a held typed snapshot without replay', async operation => {
  const previous = skill(), updated = skill('skill_fixture', operation === 'setProject' ? { project_id: 'project_other' } : { name: 'Accepted skill', confidence: 0.9 })
  const pending = held<unknown>(); finish.push(() => pending.resolve([])); f.handlers.set('skills:getAll', () => pending.promise)
  useSkillStore.setState({ skills: [previous], selectedSkillId: previous.id })
  const loading = useSkillStore.getState().fetchSkills()
  await vi.waitFor(() => expect(f.calls('skills:getAll')).toBe(1))
  const key = operation === 'setProject' ? 'skills:setProject' : `skills:${operation}`
  f.values.set(key, operation === 'delete' ? true : updated)
  const store = useSkillStore.getState()
  if (operation === 'create') await store.createSkill({ name: 'Accepted skill', description: '', content: 'Synthetic skill' })
  else if (operation === 'update') await store.updateSkill(previous.id, { name: 'Accepted skill', expected_version: 1 })
  else if (operation === 'setProject') await store.setSkillProject(previous.id, 'project_other')
  else await store.deleteSkill(previous.id)
  const current = operation === 'delete' ? [] : [updated]
  f.handlers.delete('skills:getAll'); f.values.set('skills:getAll', current)
  pending.resolve([previous]); await loading
  expect(useSkillStore.getState().skills).toEqual(current)
  expect(f.calls(key)).toBe(1); expect(f.calls('skills:getAll')).toBe(2)
  if (operation === 'delete') expect(useSkillStore.getState().selectedSkillId).toBeNull()
})

it.each(['create', 'update', 'delete'] as const)('preserves accepted secret metadata %s without exposing a value or replaying a write', async operation => {
  const previous = secret(), updated = secret('secret_fixture', { name: 'Accepted metadata' })
  const pending = held<unknown>(); finish.push(() => pending.resolve([])); f.handlers.set('secrets:getAll', () => pending.promise)
  useSecretStore.setState({ secrets: [previous] })
  const loading = useSecretStore.getState().fetchSecrets()
  await vi.waitFor(() => expect(f.calls('secrets:getAll')).toBe(1))
  const key = `secrets:${operation}`; f.values.set(key, operation === 'delete' ? true : updated)
  const store = useSecretStore.getState()
  if (operation === 'create') await store.createSecret({ name: 'Synthetic', description: '', env_var_name: 'SYNTHETIC_VALUE', value: 'synthetic-not-a-credential' })
  else if (operation === 'update') await store.updateSecret(previous.id, { name: 'Accepted metadata' })
  else await store.deleteSecret(previous.id)
  const current = operation === 'delete' ? [] : [updated]
  f.handlers.delete('secrets:getAll'); f.values.set('secrets:getAll', current)
  pending.resolve([previous]); await loading
  expect(useSecretStore.getState().secrets).toEqual(current)
  expect(JSON.stringify(useSecretStore.getState().secrets)).not.toContain('synthetic-not-a-credential')
  expect(f.calls(key)).toBe(1); expect(f.calls('secrets:getAll')).toBe(2)
})

it('joins both demanded metadata snapshots before allowing native mutations', async () => {
  await Promise.all([useSkillStore.getState().fetchSkills(), useSecretStore.getState().fetchSecrets()])
  const skills = held<unknown>(), secrets = held<unknown>(); finish.push(() => skills.resolve([]), () => secrets.resolve([]))
  f.handlers.set('skills:getAll', () => skills.promise); f.handlers.set('secrets:getAll', () => secrets.promise)
  f.host.setRehydrator(async () => { await Promise.all([rehydrateSkillDesktopState(), rehydrateSecretDesktopState()]) })
  const recovering = f.host.reconnect(); void recovering.catch(() => {})
  await vi.waitFor(() => expect(f.calls('secrets:getAll')).toBe(2))
  await expect(f.host.api.db.deleteTask('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  skills.resolve([]); await Promise.resolve(); expect(f.host.hydrationPending).toBe(true)
  secrets.resolve([]); await recovering
  expect(f.host.hydrationPending).toBe(false); expect(f.calls('db:deleteTask')).toBe(0)
})

it.each(['skills', 'secrets'] as const)('does not duplicate %s when a canonical read precedes the accepted create receipt', async domain => {
  const pending = held<unknown>(), result = domain === 'skills' ? skill() : secret()
  finish.push(() => pending.resolve(result)); f.handlers.set(`${domain}:create`, () => pending.promise)
  const saving = domain === 'skills' ? useSkillStore.getState().createSkill({ name: 'Synthetic', description: '', content: '' })
    : useSecretStore.getState().createSecret({ name: 'Synthetic', description: '', env_var_name: 'SYNTHETIC_VALUE', value: 'synthetic-not-a-credential' })
  await vi.waitFor(() => expect(f.calls(`${domain}:create`)).toBe(1))
  f.values.set(`${domain}:getAll`, [result])
  if (domain === 'skills') await useSkillStore.getState().fetchSkills()
  else await useSecretStore.getState().fetchSecrets()
  pending.resolve(result); await saving
  expect(domain === 'skills' ? useSkillStore.getState().skills : useSecretStore.getState().secrets).toEqual([result])
  expect(f.calls(`${domain}:create`)).toBe(1)
})

it.each(['skills', 'secrets'] as const)('recovers %s metadata first populated by an accepted create, without replay', async domain => {
  f.values.set(`${domain}:create`, domain === 'skills' ? skill() : secret())
  if (domain === 'skills') await useSkillStore.getState().createSkill({ name: 'Synthetic', description: '', content: '' })
  else await useSecretStore.getState().createSecret({ name: 'Synthetic', description: '', env_var_name: 'SYNTHETIC_VALUE', value: 'synthetic-not-a-credential' })
  await (domain === 'skills' ? rehydrateSkillDesktopState() : rehydrateSecretDesktopState())
  expect(f.calls(`${domain}:getAll`)).toBe(1); expect(f.calls(`${domain}:create`)).toBe(1)
})

it.each(['skills', 'secrets'] as const)('keeps %s read failures fenced until explicit read-only recovery', async domain => {
  const fetch = domain === 'skills' ? () => useSkillStore.getState().fetchSkills() : () => useSecretStore.getState().fetchSecrets()
  const recover = domain === 'skills' ? rehydrateSkillDesktopState : rehydrateSecretDesktopState
  await fetch(); f.handlers.set(`${domain}:getAll`, async () => { throw new Error('private-value-canary') })
  f.host.setRehydrator(recover)
  await expect(f.host.rehydrate()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.db.deleteTask('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(JSON.stringify([useSkillStore.getState().error, useSecretStore.getState().error])).not.toContain('canary')
  f.handlers.delete(`${domain}:getAll`); await f.host.rehydrate()
  expect(f.host.hydrationPending).toBe(false); expect(f.calls('db:deleteTask')).toBe(0)
})

it('invalidates a demanded skill snapshot from the exact canonical scope event', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve([])); f.handlers.set('skills:getAll', () => pending.promise)
  const loading = useSkillStore.getState().fetchSkills()
  await vi.waitFor(() => expect(f.calls('skills:getAll')).toBe(1))
  f.changed('scope'); f.handlers.delete('skills:getAll'); f.values.set('skills:getAll', [skill('skill_fixture', { project_id: 'project_other' })])
  pending.resolve([skill()]); await loading
  expect(useSkillStore.getState().skills[0].project_id).toBe('project_other'); expect(f.calls('skills:getAll')).toBe(2)
})

it('bounds repeated skill invalidation at eight reads while mutation recovery remains fenced', async () => {
  await useSkillStore.getState().fetchSkills()
  f.handlers.set('skills:getAll', async () => { f.changed(); return [] })
  f.host.setRehydrator(rehydrateSkillDesktopState)
  await expect(f.host.rehydrate()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  expect(f.calls('skills:getAll')).toBe(9); expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.db.deleteTask('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.calls('db:deleteTask')).toBe(0)
})

it('retires old skill readers/listeners and prevents an old disposer retiring the replacement cohort', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve([])); f.handlers.set('skills:getAll', () => pending.promise)
  const loading = useSkillStore.getState().fetchSkills()
  await vi.waitFor(() => expect(f.calls('skills:getAll')).toBe(1)); releaseSkills()
  f.handlers.delete('skills:getAll'); f.values.set('skills:getAll', [skill('replacement')])
  const oldRelease = releaseSkills; releaseSkills = initializeSkillDesktopState()
  await useSkillStore.getState().fetchSkills(); pending.resolve([skill('retired')]); await loading
  expect(useSkillStore.getState().skills[0].id).toBe('replacement')
  oldRelease(); f.values.set('skills:getAll', [skill('current')]); f.changed()
  await vi.waitFor(() => expect(useSkillStore.getState().skills[0].id).toBe('current'))
  expect(f.calls('skills:getAll')).toBe(3)
})

it('fences a known accepted metadata write after document retirement without replay', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(secret()))
  f.handlers.set('secrets:update', () => pending.promise)
  const saving = useSecretStore.getState().updateSecret('secret_fixture', { name: 'Retired update' })
  await vi.waitFor(() => expect(f.calls('secrets:update')).toBe(1)); retireSecretDesktopState()
  f.values.set('secrets:getAll', [secret('replacement')]); await useSecretStore.getState().fetchSecrets()
  pending.resolve(secret('secret_fixture', { name: 'Retired update' })); await saving
  expect(useSecretStore.getState().secrets[0].id).toBe('replacement'); expect(f.calls('secrets:update')).toBe(1)
})

it('removes the document skill listener on pagehide and performs no new read from late events', async () => {
  await useSkillStore.getState().fetchSkills()
  window.dispatchEvent(new Event('pagehide')); f.changed()
  await Promise.resolve(); expect(f.calls('skills:getAll')).toBe(1)
})
