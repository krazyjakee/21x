import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

export const AUTHORIZATION_TTL_MS = 24 * 60 * 60_000
export const AUTHORIZATION_CLASSIFIER_VERSION = 3
/**
 * Stored intents resolve under the classifier that produced them. Version 3
 * reads an assigned outcome as its own ordinary lifecycle; version 2 required
 * the user to recite the procedure. Version 2 records stay valid and are never
 * reclassified — they are strictly narrower, so honouring them cannot widen
 * anyone's authority.
 */
export const SUPPORTED_CLASSIFIER_VERSIONS: readonly number[] = [2, 3]
export const AUTHORIZATION_ACTIONS = [
  'task.create',
  'task.update',
  'task.start',
  'github.pr.open',
  'github.issue.create',
  'github.issue.update',
  'github.issue.link'
] as const
export type AuthorizationAction = typeof AUTHORIZATION_ACTIONS[number]
type Source = { db: Database.Database }
export type AuthorizationScope = { projectId: string; repos: string[] }
export interface CapabilityIntent {
  capability: AuthorizationAction
  basis: 'explicit' | 'necessary'
  classifierVersion: number
  sourceMessageId: string
  clauseHash: string
  sourceRange: { start: number; end: number }
  scope: AuthorizationScope[]
  createdAt: number
  expiresAt: number
}
export interface AuthorizationNode {
  version: 1 | 2
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
  /** Version 2 origins persist classified intent. Descendants narrow `actions`. */
  intents?: CapabilityIntent[]
  /**
   * Capabilities this message explicitly prohibited. Kept separately from
   * `actions` because a prohibition outlives the message that carried it: a
   * later instruction can only narrow what an earlier one authorized.
   */
  deniedActions?: AuthorizationAction[]
}
export interface AuthorizationEvidence {
  status: 'active' | 'missing' | 'invalid' | 'expired' | 'revoked' | 'out_of_scope'
  nodeId: string | null
  origin: AuthorizationNode | null
  chain: AuthorizationNode[]
  effectivePermissions: AuthorizationAction[]
  effectiveIntents: CapabilityIntent[]
  scope: AuthorizationScope[]
  revocations: Array<{ nodeId: string; at: number; reason: string }>
}
export type AuthorizationFailureDimension = 'chain' | 'task' | 'project' | 'capability' | 'repository' | null
export interface AuthorizationDecision extends AuthorizationEvidence {
  allowed: boolean
  requestedCapability: string
  missingCapability: string | null
  originNodeId: string | null
  originMessageId: string | null
  failureDimension: AuthorizationFailureDimension
  safeRemediation: string | null
}

/** Stable diagnostics shared by task, issue and PR execution boundaries. */
export function authorizationRefusal(decision: AuthorizationDecision): Record<string, unknown> {
  return {
    error: decision.safeRemediation ?? `Authorization refused ${decision.requestedCapability}.`,
    code: 'capability_refused',
    authorization_status: decision.status,
    requested_capability: decision.requestedCapability,
    missing_capability: decision.missingCapability,
    origin_node_id: decision.originNodeId,
    origin_message_id: decision.originMessageId,
    effective_capabilities: decision.effectivePermissions,
    failure_dimension: decision.failureDimension,
    safe_remediation: decision.safeRemediation
  }
}
export const authorizationHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

type ClassifiedIntent = Pick<CapabilityIntent, 'capability' | 'basis' | 'clauseHash' | 'sourceRange'>

/**
 * Language that withholds, postpones or hypothesizes the work. A clause
 * carrying any of it authorizes nothing, whatever imperative it is wrapped
 * around ("Implement nothing until I give consent", "Build only a written
 * proposal"). Protected actions are deliberately absent: merge, deploy,
 * deletion and credential elevation are not in the ordinary capability
 * vocabulary at all, so naming one cannot mint it — and naming one no longer
 * voids the ordinary work the same instruction does authorize.
 */
