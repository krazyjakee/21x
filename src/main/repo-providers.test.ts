import { describe, expect, it } from 'vitest'
import { getRepoProviders, recordRepoProviders, resolveRepoProvider, REPO_PROVIDERS_SETTING } from './repo-providers'

function memoryDb(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    getSetting: (key: string) => store[key],
    setSetting: (key: string, value: string) => { store[key] = value }
  }
}

describe('repo-providers', () => {
  it('falls back to the configured provider, then GitHub', () => {
    expect(resolveRepoProvider(memoryDb(), 'a/b')).toBe('github')
    expect(resolveRepoProvider(memoryDb({ git_provider: 'gitlab' }), 'a/b')).toBe('gitlab')
    expect(resolveRepoProvider(memoryDb({ git_provider: '' }), 'a/b')).toBe('github')
  })

  it('prefers the provider recorded when the repo was attached', () => {
    const db = memoryDb({ git_provider: 'github' })
    recordRepoProviders(db, ['team/app', 'team/lib'], 'forgejo')
    expect(resolveRepoProvider(db, 'team/app')).toBe('forgejo')
    expect(resolveRepoProvider(db, 'other/repo')).toBe('github')
    expect(getRepoProviders(db)).toEqual({ 'team/app': 'forgejo', 'team/lib': 'forgejo' })
  })

  it('ignores corrupt or unknown entries', () => {
    const db = memoryDb({ [REPO_PROVIDERS_SETTING]: '{"a/b":"svn","c/d":"forgejo"}' })
    expect(getRepoProviders(db)).toEqual({ 'c/d': 'forgejo' })
    expect(getRepoProviders(memoryDb({ [REPO_PROVIDERS_SETTING]: 'not json' }))).toEqual({})
  })

  it('does not rewrite the setting when nothing changed', () => {
    const db = memoryDb()
    recordRepoProviders(db, ['a/b'], 'forgejo')
    const before = db.store[REPO_PROVIDERS_SETTING]
    let writes = 0
    const counting = { ...db, setSetting: () => { writes++ } }
    recordRepoProviders(counting, ['a/b'], 'forgejo')
    expect(writes).toBe(0)
    expect(db.store[REPO_PROVIDERS_SETTING]).toBe(before)
  })
})
