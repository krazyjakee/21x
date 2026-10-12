import { describe, expect, it } from 'vitest'
import { BrowserAuthority, type BrowserOperationTicket, type BrowserSession } from './browser-authority'
import { BROWSER_POLICY_ERRORS, BROWSER_POLICY_LIMITS, BrowserNavigationPolicy } from './browser-policy'
import { isRecord, hasExactKeys } from './service-protocol'

function fixture(permissionMode: 'ask' | 'allow' = 'allow') {
  const navigation = new BrowserNavigationPolicy(['http://localhost:1420', 'http://127.0.0.1:49001'])
  const authority = new BrowserAuthority({ engineEpoch: 'engine-1', navigation,
    protectedViewIds: ['desktop', 'credentials'], requestSchemas: {
      navigate: value => isRecord(value) && hasExactKeys(value, ['url']) && typeof value.url === 'string',
      snapshot: value => isRecord(value) && hasExactKeys(value, []),
      interact: value => isRecord(value) && hasExactKeys(value, ['target', 'text']) &&
        typeof value.target === 'string' && typeof value.text === 'string'
    } })
  authority.registerPanel('panel-a', 'browser-view-a', ['task-a'])
  const session = authority.createSession('task-a', 'session-a', {
    permissionMode, operations: ['navigate', 'snapshot', 'interact', 'screenshot']
  })
  return { authority, session, navigation }
}

describe('browser navigation boundary', () => {
  const policy = new BrowserNavigationPolicy(['http://localhost:1420', 'http://127.0.0.1:49001'])

  it.each([
    'https://example.com/login?return=%2Fdashboard#section',
    'http://intranet.company.test:8080/dashboard',
    'http://localhost:3000/', 'http://127.0.0.1:8000/', 'http://192.168.0.5/',
    'http://[::1]:3000/', 'https://例え.テスト/path', 'HTTPS://EXAMPLE.COM:443/'
  ])('retains actual public, intranet and developer site URLs: %s', url => {
    expect(policy.normalize(url)).toBe(new URL(url).href)
  })

  it.each([
    'tauri://localhost/', 'app-attachment://local/file', 'file:///etc/passwd',
    'javascript:alert(1)', 'data:text/html,hello', 'blob:https://example.com/id',
    'https://user:secret@example.com/', 'https://@example.com/', 'https://user%40secret@example.com/',
    'http://tauri.localhost/', 'https://TAURI.LOCALHOST.:444/', 'http://ipc.localhost/',
    'http://localhost:1420/engine', 'http://localhost.:1420/', 'http://127.1:49001/',
    'https://example.com\n/private', 'https://example.com\\@evil.test/',
    ' https://example.com/', 'https://example.com/a b', 'https:////example.com/',
    'example.com', '//example.com/', 'https://', 'https://example.com:99999/', ''
  ])('rejects private origins, userinfo and malformed input without leaking its URL: %s', url => {
    expect(() => policy.normalize(url)).toThrow(BROWSER_POLICY_ERRORS.NAVIGATION_DENIED)
    expect(policy.allows(url)).toBe(false)
  })

  it('keeps query/hash intact but bounds input and validates excluded origins', () => {
    expect(policy.normalize('https://example.com/?q=secret#part')).toBe('https://example.com/?q=secret#part')
    expect(() => policy.normalize('https://example.com/' + 'a'.repeat(BROWSER_POLICY_LIMITS.urlCharacters)))
      .toThrow(BROWSER_POLICY_ERRORS.NAVIGATION_DENIED)
    expect(() => new BrowserNavigationPolicy(['https://example.com/not-an-origin']))
      .toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
  })
})

