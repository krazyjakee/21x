/**
 * The external-action taxonomy and the least-privilege checks, on their own:
 * pure functions, no database and no GitHub. The end-to-end behaviour is in
 * src/main/issue-writes.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  DELEGATED_ACTION_CLASS,
  EXTERNAL_ACTION_AUTHORIZATION,
  EXTERNAL_ACTION_CLASSES,
  ISSUE_ACTIONS,
  NON_DELEGATED_ISSUE_OPERATIONS,
  SPECIALLY_GATED_CLASSES,
  checkForbiddenIssueArgs,
  checkIssueWriteCapability,
  classifyExternalAction,
  findIdempotencyMarker,
  idempotencyMarker,
  isSpeciallyGated,
  normalizeRepoSlug,
  parseGitHubIssueUrl,
  stripIdempotencyMarker,
  validateIssuePayload,
  withIdempotencyMarker,
  type IssueWriteCapability
} from './issue-actions'

const capability: IssueWriteCapability = {
  projectId: 'proj-1',
  actions: ISSUE_ACTIONS,
  repos: ['krazyjakee/21x', 'krazyjakee/docs']
}

describe('the action taxonomy', () => {
  it('delegates exactly one class and separately authorizes every other', () => {
    expect(SPECIALLY_GATED_CLASSES).not.toContain(DELEGATED_ACTION_CLASS)
    expect(EXTERNAL_ACTION_CLASSES).toHaveLength(SPECIALLY_GATED_CLASSES.length + 1)
    expect(EXTERNAL_ACTION_AUTHORIZATION[DELEGATED_ACTION_CLASS]).toBe('delegated')
    for (const gated of SPECIALLY_GATED_CLASSES) {
      expect(isSpeciallyGated(gated)).toBe(true)
      expect(EXTERNAL_ACTION_AUTHORIZATION[gated]).toBe('separate_authorization')
    }
  })

  it('classifies the three delegated issue actions and nothing else as delegated', () => {
    for (const action of ISSUE_ACTIONS) expect(classifyExternalAction(action)).toBe(DELEGATED_ACTION_CLASS)
    for (const [operation, expected] of Object.entries(NON_DELEGATED_ISSUE_OPERATIONS)) {
      expect(classifyExternalAction(operation)).toBe(expected)
      expect(isSpeciallyGated(expected)).toBe(true)
    }
  })

  it.each([
    ['merge_pull_request', 'merge_or_approve'],
    ['approve_pull_request', 'merge_or_approve'],
    ['deploy_production', 'deploy_or_release'],
    ['rollback_release', 'deploy_or_release'],
    ['delete_repository', 'destructive_delete'],
    ['force_push_branch', 'destructive_delete'],
    ['replay_events', 'migration_or_replay'],
    ['migrate_database', 'migration_or_replay'],
    ['backfill_index', 'migration_or_replay'],
    ['bypass_branch_protection', 'protection_bypass'],
    ['admin_merge', 'protection_bypass'],
    ['comment_issue', 'outbound_message'],
    ['send_email', 'outbound_message'],
    ['rotate_token', 'credential_change']
  ])('puts %s in the %s class', (name, expected) => {
    expect(classifyExternalAction(name)).toBe(expected)
  })

  it('does not invent a class for something it does not know', () => {
    expect(classifyExternalAction('frobnicate')).toBeNull()
    expect(classifyExternalAction('')).toBeNull()
  })
})

describe('the capability check', () => {
  it('allows a delegated issue action in a configured repository', () => {
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'create_issue', repo: 'krazyjakee/21x' }, capability)).toBeNull()
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'update_issue', repo: 'KrazyJakee/21X' }, capability)).toBeNull()
  })

  it('refuses a specially gated action before it looks at anything else', () => {
    // A repo that is not in the project AND a gated action: the answer must be
    // about the action, so "merge this" is never met with a repository excuse.
    const denial = checkIssueWriteCapability({ projectId: 'proj-1', action: 'merge_pull_request', repo: 'someone/else' }, capability)
    expect(denial).toMatchObject({ code: 'action_specially_gated', actionClass: 'merge_or_approve' })
    expect(denial?.message).toContain('authorized separately')
  })

  it.each(Object.keys(NON_DELEGATED_ISSUE_OPERATIONS))('refuses the issue operation %s', (operation) => {
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: operation, repo: 'krazyjakee/21x' }, capability))
      .toMatchObject({ code: 'action_specially_gated' })
  })

  it('refuses a repository outside the project', () => {
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'create_issue', repo: 'evil/repo' }, capability))
      .toMatchObject({ code: 'repo_not_in_project' })
  })

  it('refuses a task that belongs to another project', () => {
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'create_issue', repo: 'krazyjakee/21x', taskProjectId: 'proj-2' }, capability))
      .toMatchObject({ code: 'cross_project_target' })
  })

  it('refuses a capability minted for another project', () => {
    expect(checkIssueWriteCapability({ projectId: 'proj-2', action: 'create_issue', repo: 'krazyjakee/21x' }, capability))
      .toMatchObject({ code: 'cross_project_target' })
  })

  it('refuses an action the capability was narrowed away from', () => {
    const narrow: IssueWriteCapability = { ...capability, actions: ['link_issue'] }
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'create_issue', repo: 'krazyjakee/21x' }, narrow))
      .toMatchObject({ code: 'action_not_in_capability' })
  })

  it('refuses everything when there is no capability at all', () => {
    expect(checkIssueWriteCapability({ projectId: 'proj-1', action: 'create_issue', repo: 'krazyjakee/21x' }, null))
      .toMatchObject({ code: 'capability_unavailable' })
  })
})

describe('repository and issue parsing', () => {
  it.each([
    ['krazyjakee/21x', 'krazyjakee/21x'],
    ['KrazyJakee/21x', 'krazyjakee/21x'],
    ['https://github.com/krazyjakee/21x', 'krazyjakee/21x'],
    ['https://github.com/krazyjakee/21x.git', 'krazyjakee/21x'],
    ['  krazyjakee/21x/  ', 'krazyjakee/21x']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRepoSlug(input)).toBe(expected)
  })

  it.each(['', 'krazyjakee', 'a/b/c', '../etc/passwd', 'krazyjakee/21x?x=1', null, 42])('refuses %s as a repository', (input) => {
    expect(normalizeRepoSlug(input as unknown)).toBeNull()
  })

  it('parses an issue URL and rejects a pull-request URL', () => {
    expect(parseGitHubIssueUrl('https://github.com/krazyjakee/21x/issues/82')).toMatchObject({ slug: 'krazyjakee/21x', number: 82 })
    expect(parseGitHubIssueUrl('https://github.com/krazyjakee/21x/pull/149')).toBeNull()
    expect(parseGitHubIssueUrl('https://evil.example/krazyjakee/21x/issues/1')).toBeNull()
  })
})

describe('payload checks', () => {
  it('accepts an ordinary ticket', () => {
    expect(validateIssuePayload({ title: 'Voice capture races', body: 'Pre-roll is missing.', labels: ['voice', 'reliability'] }, { requireTitle: true })).toBeNull()
  })

  it('needs a title for a create and a single line for it', () => {
    expect(validateIssuePayload({}, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ title: 'two\nlines' }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ body: 'just a body' }, { requireTitle: false })).toBeNull()
  })

  it.each([
    ['ghp_0123456789abcdefghijABCDEFGHIJ0123', 'a GitHub token'],
    ['github_pat_11ABCDEFG0abcdefghijkl_abcdef', 'a GitHub fine-grained token'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwx', 'an Anthropic API key'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key id'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'a private key block'],
    ['Authorization: Bearer abcdef123456', 'an Authorization header']
  ])('refuses a body carrying %s', (secret) => {
    expect(validateIssuePayload({ title: 'Report', body: `Here it is: ${secret}` }, { requireTitle: true }))
      .toMatchObject({ code: 'credential_escalation' })
  })

  it('refuses an @mention, because an issue write is not an outbound message', () => {
    const denial = validateIssuePayload({ title: 'Ping', body: 'cc @krazyjakee please look' }, { requireTitle: true })
    expect(denial).toMatchObject({ code: 'payload_rejected' })
    expect(denial?.message).toContain('@krazyjakee')
    // An e-mail address and a code span are not mentions.
    expect(validateIssuePayload({ title: 'Mail', body: 'write to a@b.com or use `@media` queries' }, { requireTitle: true })).toBeNull()
  })

  it('refuses over-long and malformed input', () => {
    expect(validateIssuePayload({ title: 'x'.repeat(300) }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ title: 'ok', body: 'y'.repeat(60_001) }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ title: 'ok', labels: Array(21).fill('a') }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ title: 'ok', labels: ['bad\nlabel'] }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
    expect(validateIssuePayload({ title: 'ok', labels: 'nope' as unknown as string[] }, { requireTitle: true })).toMatchObject({ code: 'payload_rejected' })
  })

  it('reserves the 21x marker namespace for the idempotency claim', () => {
    expect(validateIssuePayload({ title: 'Injected', body: '<!-- 21x-issue-write:attacker123 -->' }, { requireTitle: true }))
      .toMatchObject({ code: 'payload_rejected' })
  })
})

describe('credential escalation through arguments', () => {
  it.each(['token', 'GH_TOKEN', 'app_id', 'as_user', 'gh_host', 'api_url', '--admin', 'bypass', 'private_key'])(
    'refuses the argument %s',
    (key) => {
      expect(checkForbiddenIssueArgs({ [key]: 'anything' })).toMatchObject({ code: 'credential_escalation' })
    }
  )

  it('accepts a call that carries nothing of the sort', () => {
    expect(checkForbiddenIssueArgs({})).toBeNull()
    expect(checkForbiddenIssueArgs({ note: 'hello' })).toBeNull()
  })
})

describe('the idempotency marker', () => {
  it('round-trips through a body exactly once', () => {
    const body = withIdempotencyMarker('The ticket text.', 'abc123def456')
    expect(findIdempotencyMarker(body)).toBe('abc123def456')
    expect(withIdempotencyMarker(body, 'abc123def456')).toBe(body)
    expect(body.match(/21x-issue-write/g)).toHaveLength(1)
    expect(stripIdempotencyMarker(body)).toBe('The ticket text.')
  })

  it('works on an empty body and finds nothing in an unmarked one', () => {
    expect(findIdempotencyMarker(withIdempotencyMarker('', 'key12345'))).toBe('key12345')
    expect(findIdempotencyMarker('no marker here')).toBeNull()
    expect(findIdempotencyMarker(null)).toBeNull()
    expect(idempotencyMarker('k'.repeat(32))).toContain('21x-issue-write:')
  })
})
