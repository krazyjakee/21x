import { describe, expect, it } from 'vitest'
import { getRepoProviders, recordRepoProviders, REPO_PROVIDERS_SETTING } from './repo-providers'

function memoryDb(initial: Record<string, string> = {}) {
  const store = { ...initial }
  return {
    store,
    getSetting: (key: string) => store[key],
    setSetting: (key: string, value: string) => { store[key] = value }
  }
}

describe('repo-providers', () => {
  it('records the provider each repo was attached from', () => {
    const db = memoryDb()
    recordRepoProviders(db, ['team/app', 'team/lib'], 'forgejo')
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
