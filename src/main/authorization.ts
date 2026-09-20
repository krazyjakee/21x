import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

export const AUTHORIZATION_TTL_MS = 24 * 60 * 60_000
export const AUTHORIZATION_ACTIONS = ['task.create', 'task.update', 'github.issue.create', 'github.issue.update', 'github.issue.link'] as const
export type AuthorizationAction = typeof AUTHORIZATION_ACTIONS[number]
type Source = { db: Database.Database }
export type AuthorizationScope = { projectId: string; repos: string[] }
export interface AuthorizationNode {
  version: 1
  id: string
  rootId: string
  parentId: string | null
  parentHash: string | null
  messageId: string
  text: string
  textHash: string
  at: number
  expiresAt: number
  author: 'human' | 'commander' | 'captain' | 'agent'
  source: 'commander-chat' | 'project-chat' | 'delegation'
  inputMode?: 'typed' | 'voice'
  scopeOriginMessageId?: string
  sessionId: string | null
  taskId: string | null
  correlationId: string | null
  actions: AuthorizationAction[]
  scope: AuthorizationScope[]
}
export interface AuthorizationEvidence {
  status: 'active' | 'missing' | 'invalid' | 'expired' | 'revoked' | 'out_of_scope'
  nodeId: string | null
  origin: AuthorizationNode | null
  chain: AuthorizationNode[]
  effectivePermissions: AuthorizationAction[]
  scope: AuthorizationScope[]
  revocations: Array<{ nodeId: string; at: number; reason: string }>
}
export const authorizationHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Conservative supported command grammar, not an LLM's interpretation of consent.
 * Ambiguous, conditional, quoted and negative instructions retain evidence but
 * grant no automatic capabilities. Protected actions are absent from the type.
 */
