import { describe, expect, it } from 'vitest'
import { GIT_PROVIDER_CODECS, GIT_PROVIDER_OPERATIONS, GIT_PROVIDER_LIMITS } from './git-provider-codecs'

const repo = { name: 'repo', fullName: 'team/repo', defaultBranch: 'main', cloneUrl: 'https://github.com/team/repo.git', description: 'Synthetic repository\nSecond line.', isPrivate: true }
const login = { name: 'synthetic-work', url: 'https://forgejo.example', sshHost: 'forgejo.example:2222', user: 'fixture', isDefault: true }
const tea = { installed: true, authenticated: true, logins: [login], login: login.name, username: 'fixture', serverUrl: login.url, code: 'ready' }
const pr = { url: 'https://github.com/team/repo/pull/3', repository: 'team/repo', number: 3, title: 'Synthetic pull request', body: 'Human description\nSecond line.', state: 'open', isDraft: false, reviewDecision: 'none', author: { login: 'fixture', avatarUrl: 'https://avatars.example/u/1', url: 'https://github.com/fixture' }, baseRefName: 'main', headRefName: 'feature', additions: 1, deletions: 2, changedFiles: 3, commentsCount: 0, reviewsCount: 0, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', checks: [{ name: 'Synthetic check', state: 'passed', url: 'https://ci.example/run/3' }] }

describe('finite retained Git provider codecs', () => {
  it('names exactly fifteen existing colon commands', () => {
    expect(Object.keys(GIT_PROVIDER_CODECS)).toEqual([...GIT_PROVIDER_OPERATIONS]); expect(GIT_PROVIDER_OPERATIONS).toHaveLength(15)
    expect(GIT_PROVIDER_OPERATIONS).not.toContain('gitlab:fetchPullRequestDetails')
  })
  it('preserves zero-argument requests and concrete status/organization/repository responses', () => {
    for (const operation of GIT_PROVIDER_OPERATIONS.filter(op => !op.endsWith('fetchOrgRepos') && !['forgejo:setLogin', 'git:recordRepoProviders', 'github:fetchPullRequestDetails'].includes(op))) {
      const codec = GIT_PROVIDER_CODECS[operation]
      expect(codec.encodeArguments([] as never)).toEqual({}); expect(codec.decodeArguments({})).toEqual([])
      const result = operation.endsWith('checkCli') ? operation.startsWith('forgejo:') ? tea : { installed: true, authenticated: true, username: 'fixture' } : operation.endsWith('fetchOrgs') ? ['team'] : [repo]
      const encoded = codec.encodeResult(result); expect(codec.validateWireResult(encoded)).toBe(true); expect(codec.validateResult(codec.decodeResult(encoded.defined ? encoded.value : undefined))).toBe(true)
    }
  })
  it('preserves exact org/login/url/provider argument keys and void missing-result semantics', () => {
    expect(GIT_PROVIDER_CODECS['github:fetchOrgRepos'].encodeArguments(['team'])).toEqual({ org: 'team' })
    expect(GIT_PROVIDER_CODECS['gitlab:fetchOrgRepos'].decodeArguments({ org: 'team/subgroup' })).toEqual(['team/subgroup'])
    expect(GIT_PROVIDER_CODECS['forgejo:setLogin'].decodeArguments({ loginName: null })).toEqual([null])
    expect(GIT_PROVIDER_CODECS['forgejo:setLogin'].encodeArguments(['synthetic-work'])).toEqual({ loginName: 'synthetic-work' })
    expect(GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].encodeArguments([pr.url])).toEqual({ url: pr.url })
    const codec = GIT_PROVIDER_CODECS['git:recordRepoProviders']
    expect(codec.encodeArguments([['team/subgroup/repo'], 'gitlab'])).toEqual({ repoFullNames: ['team/subgroup/repo'], provider: 'gitlab' })
    expect(codec.encodeResult(undefined)).toEqual({ defined: false }); expect(codec.decodeResult(undefined)).toBeUndefined(); expect(codec.validateWireResult({ defined: false })).toBe(true)
    expect(codec.validateWireResult({ defined: true, value: null })).toBe(false); expect(codec.validateWireResult({ defined: false, value: null })).toBe(false)
  })
  it('refuses extra fields, malformed CLI identities, injected arguments, and unsupported PR routes', () => {
    for (const value of ['--version', '../team', 'team\n--secret', '', '__proto__']) expect(() => GIT_PROVIDER_CODECS['github:fetchOrgRepos'].encodeArguments([value])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => GIT_PROVIDER_CODECS['github:fetchOrgRepos'].decodeArguments({ org: 'team', shell: true })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    for (const url of ['file:///repo/pull/1', 'https://user:private@github.com/team/repo/pull/3', 'https://github.com/team/repo/pull/3?token=private', 'https://gitlab.example/team/repo/merge_requests/3', 'https://forgejo.example/api/v1/repos/team/repo/pulls/3', 'https://github.com/team/repo/pull/0']) expect(() => GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].encodeArguments([url])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].validateArguments(['https://forgejo.example/team/repo/pulls/3'])).toBe(true)
    expect(() => GIT_PROVIDER_CODECS['git:recordRepoProviders'].encodeArguments([['__proto__/repo'], 'github'])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => GIT_PROVIDER_CODECS['git:recordRepoProviders'].encodeArguments([['team/repo', 'team/repo'], 'github'])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => GIT_PROVIDER_CODECS['github:checkCli'].encodeResult({ installed: false, authenticated: true })).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => GIT_PROVIDER_CODECS['github:checkCli'].encodeResult({ installed: true, authenticated: true, username: 'ghp_PRIVATE_TOKEN' })).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
  })
  it('projects URL fields and fixed Tea errors without private query/userinfo/raw diagnostics', () => {
    const raw = { ...tea, code: 'unauthorized', authenticated: false, message: 'Authorization failed with PRIVATE-TOKEN at /private/config', serverUrl: 'https://user:PRIVATE-TOKEN@forgejo.example/?token=PRIVATE-TOKEN', logins: [{ ...login, url: 'https://user:PRIVATE-TOKEN@forgejo.example/?signature=PRIVATE-TOKEN', sshHost: 'ssh://git:PRIVATE-TOKEN@forgejo.example:2222' }], token: 'PRIVATE-TOKEN' }
    const encoded = GIT_PROVIDER_CODECS['forgejo:checkCli'].encodeResult(raw)
    expect(JSON.stringify(encoded)).not.toContain('PRIVATE-TOKEN'); expect(JSON.stringify(encoded)).not.toContain('/private/config')
    expect(encoded).toMatchObject({ value: { message: 'The configured tea login was not authorized.', serverUrl: 'https://forgejo.example/', logins: [{ sshHost: 'forgejo.example:2222' }] } })
    expect(() => GIT_PROVIDER_CODECS['forgejo:checkCli'].decodeResult(raw as never)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => GIT_PROVIDER_CODECS['forgejo:checkCli'].encodeResult({ ...tea, logins: [login, login] })).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
  })
  it('retains meaningful PR metadata while stripping credential URLs and rejecting malformed fields', () => {
    const encoded = GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].encodeResult({ ...pr, author: { ...pr.author, avatarUrl: 'https://user:PRIVATE-TOKEN@avatars.example/u/1?signature=PRIVATE-TOKEN' }, checks: [{ ...pr.checks[0], url: 'https://ci.example/run/3?token=PRIVATE-TOKEN' }] })
    expect(JSON.stringify(encoded)).not.toContain('PRIVATE-TOKEN'); expect(encoded).toMatchObject({ value: { title: pr.title, body: pr.body, commentsCount: 0, author: { avatarUrl: 'https://avatars.example/u/1' }, checks: [{ url: 'https://ci.example/run/3' }] } })
    expect(GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].encodeResult({ ...pr, author: { login: 'dependabot[bot]' } })).toMatchObject({ value: { author: { login: 'dependabot[bot]' } } })
    for (const invalid of [{ ...pr, checks: [{ name: 'x', state: 'complete' }] }, { ...pr, additions: -1 }, { ...pr, number: null }, { ...pr, body: 'é'.repeat(GIT_PROVIDER_LIMITS.bodyBytes) }]) expect(() => GIT_PROVIDER_CODECS['github:fetchPullRequestDetails'].encodeResult(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
  })
  it('caps counts and the entire encoded UTF-8 result envelope below the private frame budget', () => {
    const codec = GIT_PROVIDER_CODECS['github:fetchUserRepos']
    const rows = Array.from({ length: 260 }, (_, i) => ({ ...repo, name: `r${i}`, fullName: `team/r${i}`, description: 'é'.repeat(1800) }))
    expect(() => codec.encodeResult(rows)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    const small = codec.encodeResult(rows.slice(0, 100)); expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThan(GIT_PROVIDER_LIMITS.resultBytes)
    expect(() => codec.encodeResult(Array.from({ length: GIT_PROVIDER_LIMITS.repositories + 1 }, (_, i) => ({ ...repo, name: `r${i}`, fullName: `team/r${i}` })))).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => GIT_PROVIDER_CODECS['github:fetchOrgs'].encodeResult(Array.from({ length: GIT_PROVIDER_LIMITS.organizations + 1 }, (_, i) => `team${i}`))).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => GIT_PROVIDER_CODECS['git:recordRepoProviders'].encodeArguments([Array.from({ length: GIT_PROVIDER_LIMITS.requestRepositories + 1 }, (_, i) => `team/r${i}`), 'github'])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
  })
})
