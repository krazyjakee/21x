import {
  ACTIVITY_FINISH_ACCENT_MS,
  ACTIVITY_STALE_MS,
  describeActivityQueueReason,
  type ActivityState
} from '@shared/activity'

/**
 * Pure state → indicator derivation (#95, docs/activity-indicators.md).
 *
 * Takes typed evidence and a monotonic `now`, and returns the one state an
 * indicator may show. Freshness is checked first; missing or expired evidence
 * yields `unknown`, never `idle`. The durable task lifecycle is only ever a
 * static detail or a historical result: it never produces a running claim.
 */

export type ActivityEntityKind = 'task' | 'captain' | 'commander'

/** The phase an authoritative live source reported. */
export type LivePhase = 'working' | 'thinking' | 'tool' | 'waiting_approval' | 'question' | 'idle' | 'error'

export interface LiveObservation {
  phase: LivePhase
  /** Monotonic receipt time of the observation that established this phase or renewed it. */
  observedAt: number
  toolName?: string
  reason?: string
  /** Overrides the default 15 s expiry. */
  staleAfterMs?: number
}

export interface QueueObservation {
  /** Main's admission reason. */
  reason?: string
  /** 1-based position when known. */
  position?: number
  observedAt: number
  staleAfterMs?: number
}

/** Result of the voice adapter for this entity. Local media lifetime, no clock. */
export interface VoiceObservation {
  state: 'speaking' | 'listening' | 'none' | 'unknown'
  /** Microphone also open while speaking: a static detail only. */
  micOpen?: boolean
}

/** A terminal outcome observed live in this renderer (never from hydration). */
export interface OutcomeObservation {
  kind: 'finished' | 'failed' | 'stopped'
  observedAt: number
  reason?: string
}

export interface ActivityEvidence {
  entity: ActivityEntityKind
  live?: LiveObservation | null
  /** Fresh StartQueue membership, or null when the queue read says "not queued". */
  queue?: QueueObservation | null
  voice?: VoiceObservation | null
  outcome?: OutcomeObservation | null
  /** Durable lifecycle (task status). Static detail / historical result only. */
  lifecycle?: string | null
  /** An explicit, known disconnection: every live claim is unknown at once. */
  disconnected?: boolean
}

export type ActivityTone = 'active' | 'attention' | 'review' | 'success' | 'danger' | 'muted'

export interface ActivityResult {
  state: ActivityState
  /** The visible state word. */
  label: string
  /** Optional static detail: queue reason, "Triaging", "Last seen running". */
  detail?: string
  tone: ActivityTone
  /** For unknown: the last state that was known, if any. */
  lastKnown?: ActivityState
  /** True while the 3 s completion accent applies (observed transitions only). */
  accent: boolean
  /** Monotonic time at which this result stops being true, or null. */
  expiresAt: number | null
}

const ACTIVE_PHASES: ReadonlySet<LivePhase> = new Set(['working', 'thinking', 'tool'])

function isFresh(observedAt: number, staleAfterMs: number | undefined, now: number): boolean {
  const age = now - observedAt
  return age >= 0 && age < (staleAfterMs ?? ACTIVITY_STALE_MS)
}

function phaseState(phase: LivePhase): ActivityState {
  switch (phase) {
    case 'working':
      return 'running'
    case 'thinking':
      return 'thinking'
    case 'tool':
      return 'tool'
    case 'waiting_approval':
    case 'question':
      return 'waiting-for-user'
    case 'error':
      return 'failed'
    case 'idle':
      return 'idle'
  }
}

const STATE_WORDS: Record<ActivityState, string> = {
  running: 'Running',
  thinking: 'Thinking',
  tool: 'Using a tool',
  'waiting-for-user': 'Needs approval',
  queued: 'Queued',
  speaking: 'Speaking',
  listening: 'Listening',
  finished: 'Finished',
  failed: 'Failed',
  idle: 'Idle',
  unknown: 'Status unavailable'
}

const STATE_TONES: Record<ActivityState, ActivityTone> = {
  running: 'active',
  thinking: 'active',
  tool: 'active',
  'waiting-for-user': 'attention',
  queued: 'muted',
  speaking: 'active',
  listening: 'active',
  finished: 'review',
  failed: 'danger',
  idle: 'muted',
  unknown: 'muted'
}