const WITHHOLDING = /\b(?:nothing|only|solely|merely|purely|consent|go[ -]?ahead|withholds?|withholding|awaits?|awaiting|illustrat\w+|sample|demonstrat\w+|proposals?|paper\s+exercise|not\s+yet|do\s+not|don't|dont|shouldn't|shouldnt|without|refrain|never|ask\s+(?:me|the\s+user)\s+(?:first|before)|(?:my|user|human)\s+approval|approve[sd]?)\b/i
const INTERROGATIVE = /^(?:why|how|what|which|who|where|can|could|would|will|may|should|do|does|did|is|are|was|were)\b/i
const UNSAFE_CONTEXT_PREFIX = /^(?:(?:only\s+)?if\b|unless\b|when\b|once\b|pending\b|subject\s+to\b|example(?:\s+instructions?)?\b|hypothetical\b|mock\b|wait\s+for\b)/i
const AMBIGUOUS_CONTEXT = /\b(?:if|unless|provided|assuming|once|when|after|before|pending|subject\s+to|mock|dry[ -]?run|simulate|hypothetical|example|approval|confirmation)\b/i
/**
 * Content the user is reporting rather than saying. Attributed speech and
 * key=value claim syntax are how injected text tries to speak with the user's
 * voice, so a clause carrying either authorizes nothing.
 */
const ATTRIBUTED = /^[^.]{0,60}\b(?:says?|said|claims?|claimed|states?|stated|writes?|wrote|reports?\s+that|told\s+\S+)\s/i
const MACHINE_CLAIM = /\b[a-z_][a-z0-9_]*\s*=\s*(?:true|false|\d|[a-z])/i
/**
 * A prohibition on an action the ordinary registry does not contain. It
 * restricts nothing here because nothing here could have granted it, and it
 * must not void the work the same message does assign: "…; do not merge" is a
 * reassurance, not a retraction.
 */