describe('browser task/session authority', () => {
  it('binds the only task-linked panel and rejects cross-task and ambiguous selection', () => {
    const { authority, session } = fixture()
    authority.registerPanel('panel-b', 'browser-view-b', ['task-b'])
    expect(authority.listPanels(session)).toEqual(['panel-a'])
    const ticket = authority.issueOperation(session, 'snapshot', {})
    expect(ticket.panelId).toBe('panel-a')
    expect(ticket.nativeViewId).toBe('browser-view-a')
    expect(() => authority.issueOperation(session, 'snapshot', {}, 'panel-b'))
      .toThrow(BROWSER_POLICY_ERRORS.PANEL_UNAVAILABLE)
    authority.registerPanel('panel-c', 'browser-view-c', ['task-a'])
    expect(() => authority.issueOperation(session, 'snapshot', {})).toThrow(BROWSER_POLICY_ERRORS.AMBIGUOUS_PANEL)
    expect(authority.issueOperation(session, 'snapshot', {}, 'panel-c').panelId).toBe('panel-c')
  })

  it('never accepts trusted native views, duplicate labels or caller-crafted session/ticket objects', () => {
    const { authority, session } = fixture()
    for (const nativeViewId of ['main', 'desktop', 'credentials', 'browser-view-a']) {
      expect(() => authority.registerPanel('other', nativeViewId, ['task-a'])).toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
    }
    expect(() => authority.issueOperation({ ...session } as BrowserSession, 'snapshot', {}))
      .toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    const ticket = authority.issueOperation(session, 'snapshot', {})
    expect(() => authority.startOperation({ ...ticket } as BrowserOperationTicket)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
  })

  it('requires correlated approval and binds the immutable request used for native dispatch', () => {
    const { authority, session } = fixture('ask')
    const args = { target: 'input[name=search]', text: 'approved text' }
    const ticket = authority.issueOperation(session, 'interact', args)
    args.text = 'changed after approval'
    expect(ticket.request).toEqual({ target: 'input[name=search]', text: 'approved text' })
    expect(Object.isFrozen(ticket.request)).toBe(true)
    expect(() => authority.startOperation(ticket)).toThrow(BROWSER_POLICY_ERRORS.APPROVAL_REQUIRED)
    expect(() => authority.assertOperationCurrent(ticket)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    authority.approveOperation(ticket, true)
    authority.startOperation(ticket)
    authority.assertOperationCurrent(ticket)
    expect(() => authority.startOperation(ticket)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(() => authority.approveOperation(ticket, true)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(authority.finishOperation(ticket)).toBe(true)
    expect(() => authority.startOperation(ticket)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
  })

  it('denies rejected approvals, unavailable adapters and operations absent from the session grant', () => {
    const { authority, session } = fixture('ask')
    const ticket = authority.issueOperation(session, 'snapshot', {})
    authority.approveOperation(ticket, false)
    expect(ticket.signal.aborted).toBe(true)
    expect(() => authority.startOperation(ticket)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(() => authority.issueOperation(session, 'screenshot', {})).toThrow(BROWSER_POLICY_ERRORS.UNSUPPORTED_OPERATION)
    expect(() => authority.issueOperation(session, 'console', {})).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
  })

  it('validates navigation before admission and never exposes input in denial diagnostics', () => {
    const { authority, session } = fixture()
    expect(() => authority.issueOperation(session, 'navigate', { url: 'https://user:super-secret@example.com/' }))
      .toThrow(BROWSER_POLICY_ERRORS.NAVIGATION_DENIED)
    const ticket = authority.issueOperation(session, 'navigate', { url: 'HTTPS://EXAMPLE.COM:443/path?q=1' })
    expect(ticket.request).toEqual({ url: 'https://example.com/path?q=1' })
    expect(() => authority.issueOperation(session, 'navigate', { url: 'https://example.com/', preload: '/secret' }))
      .toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
    expect(() => authority.issueOperation(session, 'snapshot', { arbitrary: 'secret' })).toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
  })

  it('invalidates queued/running work when task links change, including retained links', () => {
    const { authority, session } = fixture()
    const queued = authority.issueOperation(session, 'snapshot', {})
    const running = authority.issueOperation(session, 'snapshot', {})
    authority.startOperation(running)
    authority.setPanelTasks('panel-a', ['task-a', 'task-b'])
    expect(queued.signal.aborted).toBe(true)
    expect(running.signal.aborted).toBe(true)
    expect(() => authority.startOperation(queued)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(() => authority.assertOperationCurrent(running)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(authority.finishOperation(running)).toBe(false)
    expect(authority.pendingOperationCount).toBe(0)
    expect(authority.issueOperation(session, 'snapshot', {}).panelId).toBe('panel-a')
  })

  it('panel disposal, reused IDs and session revocation cannot revive old authority', () => {
    const { authority, session } = fixture()
    const running = authority.issueOperation(session, 'snapshot', {})
    authority.startOperation(running)
    authority.disposePanel('panel-a')
    authority.registerPanel('panel-a', 'browser-view-a', ['task-a'])
    expect(authority.finishOperation(running)).toBe(false)
    const pending = authority.issueOperation(session, 'snapshot', {})
    authority.revokeSession(session)
    expect(pending.signal.aborted).toBe(true)
    const replacement = authority.createSession('task-a', 'session-a', { operations: ['snapshot'], permissionMode: 'allow' })
    expect(() => authority.issueOperation(session, 'snapshot', {})).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(authority.issueOperation(replacement, 'snapshot', {}).panelId).toBe('panel-a')
  })

  it('retains capacity for aborted native work until completion and remains terminal after disposal', () => {
    const { authority, session } = fixture()
    const tickets = Array.from({ length: BROWSER_POLICY_LIMITS.operations }, () => authority.issueOperation(session, 'snapshot', {}))
    tickets.forEach(ticket => authority.startOperation(ticket))
    tickets.forEach(ticket => authority.cancelOperation(ticket))
    expect(authority.pendingOperationCount).toBe(BROWSER_POLICY_LIMITS.operations)
    expect(() => authority.issueOperation(session, 'snapshot', {})).toThrow(BROWSER_POLICY_ERRORS.CAPACITY_REACHED)
    expect(authority.finishOperation(tickets[0])).toBe(false)
    expect(authority.issueOperation(session, 'snapshot', {}).signal.aborted).toBe(false)
    authority.dispose()
    expect(() => authority.listPanels(session)).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    expect(() => authority.registerPanel('new', 'view-new', [])).toThrow(BROWSER_POLICY_ERRORS.NOT_AUTHORIZED)
    for (const ticket of tickets.slice(1)) expect(authority.finishOperation(ticket)).toBe(false)
  })

  it('denies every remote native permission and bounds registration and request payloads', () => {
    const { authority, session } = fixture()
    for (const permission of ['microphone', 'camera', 'display', 'clipboard', 'location', 'notifications', 'unknown']) {
      expect(authority.remotePermissionDecision('browser-view-a', permission)).toBe('deny')
    }
    expect(authority.remotePermissionDecision('main', 'microphone')).toBe('deny')
    expect(() => authority.issueOperation(session, 'interact', { target: 'input', text: 'a'.repeat(BROWSER_POLICY_LIMITS.requestBytes) }))
      .toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
    expect(() => authority.registerPanel('too-many', 'view-big', Array.from({ length: BROWSER_POLICY_LIMITS.tasksPerPanel + 1 }, () => 'task-a')))
      .toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
    expect(() => authority.createSession('task-a', 'session-a', { operations: ['snapshot'] })).toThrow(BROWSER_POLICY_ERRORS.INVALID_ARGUMENTS)
  })

  it('caps independent panel/session registrations so rejected operation grants cannot exhaust memory', () => {
    const { authority } = fixture()
    for (let i = 1; i < BROWSER_POLICY_LIMITS.panels; i++) authority.registerPanel(`panel-${i}`, `view-${i}`, [])
    expect(() => authority.registerPanel('overflow-panel', 'overflow-view', [])).toThrow(BROWSER_POLICY_ERRORS.CAPACITY_REACHED)
    for (let i = 1; i < BROWSER_POLICY_LIMITS.sessions; i++) authority.createSession('task-a', `session-${i}`, { operations: [] })
    expect(() => authority.createSession('task-a', 'overflow-session', { operations: [] })).toThrow(BROWSER_POLICY_ERRORS.CAPACITY_REACHED)
  })
})