/** The plain word for a state, independent of entity. */
export function activityStateWord(state: ActivityState): string {
  return STATE_WORDS[state]
}

function lifecycleDetail(lifecycle: string | null | undefined): string | undefined {
  if (lifecycle === 'triaging') return 'Triaging'
  if (lifecycle === 'agent_learning') return 'Learning'
  return undefined
}

function minDeadline(...values: Array<number | null | undefined>): number | null {
  let best: number | null = null
  for (const v of values) if (v != null && Number.isFinite(v) && (best == null || v < best)) best = v
  return best
}

export function deriveActivity(evidence: ActivityEvidence, now: number): ActivityResult {
  const { entity, live, queue, voice, outcome, lifecycle, disconnected } = evidence

  // 1. Freshness first.
  const liveFresh = Boolean(live && !disconnected && isFresh(live.observedAt, live.staleAfterMs, now))
  const liveExpiry = live && liveFresh ? live.observedAt + (live.staleAfterMs ?? ACTIVITY_STALE_MS) : null
  const queueFresh = Boolean(queue && !disconnected && isFresh(queue.observedAt, queue.staleAfterMs, now))
  const queueExpiry = queue && queueFresh ? queue.observedAt + (queue.staleAfterMs ?? ACTIVITY_STALE_MS) : null
  const liveState: ActivityState | null = live && liveFresh ? phaseState(live.phase) : null
  const liveActive = Boolean(live && liveFresh && ACTIVE_PHASES.has(live.phase))

  // A newer active phase starts a new run and clears the old outcome.
  const outcomeCurrent =
    outcome && !(live && ACTIVE_PHASES.has(live.phase) && live.observedAt > outcome.observedAt) ? outcome : null
  const accentEnd = outcomeCurrent ? outcomeCurrent.observedAt + ACTIVITY_FINISH_ACCENT_MS : null
  const accentOn = Boolean(outcomeCurrent && outcomeCurrent.kind === 'finished' && accentEnd != null && now < accentEnd && now >= outcomeCurrent.observedAt)

  const result = (
    state: ActivityState,
    extra: Partial<Omit<ActivityResult, 'state'>> = {},
    ...deadlines: Array<number | null | undefined>
  ): ActivityResult => ({
    state,
    label: extra.label ?? STATE_WORDS[state],
    tone: extra.tone ?? STATE_TONES[state],
    accent: extra.accent ?? false,
    expiresAt: minDeadline(...deadlines),
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.lastKnown ? { lastKnown: extra.lastKnown } : {})
  })

  // 2. A current blocking request outranks everything else.
  if (liveState === 'waiting-for-user') {
    return result('waiting-for-user', { label: live?.phase === 'question' ? 'Needs your answer' : 'Needs approval' }, liveExpiry)
  }

  // 3. Verified speech, then verified listening.
  const micDetail = voice?.micOpen ? 'Microphone open' : undefined
  if (voice?.state === 'speaking') return result('speaking', { detail: micDetail }, liveExpiry, queueExpiry)
  if (voice?.state === 'listening') return result('listening', {}, liveExpiry, queueExpiry)

  // 4. Active work. A simultaneous fresh queue claim is a conflict: reconcile, don't guess.
  if (liveActive && liveState) {
    if (queueFresh) {
      return result('unknown', { detail: 'Reconciling queue and session', lastKnown: liveState }, liveExpiry, queueExpiry)
    }
    if (liveState === 'tool') {
      return result('tool', { label: live?.toolName ? `Using ${live.toolName}` : 'Using a tool' }, liveExpiry)
    }
    if (liveState === 'running') {
      return result('running', { label: entity === 'commander' ? 'Replying' : 'Running', detail: lifecycleDetail(lifecycle) }, liveExpiry)
    }
    return result(liveState, {}, liveExpiry)
  }

  // 5. Queued: fresh StartQueue membership only. No motion, no percentage.
  if (queueFresh && queue) {
    const reason = describeActivityQueueReason(queue.reason)
    const detail = queue.position ? `#${queue.position} · ${reason}` : reason
    return result('queued', { label: `Queued · ${reason}`, detail }, queueExpiry, liveExpiry)
  }

  // 6. Failure of the current run.
  if (liveState === 'failed') {
    return result('failed', { detail: live?.reason }, liveExpiry)
  }
  if (outcomeCurrent?.kind === 'failed' && (liveFresh || !live)) {
    return result('failed', { detail: outcomeCurrent.reason }, liveExpiry)
  }

  // 7. Completion.
  if (entity === 'task') {
    if (lifecycle === 'ready_for_review' || lifecycle === 'completed') {
      const completed = lifecycle === 'completed'
      return result(
        'finished',
        { label: completed ? 'Completed' : 'Ready for review', tone: completed ? 'success' : 'review', accent: accentOn },
        accentOn ? accentEnd : null
      )
    }
  } else if (accentOn) {
    // Commander/Captain: a successful turn end says so briefly, then settles.
    return result('finished', { label: 'Reply finished', tone: 'success', accent: true }, accentEnd, liveExpiry)
  }

  // 8. Verified idle.
  if (liveState === 'idle') {
    const stopped = outcomeCurrent?.kind === 'stopped'
    return result('idle', stopped ? { detail: 'Stopped' } : {}, liveExpiry)
  }

  // 9. Nothing current and trustworthy: unknown, with the last known state as history.
  const lastKnown: ActivityState | undefined = live ? phaseState(live.phase) : outcomeCurrent?.kind === 'failed' ? 'failed' : undefined
  let detail: string | undefined
  if (voice?.state === 'unknown') detail = 'Voice state unavailable'
  if (lastKnown === 'failed') detail = 'Last result: Failed'
  else if (lastKnown) detail = `Last seen ${lastKnownWord(lastKnown, entity)}`
  if (disconnected) detail = detail ? `Disconnected · ${detail}` : 'Disconnected'
  return result('unknown', { detail, lastKnown })
}