const PROTECTED_PROHIBITION = /[,;]?\s*(?:but\s+|and\s+|then\s+|though\s+|however,?\s+)?(?:please\s+)?(?:do\s+not|don't|dont|never)\s+(?:merge|squash|rebase|deploy|promote|rollback|delete|destroy|purge|force[ -]?push|bypass|approve)\b.*$/i

/**
 * Removes a protected prohibition so the instruction beside it survives.
 * Returns the remaining words, or an empty string when the clause was nothing
 * but the prohibition. The audit record keeps the user's whole clause either
 * way: this trims what is parsed, never what is stored.
 */
function withoutProtectedProhibition(clause: string): string {
  return clause.replace(PROTECTED_PROHIBITION, '').trim()
}
const AUTHORIZATION_DENIAL = /^(?:please\s+)?(?:do\s+not|don't|dont|never|refrain\s+from)\s+(?:create|add|make|file|open|opening|publish|update|link|start|starting)\b/i

/**
 * Non-authorizing clauses allowed beside an explicit command. Everything else
 * makes the complete message ambiguous and therefore non-authorizing. This is
 * a positive grammar: unknown headings/restrictions never disappear merely
 * because a later clause happens to look imperative.
 */
function safeAuthorizationContext(clause: string): boolean {
  return /^\d+\s+(?:pull\s+requests?|prs?)\s+(?:are\s+)?(?:still\s+)?open$/i.test(clause) ||
    /^why\s+have\s+we\s+stalled$/i.test(clause) ||
    /^come\s+up\s+with\s+(?:a\s+)?technical\s+solution\s+for\s+[a-z0-9][a-z0-9_.-]{0,80}\s+that\s+will\s+prevent\s+this\s+stalling\s+in\s+future$/i.test(clause) ||
    /^i\s+(?:do\s+not|don't|dont)\s+want\s+recommendations?$/i.test(clause) ||
    /^(?:the\s+)?(?:github|gh)\s+issues?\s+(?:will|would|should|may|might)\s+(?:probably\s+)?need\s+to\s+be\s+part\s+of\s+(?:the\s+)?(?:commander\s+ui\s+refactor|current\s+project|project\s+work)$/i.test(clause)
}

function deniedCapabilities(clause: string): Set<AuthorizationAction> | null {
  const match = /^(?:please\s+)?(?:do\s+not|don't|dont|never|refrain\s+from)\s+(create|add|make|file|open|opening|publish|update|link|start|starting)\s+(?:(?:the|a|an|any|all|draft)\s+)*(tasks?|(?:github|gh)\s+issues?|(?:(?:github|gh)\s+)?(?:prs?|pull\s+requests?))(?:\s+(?:yet|now))?$/i.exec(clause)
  if (!match) return null
  const denied = new Set<AuthorizationAction>()
  const verb = match[1].replace(/ing$/, '').toLowerCase()
  const target = match[2].toLowerCase()
  if (/\b(?:pr|pull\s+request)/.test(target)) denied.add('github.pr.open')
  else if (/\bissues?\b/.test(target)) {
    if (verb === 'update') denied.add('github.issue.update')
    else if (verb === 'link') denied.add('github.issue.link')
    else {
      denied.add('github.issue.create')
      denied.add('github.issue.link')
    }
  } else if (verb === 'update') denied.add('task.update')
  else if (verb === 'start') denied.add('task.start')
  else denied.add('task.create')
  return denied
}

type AuthorizationClause = { text: string; start: number; end: number; separator: string }

function clauses(text: string): AuthorizationClause[] {
  const result: AuthorizationClause[] = []
  let start = 0
  const boundary = /[.!?;\n]+/g
  for (;;) {
    const match = boundary.exec(text)
    const end = match?.index ?? text.length
    const raw = text.slice(start, end)
    const left = raw.search(/\S/)
    if (left >= 0) {
      const right = raw.length - raw.trimEnd().length
      result.push({ text: raw.trim(), start: start + left, end: end - right, separator: match?.[0] ?? '' })
    }
    if (!match) break
    start = boundary.lastIndex
  }
  return result
}

function addClassified(
  found: Map<AuthorizationAction, ClassifiedIntent>,
  capability: AuthorizationAction,
  basis: 'explicit' | 'necessary',
  clause: AuthorizationClause
): void {
  const existing = found.get(capability)
  if (existing?.basis === 'explicit' || (existing && basis === 'necessary')) return
  found.set(capability, {
    capability,
    basis,
    clauseHash: authorizationHash(clause.text),
    sourceRange: { start: clause.start, end: clause.end }
  })
}

/**
 * Bounded, clause-aware trusted-ingress classifier. It is deliberately not a
 * general natural-language permission model: unsafe, conditional, quoted and
 * interrogative clauses grant nothing, and protected actions are not in the
 * ordinary capability vocabulary at all.
 */
export function classifyCapabilityIntents(text: string, projectNames: string[] = []): ClassifiedIntent[] {
  const found = new Map<AuthorizationAction, ClassifiedIntent>()
  const denied = new Set<AuthorizationAction>()
  const parsedClauses = clauses(text)
  // A conditional/example heading can govern every following imperative, and
  // a trailing condition can qualify commands that came before it. This small
  // grammar cannot safely determine that scope, so the message grants nothing.
  const ambiguousContext = parsedClauses.some((clause) => UNSAFE_CONTEXT_PREFIX.test(clause.text)) || AMBIGUOUS_CONTEXT.test(text)
  if (ambiguousContext) return []
  for (const clause of parsedClauses) {
    if (safeAuthorizationContext(clause.text)) continue
    if (clause.separator.includes('?')) return []

    // "…, but do not merge it" restricts nothing the ordinary registry holds,
    // so it neither grants nor retracts. It must not cost the user the work
    // they assigned in the same breath.
    const body = withoutProtectedProhibition(clause.text)
    if (!body) continue

    if (AUTHORIZATION_DENIAL.test(body)) {
      const parsed = deniedCapabilities(body)
      if (!parsed) return []
      for (const capability of parsed) denied.add(capability)
      continue
    }

    if (body.length > 1_000 || WITHHOLDING.test(body) || ATTRIBUTED.test(body)
      || MACHINE_CLAIM.test(body) || /["“”`:]/.test(body)) return []

    // A question asks; it does not assign. It grants nothing on its own, and
    // no longer costs the instruction standing beside it.
    if (INTERROGATIVE.test(body)) continue

    const command = /^(?:please\s+)?(create|add|make|file|open|publish|update|link|start|prioriti[sz]e)\s+(.+)$/i.exec(body)
    if (!command) {
      // Any other instruction the user typed. It carries the ordinary
      // lifecycle the work needs — there is no vocabulary of verbs or nouns
      // to guess, because guessing is what sent them back to restate it.
      // Issue publishing stays on the explicit grammar below: it writes a
      // public artifact to GitHub, which a passing remark should not do.
      addClassified(found, 'task.create', 'necessary', clause)
      addClassified(found, 'task.update', 'necessary', clause)
      addClassified(found, 'task.start', 'necessary', clause)
      addClassified(found, 'github.pr.open', 'necessary', clause)
      continue
    }
    let verbs = [command[1].toLowerCase()]
    let rest = command[2].trim()
    for (const name of projectNames) {
      if (rest.toLowerCase().startsWith(name.toLowerCase() + ' ')) rest = rest.slice(name.length).trimStart()
    }

    const explicit = new Set<AuthorizationAction>()
    for (let count = 0; count < 8; count++) {
      const repeatedVerb = /^(create|add|make|file|open|publish|update|link|start|prioriti[sz]e)\s+/i.exec(rest)
      if (repeatedVerb) {
        verbs = [repeatedVerb[1].toLowerCase()]
        rest = rest.slice(repeatedVerb[0].length)
      }
      // "Create and start a task": one object, several lifecycle verbs. Every
      // one of them must be a recognized production for that object.
      for (let extra = 0; extra < 4; extra++) {
        const alsoVerb = /^(?:and|,\s*and|,|plus|&)\s+(create|add|make|file|open|publish|update|link|start|prioriti[sz]e)\s+/i.exec(rest)
        if (!alsoVerb) break
        verbs.push(alsoVerb[1].toLowerCase())
        rest = rest.slice(alsoVerb[0].length)
      }
      const numericDeterminer = /^(\d+)\s+/.exec(rest)
      if (numericDeterminer && Number(numericDeterminer[1]) === 0) return []
      // A named project may sit between the determiner and the object
      // ("a 21x task"); it names scope, not a different object.
      const determiners = /^(?:(?:the|a|an|one|two|both|staged|draft|\d+)\s+)*/i.exec(rest)?.[0] ?? ''
      for (const name of projectNames) {
        const after = rest.slice(determiners.length)
        if (after.toLowerCase().startsWith(name.toLowerCase() + ' ')) {
          rest = determiners + after.slice(name.length).trimStart()
          break
        }
      }
      const object = /^(?:(?:the|a|an|one|two|both|staged|draft|\d+)\s+)*(tasks?|(?:github|gh)\s+issues?|prs?|pull\s+requests?)\b/i.exec(rest)
      if (!object) return []
      const target = object[1].toLowerCase()
      const issue = /^(?:github|gh)/.test(target)
      const pr = /^(?:pr|pull)/.test(target)
      for (const verb of verbs) {
        let accepted = false
        if (pr) {
          if (verb === 'open' || verb === 'create' || verb === 'publish') {
            explicit.add('github.pr.open')
            accepted = true
          }
        } else if (issue) {
          if (verb === 'update') { explicit.add('github.issue.update'); accepted = true }
          else if (verb === 'link') { explicit.add('github.issue.link'); accepted = true }
          else if (['create', 'add', 'make', 'file', 'open', 'publish'].includes(verb)) {
            explicit.add('github.issue.create')
            accepted = true
          }
        } else {
          if (verb === 'update' || verb.startsWith('prioriti')) { explicit.add('task.update'); accepted = true }
          else if (verb === 'start') { explicit.add('task.start'); accepted = true }
          else if (['create', 'add', 'make', 'file', 'open', 'publish'].includes(verb)) {
            explicit.add('task.create')
            accepted = true
          }
        }
        if (!accepted) return []
      }
      rest = rest.slice(object[0].length).trimStart().replace(/^for\s+(?:this|it)\b/i, '').trimStart()
      const conjunction = /^(?:and|plus|&)\s+/i.exec(rest)
      if (!conjunction) break
      rest = rest.slice(conjunction[0].length)
      // "and prioritise them" is an explicit lifecycle update, not another object.
      const prioritize = /^prioriti[sz]e\s+(?:them|the\s+tasks?)\b/i.exec(rest)
      if (prioritize) {
        explicit.add('task.update')
        rest = rest.slice(prioritize[0].length).trimStart()
        break
      }
    }

    // A descriptive tail ("... to fix the login bug") is ordinary English, not
    // a second instruction: anything that would qualify, postpone or negate
    // the command was already rejected by the screens above.
    const tail = rest.replace(/[.!]$/, '').trim()
    if (explicit.size === 0 || tail.split(/\s+/).filter(Boolean).length > 30) return []

    for (const capability of explicit) addClassified(found, capability, 'explicit', clause)
    if (explicit.has('github.issue.create')) addClassified(found, 'github.issue.link', 'necessary', clause)
    if (explicit.has('task.create')) {
      addClassified(found, 'task.update', explicit.has('task.update') ? 'explicit' : 'necessary', clause)
      addClassified(found, 'task.start', 'necessary', clause)
    }
  }
  for (const capability of denied) found.delete(capability)
  return AUTHORIZATION_ACTIONS.flatMap((capability) => found.has(capability) ? [found.get(capability)!] : [])
}

/** Compatibility view for existing callers and version-1 records. */
export function requestedActions(text: string, projectNames: string[] = []): AuthorizationAction[] {
  return classifyCapabilityIntents(text, projectNames).map((intent) => intent.capability)
}

/**
 * What this message forbade, independent of what it authorized.
 *
 * Read on its own pass because an ambiguous message still grants nothing but
 * may still prohibit: "Do not open PRs" authorizes no work and must survive as
 * a restriction on the instruction it follows.
 */
export function classifyDeniedCapabilities(text: string): AuthorizationAction[] {
  const denied = new Set<AuthorizationAction>()
  for (const clause of clauses(text)) {
    const body = withoutProtectedProhibition(clause.text)
    if (!body || !AUTHORIZATION_DENIAL.test(body)) continue
    for (const capability of deniedCapabilities(body) ?? []) denied.add(capability)
  }
  return AUTHORIZATION_ACTIONS.filter((action) => denied.has(action))
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
  try {
    const node = JSON.parse(row.body) as AuthorizationNode
    if ((node.version !== 1 && node.version !== 2) || node.id !== id || node.textHash !== authorizationHash(node.text)) return null
    if (!Array.isArray(node.actions) || node.actions.some((action) => !AUTHORIZATION_ACTIONS.includes(action))) return null
    if (node.deniedActions && (!Array.isArray(node.deniedActions) || node.deniedActions.some((action) => !AUTHORIZATION_ACTIONS.includes(action)))) return null
    return { node, hash: row.hash }
  } catch {
    return null
  }
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
  let inheritedScope: AuthorizationScope[] | undefined
  let allowContext = true
  const projects = source.db.prepare('SELECT id, name FROM projects WHERE archived = 0').all() as { id: string; name: string }[]
  if (input.source === 'project-chat' && input.projectId) projectIds = [input.projectId]
  else {
    // A single human-named project sets conversational scope. The spoken
    // product name is normalized; model-selected project names never do this.
    const named = projects.filter(p => new RegExp(`(?:^|[^a-z0-9])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(input.text.replace(/twenty[ -]one\s*x/gi, '21x')))
    if (named.length === 1) projectIds = [named[0].id]
    else if (named.length > 1) allowContext = false
  }
  if (allowContext && !projectIds.length && input.source === 'commander-chat' && input.sessionId) {
    // Conversational scope comes only from earlier platform-captured HUMAN
    // turns, never assistant summaries or the relay's choice of project.
    const previous = source.db.prepare("SELECT id FROM authorization_nodes WHERE parent_id IS NULL AND json_extract(body, '$.sessionId') = ? ORDER BY rowid DESC LIMIT 1").get(input.sessionId) as { id: string } | undefined
    const node = previous && read(source, previous.id)?.node
    if (node && node.scope.length === 1 && node.expiresAt > input.at) {
      projectIds = node.scope.map(s => s.projectId)
      inheritedScope = node.scope
      scopeOriginMessageId = node.scopeOriginMessageId ?? node.messageId
    }
  }
  const scope = projectIds.map(id => configuredScope(source, id)).filter((s): s is AuthorizationScope => !!s)
  if (inheritedScope) for (const s of scope) {
    const inherited = inheritedScope.find(p => p.projectId === s.projectId)
    s.repos = s.repos.filter(repo => inherited?.repos.includes(repo))
  }
  // An explicitly named repository further narrows the configured snapshot.
  const namedRepos = input.text.match(/\b[a-z0-9_.-]+\/[a-z0-9_.-]+\b/gi)?.map(r => r.toLowerCase())
  if (namedRepos?.length) for (const s of scope) s.repos = s.repos.filter(r => namedRepos.includes(r))
  const expiresAt = input.at + AUTHORIZATION_TTL_MS
  const classified = classifyCapabilityIntents(input.text, projects.filter(p => projectIds.includes(p.id)).map(p => p.name))
  const intents: CapabilityIntent[] = classified.map((intent) => ({
    ...intent,
    classifierVersion: AUTHORIZATION_CLASSIFIER_VERSION,
    sourceMessageId: input.messageId,
    scope: scope.map((item) => ({ projectId: item.projectId, repos: [...item.repos] })),
    createdAt: input.at,
    expiresAt
  }))
  const id = randomUUID()
  return put(source, {
    version: 2, id, rootId: id, parentId: null, parentHash: null,
    messageId: input.messageId, text: input.text, textHash: authorizationHash(input.text),
    at: input.at, expiresAt, author: 'human', source: input.source,
    sessionId: input.sessionId ?? null, taskId: input.taskId ?? null, correlationId: null,
    inputMode: input.inputMode ?? 'typed', scopeOriginMessageId,
    actions: intents.map((intent) => intent.capability), scope, intents,
    deniedActions: classifyDeniedCapabilities(input.text)
  })
}

export function resolveAuthorization(source: Source, nodeId: string | null, now = Date.now()): AuthorizationEvidence {
  const result: AuthorizationEvidence = { status: 'missing', nodeId, origin: null, chain: [], effectivePermissions: [], effectiveIntents: [], scope: [], revocations: [] }
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
  if (origin.version === 2) {
    const intents = origin.intents
    const actions = intents?.map((intent) => intent.capability)
    if (!intents || JSON.stringify(actions) !== JSON.stringify(origin.actions) || intents.some((intent) => {
      const clause = origin.text.slice(intent.sourceRange.start, intent.sourceRange.end)
      return !SUPPORTED_CLASSIFIER_VERSIONS.includes(intent.classifierVersion) ||
        intent.classifierVersion !== intents[0].classifierVersion ||
        intent.sourceMessageId !== origin.messageId ||
        intent.createdAt !== origin.at ||
        intent.expiresAt !== origin.expiresAt ||
        !Number.isInteger(intent.sourceRange.start) || !Number.isInteger(intent.sourceRange.end) ||
        intent.sourceRange.start < 0 || intent.sourceRange.end <= intent.sourceRange.start ||
        intent.sourceRange.end > origin.text.length ||
        intent.clauseHash !== authorizationHash(clause) ||
        JSON.stringify(intent.scope) !== JSON.stringify(origin.scope)
    })) return { ...result, status: 'invalid' }
  }
  if (result.status === 'expired' || result.status === 'revoked') return { ...result, origin }
  const leaf = result.chain[result.chain.length - 1]
  const scope = leaf.scope.flatMap(s => {
    const live = configuredScope(source, s.projectId)
    return live ? [{ projectId: s.projectId, repos: s.repos.filter(r => live.repos.includes(r)) }] : []
  })
  const effectivePermissions = scope.length ? leaf.actions.filter(a => AUTHORIZATION_ACTIONS.includes(a)) : []
  const effectiveIntents = origin.version === 2
    ? (origin.intents ?? []).filter((intent) => effectivePermissions.includes(intent.capability))
    : []
  return { ...result, status: 'active', origin, scope, effectivePermissions, effectiveIntents }
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
    version: parent.version, id: randomUUID(), rootId: parent.rootId, parentId: parent.id,
    parentHash: read(source, parent.id)!.hash, messageId: parent.messageId,
    text: input.text, textHash: authorizationHash(input.text), at: now, expiresAt: parent.expiresAt,
    author: input.author, source: 'delegation', sessionId: input.sessionId ?? null,
    taskId: input.taskId, correlationId: input.correlationId ?? null,
    actions: scoped ? parent.actions.filter(a => !input.actions || input.actions.includes(a)) : [],
    scope: scoped ? [{ projectId: input.projectId, repos: scoped.repos.filter(r => !input.repos || input.repos.includes(r)) }] : []
  })
}

/**
 * What the user currently has the Commander doing in this session.
 *
 * The newest of their instructions that still carries capability and is still
 * active, minus anything they have prohibited since. Walking newest-first is
 * what makes a later prohibition bind an earlier instruction: the relay may
 * narrow across time, never widen.
 *
 * This reads only platform-captured human roots. A relay's own prose, a report
 * and an assistant summary are all invisible to it.
 */
export function commanderSessionAuthority(source: Source, sessionId: string, now = Date.now()): { root: AuthorizationNode; actions: AuthorizationAction[] } | null {
  const rows = source.db.prepare(`SELECT id FROM authorization_nodes
    WHERE parent_id IS NULL AND json_extract(body, '$.sessionId') = ?
    ORDER BY rowid DESC LIMIT 32`).all(sessionId) as { id: string }[]
  const denied = new Set<AuthorizationAction>()
  for (const row of rows) {
    const node = read(source, row.id)?.node
    if (!node || node.source !== 'commander-chat' || node.sessionId !== sessionId) continue
    for (const action of node.deniedActions ?? []) denied.add(action)
    if (!node.actions.length) continue
    if (resolveAuthorization(source, node.id, now).status !== 'active') continue
    const actions = node.actions.filter((action) => !denied.has(action))
    return actions.length ? { root: node, actions } : null
  }
  return null
}

/**
 * The authority a Commander relay carries to a Captain.
 *
 * A turn the user started relays under that turn's own message. A turn a
 * Captain report started is the Commander still carrying out what the user
 * last asked for, so it relays under that instruction rather than under
 * nothing — otherwise every follow-up would arrive unauthorized and the user
 * would have to retype a request they already made. The relay text remains an
 * interpretation either way: it cannot widen the instruction, and the number
 * of times a report may drive delegation without the user speaking is already
 * capped by the session's report-ask budget.
 */
export function commanderAuthorization(source: Source, input: {
  sessionId: string; userMessageId?: string; authorizationMessageId?: string; userMessage: string; trigger?: string;
  projectId: string; taskId: string; correlationId: string; message: string
}): AuthorizationNode | null {
  const relay = {
    author: 'commander' as const, text: input.message, taskId: input.taskId,
    projectId: input.projectId, sessionId: input.sessionId, correlationId: input.correlationId
  }
  if (input.trigger !== 'user') {
    const current = commanderSessionAuthority(source, input.sessionId)
    return current ? delegateAuthorization(source, { parentId: current.root.id, ...relay, actions: current.actions }) : null
  }
  if (!(input.authorizationMessageId ?? input.userMessageId)) return null
  const row = source.db.prepare('SELECT id FROM authorization_nodes WHERE message_id = ? AND parent_id IS NULL').get(input.authorizationMessageId ?? input.userMessageId) as { id: string } | undefined
  const root = row && read(source, row.id)?.node
  if (!root || root.source !== 'commander-chat' || root.sessionId !== input.sessionId || (root.text !== input.userMessage && !/^(?:um|uh|mm)[.!]?$/i.test(input.userMessage.trim()))) return null
  return delegateAuthorization(source, { parentId: root.id, ...relay })
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
    source.db.prepare(`
      INSERT INTO authorization_task_bindings (task_id, dispatch_seq, node_id, assignment_node_id, supersession_node_id)
      VALUES (?, ?, NULL, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        dispatch_seq = excluded.dispatch_seq,
        node_id = NULL
    `).run(input.taskId, seq)
    return seq
  })()
}

/**
 * Re-reserve one exact durable dispatch after a failed adapter handoff.
 *
 * Generic replays stay stale: only the delivery retry path calls this after
 * reclaiming the same outbox row. Re-reservation installs no authority until
 * activateAuthorizationDispatch rechecks expiry and revocation at the adapter
 * boundary.
 */
export function prepareAuthorizationRetry(source: Source, input: { key: string; taskId: string; text: string; messageId?: string }): number {
  return source.db.transaction(() => {
    const seq = prepareAuthorizationDispatch(source, input)
    source.db.prepare(`
      INSERT INTO authorization_task_bindings (task_id, dispatch_seq, node_id, supersession_node_id)
      VALUES (?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        dispatch_seq = excluded.dispatch_seq,
        node_id = NULL
    `).run(input.taskId, seq)
    return seq
  })()
}

export function activateAuthorizationDispatch(source: Source, seq: number): void {
  const row = source.db.prepare('SELECT task_id, node_id FROM authorization_dispatches WHERE seq = ?').get(seq) as { task_id: string; node_id: string | null } | undefined
  if (!row) throw new Error('Unknown authorization dispatch')
  if (row.node_id && resolveAuthorization(source, row.node_id).status !== 'active') throw new Error('Authorization expired or was revoked before dispatch')
  const binding = source.db.prepare('SELECT dispatch_seq FROM authorization_task_bindings WHERE task_id = ?').get(row.task_id) as { dispatch_seq: number } | undefined
  if (binding?.dispatch_seq !== seq) throw new Error('Stale authorization dispatch')
  if (row.node_id) {
    source.db.prepare(`
      UPDATE authorization_task_bindings SET
        node_id = ?,
        supersession_node_id = CASE
          WHEN assignment_node_id IS NOT NULL AND ? IS NOT assignment_node_id THEN ?
          ELSE supersession_node_id
        END
      WHERE task_id = ? AND dispatch_seq = ?
    `).run(row.node_id, row.node_id, row.node_id, row.task_id, seq)
  }
}
export function failAuthorizationDispatch(source: Source, seq: number): void {
  // Clearing an active/pending delivery never clears the last accepted human
  // supersession. Recovery may become inactive, but cannot widen to assignment.
  source.db.prepare('UPDATE authorization_task_bindings SET node_id = NULL WHERE dispatch_seq = ?').run(seq)
}

export function taskAuthorization(source: Source, taskId: string, now = Date.now()): AuthorizationEvidence {
  const row = source.db.prepare(`
    SELECT b.node_id, b.assignment_node_id, b.supersession_node_id, d.node_id AS pending_node_id
    FROM authorization_task_bindings b
    JOIN authorization_dispatches d ON d.seq = b.dispatch_seq
    WHERE b.task_id = ?
  `).get(taskId) as { node_id: string | null; assignment_node_id: string | null; supersession_node_id: string | null; pending_node_id: string | null } | undefined
  // An evidence-bearing turn stays inactive until the adapter accepts this
  // exact generation. Machine generations keep the latest accepted human node.
  if (row?.pending_node_id && row.node_id !== row.pending_node_id) return resolveAuthorization(source, null, now)
  return resolveAuthorization(source, row?.node_id ?? row?.supersession_node_id ?? row?.assignment_node_id ?? null, now)
}

/** Policy integration: taskId must come from the server's caller scope. */
export function resolveTaskAuthorization(source: Source, input: { taskId: string; projectId: string; action: string; repo?: string }, now = Date.now()): AuthorizationDecision {
  const evidence = taskAuthorization(source, input.taskId, now)
  const task = source.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as { project_id: string } | undefined
  const scoped = evidence.scope.find(s => s.projectId === input.projectId)
  const knownCapability = AUTHORIZATION_ACTIONS.includes(input.action as AuthorizationAction)
  const taskMatches = task?.project_id === input.projectId
  const capabilityMatches = knownCapability && evidence.effectivePermissions.includes(input.action as AuthorizationAction)
  const repositoryMatches = !input.action.startsWith('github.') || (!!input.repo && !!scoped?.repos.includes(input.repo.toLowerCase()))
  const allowed = evidence.status === 'active' && taskMatches && !!scoped && capabilityMatches && repositoryMatches
  let failureDimension: AuthorizationFailureDimension = null
  if (evidence.status !== 'active') failureDimension = 'chain'
  else if (!task) failureDimension = 'task'
  else if (!taskMatches || !scoped) failureDimension = 'project'
  else if (!capabilityMatches) failureDimension = 'capability'
  else if (!repositoryMatches) failureDimension = 'repository'
  const missingCapability = !allowed && failureDimension === 'capability' ? input.action : null
  const safeRemediation = allowed ? null
    : failureDimension === 'chain'
      ? 'Send a new authenticated human instruction in this project chat, or relay the user\'s request through the Commander; machine text cannot grant authority.'
      : failureDimension === 'capability'
        ? `Report that the instruction on record does not reach ${input.action} and ask the user what they want done; never demand a set phrase, and never retry with altered relay text.`
        : failureDimension === 'repository'
          ? 'Use a repository present in both the project configuration and the immutable authorization scope; cross-repository writes require a new human instruction.'
          : failureDimension === 'project'
            ? 'Keep the operation in the authorization\'s project; cross-project writes require a separate human instruction.'
            : 'Use the signed task scope that owns this authorization lineage.'
  return {
    ...evidence,
    allowed,
    status: evidence.status === 'active' && !allowed ? 'out_of_scope' : evidence.status,
    requestedCapability: input.action,
    missingCapability,
    originNodeId: evidence.origin?.id ?? null,
    originMessageId: evidence.origin?.messageId ?? null,
    failureDimension,
    safeRemediation
  }
}

/** A newly created task gets a fixed child of its caller's CURRENT chain. */
export function inheritTaskAuthorization(source: Source, callerTaskId: string, taskId: string, text: string, actions?: AuthorizationAction[]): void {
  source.db.transaction(() => {
    const evidence = taskAuthorization(source, callerTaskId)
    const task = source.db.prepare('SELECT project_id, repos FROM tasks WHERE id = ?').get(taskId) as { project_id: string; repos: string } | undefined
    if (!task || evidence.status !== 'active' || !evidence.nodeId) return
    const repos = JSON.parse(task.repos || '[]') as string[]
    const node = delegateAuthorization(source, { parentId: evidence.nodeId, author: 'agent', text, taskId, projectId: task.project_id, actions, repos: repos.length ? repos.map(r => r.toLowerCase()) : undefined })
    if (!node) return
    const key = `task-creation:${taskId}`
    bindAuthorizationTransport(source, key, node.id, taskId, text)
    activateAuthorizationDispatch(source, prepareAuthorizationDispatch(source, { key, taskId, text }))
    source.db.prepare(`
      UPDATE authorization_task_bindings SET assignment_node_id = ?
      WHERE task_id = ? AND assignment_node_id IS NULL
    `).run(node.id, taskId)
  })()
}

/** Called only by trusted UI/main-process code. No model-facing revoke/grant API. */
export function revokeAuthorization(source: Source, nodeId: string, reason: string, now = Date.now()): void {
  source.db.prepare('INSERT OR IGNORE INTO authorization_revocations VALUES (?, ?, ?)').run(nodeId, now, reason)
}