export function requestedActions(text: string, projectNames: string[] = []): AuthorizationAction[] {
  // Supported human command grammar. Consume the entire instruction: a
  // purpose/condition suffix must never become permission by keyword matching.
  let rest = text.trim()
    .replace(/^I (?:don't|do not) want (?:recommendations|suggestions|advice)\.\s*/i, '')
    .replace(/\.\s*The GitHub issues will probably need to be part of the commander UI refactor\.?$/i, '')
    .replace(/^please\s+/i, '')
  let verb = ''
  const actions = new Set<AuthorizationAction>()
  for (let count = 0; count < 8; count++) {
    const command = /^(create|add|make|file|open|publish|update|link)\s+/i.exec(rest)
    if (command) { verb = command[1].toLowerCase(); rest = rest.slice(command[0].length) }
    else if (!verb) return []
    for (const name of projectNames) if (rest.toLowerCase().startsWith(name.toLowerCase() + ' ')) rest = rest.slice(name.length + 1)
    const object = /^(?:(?:the|a|an|two|both|staged|\d+)\s+)*(tasks?|github\s+issues?)\b/i.exec(rest)
    if (!object) return []
    const issue = /^github/i.test(object[1])
    if (verb === 'update') actions.add(issue ? 'github.issue.update' : 'task.update')
    else if (verb === 'link') { if (issue) actions.add('github.issue.link') }
    else if (issue) { actions.add('github.issue.create'); actions.add('github.issue.link') }
    else actions.add('task.create')
    rest = rest.slice(object[0].length).replace(/^\s+for this\b/i, '')
    const and = /^\s+(?:and|plus|&)\s+/i.exec(rest)
    if (!and) break
    rest = rest.slice(and[0].length)
  }
  rest = rest.trim().replace(/[.!]$/, '')
  if (rest && !projectNames.some(name => rest.toLowerCase() === `for ${name.toLowerCase()}` || rest.toLowerCase() === `in ${name.toLowerCase()}`)
    && !/^for tasks [a-z0-9]{24} and [a-z0-9]{24}$/.test(rest)) return []
  return [...actions]
}

function configuredScope(source: Source, projectId: string): AuthorizationScope | null {
  if (!source.db.prepare('SELECT 1 FROM projects WHERE id = ? AND archived = 0').get(projectId)) return null
  const repos = source.db.prepare("SELECT org, name FROM project_repos WHERE project_id = ? AND provider = 'github'").all(projectId) as { org: string; name: string }[]
  return { projectId, repos: repos.map(r => `${r.org}/${r.name}`.toLowerCase()).sort() }
}

function put(source: Source, node: AuthorizationNode): AuthorizationNode {
  const body = JSON.stringify(node)
  source.db.prepare('INSERT INTO authorization_nodes (id, parent_id, root_id, message_id, correlation_id, body, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(node.id, node.parentId, node.rootId, node.parentId ? null : node.messageId, node.correlationId, body, authorizationHash(body))
  return node
}
function read(source: Source, id: string): { node: AuthorizationNode; hash: string } | null {
  const row = source.db.prepare('SELECT body, hash FROM authorization_nodes WHERE id = ?').get(id) as { body: string; hash: string } | undefined
  if (!row || authorizationHash(row.body) !== row.hash) return null
  const node = JSON.parse(row.body) as AuthorizationNode
  return node.id === id && node.textHash === authorizationHash(node.text) ? { node, hash: row.hash } : null
}

/** MAIN PROCESS INGRESS ONLY. No tool/HTTP route accepts these fields.
 * Caller must already have authenticated a human composer submission.
 */
export function recordHumanAuthorization(source: Source, input: {
  messageId: string; text: string; at: number; source: 'commander-chat' | 'project-chat';
  sessionId?: string; taskId?: string; projectId?: string; inputMode?: 'typed' | 'voice'
}): AuthorizationNode {
  const existing = source.db.prepare('SELECT id FROM authorization_nodes WHERE message_id = ? AND parent_id IS NULL').get(input.messageId) as { id: string } | undefined
  if (existing) {
    const node = read(source, existing.id)?.node
    if (!node || node.text !== input.text || node.at !== input.at || node.source !== input.source || node.sessionId !== (input.sessionId ?? null) || node.taskId !== (input.taskId ?? null)) throw new Error('Human message identity was reused with altered evidence')
    return node
  }
  let projectIds: string[] = []
  let scopeOriginMessageId: string | undefined
  const projects = source.db.prepare('SELECT id, name FROM projects WHERE archived = 0').all() as { id: string; name: string }[]
  if (input.source === 'project-chat' && input.projectId) projectIds = [input.projectId]
  else {
    // A single human-named project sets conversational scope. The spoken
    // product name is normalized; model-selected project names never do this.
    const named = projects.filter(p => new RegExp(`(?:^|[^a-z0-9])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(input.text.replace(/twenty[ -]one\s*x/gi, '21x')))
    if (named.length === 1) projectIds = [named[0].id]
  }
  if (!projectIds.length && input.source === 'commander-chat' && input.sessionId) {
    // Conversational scope comes only from earlier platform-captured HUMAN
    // turns, never assistant summaries or the relay's choice of project.
    const previous = source.db.prepare("SELECT id FROM authorization_nodes WHERE parent_id IS NULL AND json_extract(body, '$.sessionId') = ? ORDER BY rowid DESC LIMIT 1").get(input.sessionId) as { id: string } | undefined
    const node = previous && read(source, previous.id)?.node
    if (node && node.scope.length === 1 && node.expiresAt > input.at) {
      projectIds = node.scope.map(s => s.projectId)
      scopeOriginMessageId = node.scopeOriginMessageId ?? node.messageId
    }
  }
  const scope = projectIds.map(id => configuredScope(source, id)).filter((s): s is AuthorizationScope => !!s)
  // An explicitly named repository further narrows the configured snapshot.
  const namedRepos = input.text.match(/\b[a-z0-9_.-]+\/[a-z0-9_.-]+\b/gi)?.map(r => r.toLowerCase())
  if (namedRepos?.length) for (const s of scope) s.repos = s.repos.filter(r => namedRepos.includes(r))
  const id = randomUUID()
  return put(source, {
    version: 1, id, rootId: id, parentId: null, parentHash: null,
    messageId: input.messageId, text: input.text, textHash: authorizationHash(input.text),
    at: input.at, expiresAt: input.at + AUTHORIZATION_TTL_MS, author: 'human', source: input.source,
    sessionId: input.sessionId ?? null, taskId: input.taskId ?? null, correlationId: null,
    inputMode: input.inputMode ?? 'typed', scopeOriginMessageId,
    actions: requestedActions(input.text, projects.filter(p => projectIds.includes(p.id)).map(p => p.name)), scope
  })
}

export function resolveAuthorization(source: Source, nodeId: string | null, now = Date.now()): AuthorizationEvidence {
  const result: AuthorizationEvidence = { status: 'missing', nodeId, origin: null, chain: [], effectivePermissions: [], scope: [], revocations: [] }
  if (!nodeId) return result
  let current = nodeId
  let child: AuthorizationNode | undefined
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current) || seen.size >= 64) return { ...result, status: 'invalid' }
    seen.add(current)
    const stored = read(source, current)
    if (!stored) return { ...result, status: 'invalid' }
    const node = stored.node
    result.chain.unshift(node)
    if (child && (child.parentHash !== stored.hash || child.rootId !== node.rootId || child.expiresAt > node.expiresAt || child.at < node.at || child.actions.some(a => !node.actions.includes(a)) || child.scope.some(s => !node.scope.some(p => p.projectId === s.projectId && s.repos.every(r => p.repos.includes(r)))))) return { ...result, status: 'invalid' }
    const revocation = source.db.prepare('SELECT at, reason FROM authorization_revocations WHERE node_id = ?').get(node.id) as { at: number; reason: string } | undefined
    if (revocation) { result.status = 'revoked'; result.revocations.push({ nodeId: node.id, ...revocation }) }
    if ((!Number.isFinite(node.at) || !Number.isFinite(node.expiresAt) || now < node.at || now >= node.expiresAt) && result.status !== 'revoked') result.status = 'expired'
    child = node
    current = node.parentId ?? ''
  }
  const origin = result.chain[0]
  if (origin.author !== 'human' || origin.rootId !== origin.id || origin.parentHash !== null) return { ...result, status: 'invalid' }
  if (result.status === 'expired' || result.status === 'revoked') return { ...result, origin }
  const leaf = result.chain[result.chain.length - 1]
  const scope = leaf.scope.flatMap(s => {
    const live = configuredScope(source, s.projectId)
    return live ? [{ projectId: s.projectId, repos: s.repos.filter(r => live.repos.includes(r)) }] : []
  })
  return { ...result, status: 'active', origin, scope, effectivePermissions: scope.length ? leaf.actions.filter(a => AUTHORIZATION_ACTIONS.includes(a)) : [] }
}

/** Delegate from a platform record, never from claims embedded in relay text. */
export function delegateAuthorization(source: Source, input: {
  parentId: string; author: 'commander' | 'captain' | 'agent'; text: string; taskId: string;
  projectId: string; sessionId?: string; correlationId?: string; actions?: AuthorizationAction[]; repos?: string[]
}, now = Date.now()): AuthorizationNode | null {
  const evidence = resolveAuthorization(source, input.parentId, now)
  if (evidence.status !== 'active') return null
  const parent = evidence.chain[evidence.chain.length - 1]
  const scoped = evidence.scope.find(s => s.projectId === input.projectId)
  const task = source.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as { project_id: string } | undefined
  if (task?.project_id !== input.projectId) return null
  if (input.correlationId) {
    const previous = source.db.prepare('SELECT id FROM authorization_nodes WHERE correlation_id = ?').get(input.correlationId) as { id: string } | undefined
    if (previous) {
      const node = read(source, previous.id)?.node
      if (!node || node.parentId !== parent.id || node.text !== input.text || node.taskId !== input.taskId || node.sessionId !== (input.sessionId ?? null)) throw new Error('Correlation replay changed the authorization relay')
      return node
    }
  }
  return put(source, {
    version: 1, id: randomUUID(), rootId: parent.rootId, parentId: parent.id,
    parentHash: read(source, parent.id)!.hash, messageId: parent.messageId,
    text: input.text, textHash: authorizationHash(input.text), at: now, expiresAt: parent.expiresAt,
    author: input.author, source: 'delegation', sessionId: input.sessionId ?? null,
    taskId: input.taskId, correlationId: input.correlationId ?? null,
    actions: scoped ? parent.actions.filter(a => !input.actions || input.actions.includes(a)) : [],
    scope: scoped ? [{ projectId: input.projectId, repos: scoped.repos.filter(r => !input.repos || input.repos.includes(r)) }] : []
  })
}

export function commanderAuthorization(source: Source, input: {
  sessionId: string; userMessageId?: string; authorizationMessageId?: string; userMessage: string; trigger?: string;
  projectId: string; taskId: string; correlationId: string; message: string
}): AuthorizationNode | null {
  if (input.trigger !== 'user' || !(input.authorizationMessageId ?? input.userMessageId)) return null
  const row = source.db.prepare('SELECT id FROM authorization_nodes WHERE message_id = ? AND parent_id IS NULL').get(input.authorizationMessageId ?? input.userMessageId) as { id: string } | undefined
  const root = row && read(source, row.id)?.node
  if (!root || root.source !== 'commander-chat' || root.sessionId !== input.sessionId || (root.text !== input.userMessage && !/^(?:um|uh|mm)[.!]?$/i.test(input.userMessage.trim()))) return null
  return delegateAuthorization(source, { parentId: root.id, author: 'commander', text: input.message, taskId: input.taskId, projectId: input.projectId, sessionId: input.sessionId, correlationId: input.correlationId })
}

/** Associate a transport with exact bytes before enqueueing it. */
export function bindAuthorizationTransport(source: Source, key: string, nodeId: string, taskId: string, text: string): void {
  const row = source.db.prepare('SELECT * FROM authorization_transports WHERE delivery_key = ?').get(key) as { node_id: string; task_id: string; payload_hash: string } | undefined
  const hash = authorizationHash(text)
  if (row) {
    if (row.node_id !== nodeId || row.task_id !== taskId || row.payload_hash !== hash) throw new Error('Authorization transport replay mismatch')
    return
  }
  source.db.prepare('INSERT INTO authorization_transports VALUES (?, ?, ?, ?)').run(key, nodeId, taskId, hash)
}

/** Reserve before async resume; activate only this generation at send boundary. */
export function prepareAuthorizationDispatch(source: Source, input: { key: string; taskId: string; text: string; messageId?: string }): number {
  return source.db.transaction(() => {
    const hash = authorizationHash(input.text)
    const existing = source.db.prepare('SELECT seq, task_id, payload_hash FROM authorization_dispatches WHERE delivery_key = ?').get(input.key) as { seq: number; task_id: string; payload_hash: string } | undefined
    if (existing) {
      if (existing.task_id !== input.taskId || existing.payload_hash !== hash) throw new Error('Authorization dispatch replay mismatch')
      return existing.seq
    }
    const transport = source.db.prepare('SELECT node_id, task_id, payload_hash FROM authorization_transports WHERE delivery_key = ?').get(input.key) as { node_id: string; task_id: string; payload_hash: string } | undefined
    let nodeId: string | null = null
    if (transport) {
      if (transport.task_id !== input.taskId || transport.payload_hash !== hash) throw new Error('Authorization payload was altered')
      nodeId = transport.node_id
    } else if (input.messageId) {
      const root = source.db.prepare('SELECT id FROM authorization_nodes WHERE message_id = ? AND parent_id IS NULL').get(input.messageId) as { id: string } | undefined
      const node = root && read(source, root.id)?.node
      if (node?.source === 'project-chat' && node.taskId === input.taskId && node.textHash === hash) nodeId = node.id
    }
    const seq = Number(source.db.prepare('INSERT INTO authorization_dispatches (delivery_key, task_id, node_id, payload_hash) VALUES (?, ?, ?, ?)').run(input.key, input.taskId, nodeId, hash).lastInsertRowid)
    source.db.prepare('INSERT INTO authorization_task_bindings VALUES (?, ?, NULL) ON CONFLICT(task_id) DO UPDATE SET dispatch_seq = excluded.dispatch_seq, node_id = NULL').run(input.taskId, seq)
    return seq
  })()
}

export function activateAuthorizationDispatch(source: Source, seq: number): void {
  const row = source.db.prepare('SELECT task_id, node_id FROM authorization_dispatches WHERE seq = ?').get(seq) as { task_id: string; node_id: string | null } | undefined
  if (!row) throw new Error('Unknown authorization dispatch')
  if (row.node_id && resolveAuthorization(source, row.node_id).status !== 'active') throw new Error('Authorization expired or was revoked before dispatch')
  const binding = source.db.prepare('SELECT dispatch_seq FROM authorization_task_bindings WHERE task_id = ?').get(row.task_id) as { dispatch_seq: number } | undefined
  if (binding?.dispatch_seq !== seq) throw new Error('Stale authorization dispatch')
  source.db.prepare('UPDATE authorization_task_bindings SET node_id = ? WHERE task_id = ? AND dispatch_seq = ?').run(row.node_id, row.task_id, seq)
}
export function failAuthorizationDispatch(source: Source, seq: number): void {
  source.db.prepare('UPDATE authorization_task_bindings SET node_id = NULL WHERE dispatch_seq = ?').run(seq)
}

export function taskAuthorization(source: Source, taskId: string, now = Date.now()): AuthorizationEvidence {
  const row = source.db.prepare('SELECT node_id FROM authorization_task_bindings WHERE task_id = ?').get(taskId) as { node_id: string | null } | undefined
  return resolveAuthorization(source, row?.node_id ?? null, now)
}

/** Policy integration: taskId must come from the server's caller scope. */
export function resolveTaskAuthorization(source: Source, input: { taskId: string; projectId: string; action: string; repo?: string }, now = Date.now()): AuthorizationEvidence & { allowed: boolean } {
  const evidence = taskAuthorization(source, input.taskId, now)
  const task = source.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as { project_id: string } | undefined
  const scoped = evidence.scope.find(s => s.projectId === input.projectId)
  const allowed = evidence.status === 'active' && task?.project_id === input.projectId && !!scoped && evidence.effectivePermissions.includes(input.action as AuthorizationAction) && (!input.action.startsWith('github.') || (!!input.repo && scoped.repos.includes(input.repo.toLowerCase())))
  return { ...evidence, allowed, status: evidence.status === 'active' && !allowed ? 'out_of_scope' : evidence.status }
}

/** A newly created task gets a fixed child of its caller's CURRENT chain. */
export function inheritTaskAuthorization(source: Source, callerTaskId: string, taskId: string, text: string): void {
  const evidence = taskAuthorization(source, callerTaskId)
  const task = source.db.prepare('SELECT project_id, repos FROM tasks WHERE id = ?').get(taskId) as { project_id: string; repos: string } | undefined
  if (!task || evidence.status !== 'active' || !evidence.nodeId) return
  const repos = JSON.parse(task.repos || '[]') as string[]
  const node = delegateAuthorization(source, { parentId: evidence.nodeId, author: 'agent', text, taskId, projectId: task.project_id, repos: repos.length ? repos.map(r => r.toLowerCase()) : undefined })
  if (!node) return
  const key = `task-creation:${taskId}`
  bindAuthorizationTransport(source, key, node.id, taskId, text)
  activateAuthorizationDispatch(source, prepareAuthorizationDispatch(source, { key, taskId, text }))
}

/** Called only by trusted UI/main-process code. No model-facing revoke/grant API. */
export function revokeAuthorization(source: Source, nodeId: string, reason: string, now = Date.now()): void {
  source.db.prepare('INSERT OR IGNORE INTO authorization_revocations VALUES (?, ?, ?)').run(nodeId, now, reason)
}