function lastKnownWord(state: ActivityState, entity: ActivityEntityKind): string {
  if (state === 'running') return entity === 'commander' ? 'replying' : 'running'
  if (state === 'waiting-for-user') return 'waiting for you'
  return STATE_WORDS[state].toLowerCase()
}

// ── Presentation ────────────────────────────────────────────

export type ActivityIconKey =
  | 'running'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'question'
  | 'queued'
  | 'speaking'
  | 'listening'
  | 'finished'
  | 'failed'
  | 'idle'
  | 'unknown'

export type ActivityMotion = 'none' | 'breathe' | 'ring' | 'shimmer'

export interface ActivityPresentation {
  icon: ActivityIconKey
  tone: ActivityTone
  /** The one decorative animation this indicator may run, if any. */
  motion: ActivityMotion
  /** Completion accent: fade in/out, a static accent (reduced motion), or none. */
  accent: 'fade' | 'static' | 'none'
  /** Unknown uses a hollow/slashed icon and never animates. */
  hollow: boolean
}

export interface PresentationOptions {
  reducedMotion: boolean
  /** Whether this instance is its region's and entity's motion owner. */
  motionOwner: boolean
}

function iconFor(result: ActivityResult): ActivityIconKey {
  if (result.state === 'waiting-for-user') return result.label === 'Needs your answer' ? 'question' : 'approval'
  return result.state
}

/**
 * How a derived result is drawn. Only running (breathing dot), thinking
 * (breathing ring) and tool (shimmer) may move, only for the motion owner, and
 * never under reduced motion. Speaking stays static here: #89 owns the real
 * output-level ring.
 */
export function activityPresentation(result: ActivityResult, options: PresentationOptions): ActivityPresentation {
  const canMove = options.motionOwner && !options.reducedMotion
  let motion: ActivityMotion = 'none'
  if (canMove) {
    if (result.state === 'running') motion = 'breathe'
    else if (result.state === 'thinking') motion = 'ring'
    else if (result.state === 'tool') motion = 'shimmer'
  }
  const accent = result.accent ? (options.reducedMotion || !options.motionOwner ? 'static' : 'fade') : 'none'
  return {
    icon: iconFor(result),
    tone: result.tone,
    motion,
    accent,
    hollow: result.state === 'unknown'
  }
}

/**
 * Compact surfaces (nav rail, headers) hide states that say nothing new:
 * verified idle, and unknown with no active history. Hiding is not a claim;
 * the expanded surfaces still show "Status unavailable".
 */
export function isQuietActivity(result: ActivityResult): boolean {
  if (result.state === 'idle') return true
  if (result.state !== 'unknown') return false
  return !result.lastKnown || result.lastKnown === 'idle'
}
