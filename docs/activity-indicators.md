# Activity indicators

Status of GitHub [#95](https://github.com/krazyjakee/21x/issues/95): **first implementation plus Commander call integration**. This covers the shared vocabulary, freshness rules, indicator primitives, the voice adapter, and app-level call ownership. Board cards, the presence stage/PiP and remaining surfaces still come in follow-up work (see [Not wired yet](#not-wired-yet)).

The indicators answer one question, "is the Commander, a Captain or a task session doing something right now?", and they never claim activity without evidence. **Unknown is not idle, and idle is not running.**

## Vocabulary

`src/shared/activity.ts` defines the eleven states. `src/renderer/src/lib/activity/derive-activity.ts` maps typed evidence onto them (`deriveActivity(evidence, now)`, a pure function).

| State | Needs | Shown as |
| --- | --- | --- |
| `running` | A fresh authoritative `working` status, or a Commander turn that is producing text | "Running" / "Replying"; static detail "Triaging" / "Learning" |
| `thinking` | A Commander turn that is waiting for its first text, with no unresolved tool | "Thinking" |
| `tool` | A fresh tool start without its result, in the current turn | "Using [tool]" |
| `waiting-for-user` | A fresh `waiting_approval` status (or a question) | "Needs approval" / "Needs your answer" |
| `queued` | Fresh StartQueue membership from main | "Queued · [reason]", with the position as detail |
| `speaking` | Verified playback owned by this entity (see [Voice](#voice)) | "Speaking" |
| `listening` | An open microphone owned by this entity | "Listening" |
| `finished` | Task: `ready_for_review`/`completed`. Commander/Captain: a turn that ended successfully | "Ready for review" / "Completed" / "Reply finished" (brief) |
| `failed` | An explicit error in the current run | "Failed" (+ reason) |
| `idle` | A fresh authoritative idle status | "Idle" (+ "Stopped" after a cancellation) |
| `unknown` | No evidence, expired evidence, a known disconnect, or ownership that cannot be proven | "Status unavailable", with "Last seen running" / "Last result: Failed" when something was known |

A task's lifecycle status (`agent_working`, `triaging`, …) is durable, and it survives the death of the process. It is only ever a static detail or a historical result. **It never produces a running claim.**

When several things are true at once, the higher entry wins (after the freshness check): current blocking request > speaking > listening > tool > thinking > running > queued > failed > finished > idle > unknown. A fresh queue claim together with a fresh running claim is a conflict. It shows as unknown ("Reconciling queue and session") instead of a guess. A newer active phase starts a new run and clears the previous outcome.

The six queue reasons read as: global session limit reached, agent session limit reached, project session limit reached, all projects paused, project paused, daily budget reached.

## Freshness

Constants in `src/shared/activity.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `ACTIVITY_REVALIDATE_MS` | 5 s | Sources are re-read, or heartbeats sent, at most this often |
| `ACTIVITY_STALE_MS` | 15 s | A live claim older than this becomes `unknown` |
| `ACTIVITY_FINISH_ACCENT_MS` | 3 s | How long the completion accent lasts |

### Task and Captain sessions

`agent:status` used to be transition-only, so an agent working quietly for a minute looked the same as a dead one. Now:

- **Every push is stamped.** `emitStatus` adds `epoch` (one main-process lifetime) and `seq` (increases with every push) to each `agent:status` push (`src/main/agent-manager/activity-observations.ts`). The renderer rejects a push whose sequence is not newer within the same epoch. A new epoch (main restarted) is accepted.
- **Successful polls send heartbeats.** After an adapter poll where both `pollMessages` and `getStatus` succeed, a session that is `working` or `waiting_approval` publishes a heartbeat, at most once every 5 s: `{ sessionId, agentId, taskId, status, epoch, seq, heartbeat: true }`. Heartbeats go straight to the window with `guardedIpcSend`. They skip `sendToRenderer`, `lastSentStatus`, notifications, the voice bridge and mobile clients, so none of the transition side effects (Captain wakes, queue drains, notifications) can fire.
- **Silence becomes unknown.** A failed or hung poll sends nothing, so the claim expires to `unknown` within 15 s. A long, quiet tool stays fresh because every successful poll renews it. Replaying the renderer's cached status never renews anything.
- **Idle is not heartbeated.** A verified idle stays fresh for 15 s after the transition and then becomes `unknown`. The badges treat "unknown with no active history" as quiet (see below), so this does not clutter the UI.
- **Separate observation store.** The renderer keeps these observations in `useSessionActivityStore` (`lib/activity/session-activity-adapter.ts`), apart from the agent store: that store's `initSession` and transcript hydration make up statuses that are not evidence. `agent-store` hands every push to `recordAgentStatus()` and then ignores heartbeats, so its existing behaviour is unchanged. `overview-store` also ignores heartbeats.

### Queue

`retainQueueSource()` reads `agents.getStartQueue()` once, then every 5 s while the window is visible and at least one indicator needs it, and it also listens to `onAgentStartQueueChanged`. Responses carry a generation number, so an older, slower read cannot overwrite a newer one. A failed read renews nothing.

### Commander

`lib/activity/commander-activity-adapter.ts` subscribes to `commander:event` itself, so the state stays current while the Commander view is closed. Events of an older turn are ignored, and a finished turn is not revived. The Commander has no heartbeat yet, so a turn that goes quiet for 15 s shows as "Status unavailable · Last seen replying". The adapter never reads a cached `activeTurnId`.

### Time and deadlines

All evidence is stamped with monotonic time (`performance.now()`, via `activityNow()`). `lib/activity/activity-clock.ts` is the only deadline scheduler: indicators register the moment their state stops being true, one timeout is armed for the earliest moment, and a `tick` makes subscribers re-derive. When the window becomes visible again it ticks at once, so ages are checked before any motion resumes.

## Voice

`lib/activity/voice-activity-adapter.ts` is the only place indicators read voice state. It **fails closed**:

- The store's `speaking` flag is set when synthesis *starts*, before any audio, and it names no speaker. On its own it never counts as speaking.
- `speaking` needs three things: the passage attributed by its `speechStart` event (`taskId`) belongs to this entity, the same passage is open in `voicePlayback`, and `hasQueuedAudio` is true.
- Unattributed passages give `unknown` for everyone. Commander passages use
  the shared `commander:<sessionId>` key, so only that Commander session may
  claim them.
- The microphone has no owner of its own, so `listening` is `unknown` unless a
  caller passes a provable owner. The app-level Commander call host supplies
  the session whose microphone turn it opened.

The adapter controls no audio or microphone and adds no audio loop. #89 owns the real output-level speaking ring. Here speaking is a static speaker icon and ring.

## Primitives

The components live in `src/renderer/src/components/activity/`. The tokens are at the end of `styles/globals.css`.

| Component | Use | Motion (motion owner only) | Reduced motion |
| --- | --- | --- | --- |
| `ActivityBadge` (`variant="badge"`) | 20 px pill: 12 px icon + 11 px word | Running icon breathes 0.65→1 over 2.4 s | Static |
| `ActivityBadge` (`variant="dot"`) | 6 px (chrome) / 8 px (content) dot + static icon. The full label opens on hover **and keyboard focus** | Running dot breathes | Static |
| `ActivityRing` | 2 px ring around a 24–64 px identity | Thinking only: scale 1→1.03 over 2.4 s | Static ring |
| `ProgressShimmer` | 2 × 32 px indeterminate line beside "Using [tool]". No `progressbar` role, no value | Clipped sweep every 2.4 s | Static line |
| `FinishedTick` | 14 px check in the review (pink) or success tone | 150 ms fade-in; the accent settles after 3 s with a 250 ms fade | Static accent, removed after 3 s |
| `TaskActivityBadge` | One task's badge (canvas header now, board cards next) | As `ActivityBadge` | As `ActivityBadge` |
| `ActivityAnnouncer` | The single polite live region for task/Captain activity | — | — |

Icons: play (running), speech bubble with dots (thinking), wrench (tool), hand (approval), question bubble (question), clock (queued), speaker (speaking), mic (listening), check (finished), alert (failed), minus (idle), slashed circle (unknown, drawn hollow and never animated).

Tones alias the system tokens (`--activity-active`, `-attention`, `-review`, `-success`, `-danger`, `-muted`). In the light theme the active, attention, review, success and danger tones are darker shades, because `--primary` and `--warning` fall under 3:1 on the light background. A unit test checks that every tone reaches 3:1 against both theme backgrounds, and that badge text (the foreground colour) reaches 4.5:1.

`activityPresentation(result, { reducedMotion, motionOwner })` is the pure rule for drawing a result. Only running, thinking and tool may move, only for the motion owner, and never under reduced motion. The same rule is also enforced in CSS through `@media (prefers-reduced-motion: reduce)`, which now also stills the older canvas status flash/wave/beacon animations.

### Motion ownership

`lib/activity/motion-owner.ts` allows **one moving indicator per region and one per entity** across mirrored regions. The first claim that still wants motion owns it, and the next claimant takes over when it leaves. Nothing moves while the document is hidden. Mirrors (top bar, dashboard hero, nav rail, status bar) pass `allowMotion={false}`. On the canvas, only the frontmost task panel may animate. Offscreen (frozen) panels do not mount the badge at all.

### Quiet states

Compact surfaces call `isQuietActivity(result)` and render nothing for a verified idle, or for unknown with no active history. Rendering nothing makes no claim. A claim that was active and has been lost still shows "Status unavailable · Last seen …".

## Accessibility

- An indicator has exactly one accessible name, for example "Captain — Needs approval · detail" (`activityAccessibleName`). Decorative dots and icons are `aria-hidden`. When a badge sits inside a control that already names its state (the nav rail and top-bar buttons), it is rendered `decorative` and the state goes into the control's `aria-label`.
- No badge is a live region. `ActivityAnnouncer`, mounted once inside the always-present `StatusBar`, owns task/Captain announcements (`lib/activity/announcer.ts`):
  - Actionable ("… needs approval", "… failed") is never dropped, and is spoken in order at most once per second.
  - Routine (task ready for review/completed, "Captain reply finished") is coalesced for 2 s and aggregated ("3 tasks ready for review"). Each entity gets at most one routine announcement per 5 s.
  - Everything is deduplicated by entity/transition key.
  - Nothing is announced for heartbeats, first sightings, hydration, tokens or tool steps.
  - Commander announcements are left to #91's CallAnnouncer.
- The state words stay visible with animation and live regions switched off. Nothing steals focus.

## Where it is wired

| Surface | File | What it shows |
| --- | --- | --- |
| Canvas task panel header | `components/canvas/CanvasPanel.tsx` | `TaskActivityBadge` after the title. The panel's own flash/wave no longer fires on the review transition: the header's finished accent is the one completion effect for that panel. The offscreen HUD beacon (a different region) is unchanged. |
| Status bar | `components/layout/StatusBar.tsx` | Project-scoped counts: running (fresh running/thinking/tool only, including the project's Captain), needs input, queued, failed, unavailable (active claims that expired), ready for review. The Commander's own global state as a static dot. Hosts `ActivityAnnouncer`. The old pulsing "every non-idle session is running" dot is gone. |
| Nav rail | `components/layout/NavRail.tsx` | Static Commander state glyph on the Commander item. The state is in the item's accessible name and in its tooltip, which now also opens on keyboard focus. |
| Captain entry | `components/layout/TopBar.tsx` | Static Captain state dot on the Captain button (in its accessible name and tooltip). Includes verified speech. |
| Dashboard hero | `components/dashboard/HeroSection.tsx` | "Captain [badge]" beside the project name, static. |
| Held Captain actions | `components/projects/HeldActionsNotice.tsx` | Unchanged approve/reject pill (policy-held actions, separate from session approvals). It now re-reads every 5 s while visible, and when reads keep failing it shows a static "held actions unavailable" pill instead of silence. |

## Not wired yet

These files belonged to another session's uncommitted hands-free voice work when this was implemented. The follow-up task wires them:

- Board task cards (`TaskBoard.tsx`): mount the prepared `TaskActivityBadge`.
- The task workspace (`TaskWorkspace.tsx`).
- Commander chat (`CommanderChatPane.tsx`): replace its thinking dots with the shared result.
- The Commander presence stage and PiP (#85/#87): consume the same results; #89 supplies the speaking ring.
- The Commander CallAnnouncer (#91).
- An authoritative Commander idle snapshot, and a typed transport for the new `agent:status` fields in `electron.d.ts`/preload. The fields pass through today because preload forwards the payload unchanged, and the renderer validates them at runtime (`readAgentStatusActivityMeta`).

A quiet Commander turn still becomes unknown after 15 s; the call's verified
speaking and listening claims do not rely on that stale turn observation.

## Tests

- `src/shared/activity.test.ts`: vocabulary and runtime validation of the metadata.
- `src/main/agent-manager/activity-observations.test.ts` and `src/main/agent-manager-activity.test.ts`: stamping, heartbeat rate limit, heartbeats only after a successful poll and only for active sessions, never through `sendToRenderer`.
- `src/renderer/src/lib/activity/*.test.ts`:
  - table tests for all eleven states;
  - 15 s boundaries, late/replayed pushes and epoch replacement;
  - queue reasons, conflicts, Captain vs task completion, and cancellation;
  - reduced motion and motion ownership;
  - voice ownership, the announcer's coalescing, limits and deduplication, and the single deadline timer.
- `src/renderer/src/components/activity/*.test.tsx`: accessible names, no live regions per badge, reduced motion, no `progressbar` semantics, theme contrast, agent-store heartbeat handling, `StatusBar` counts, and `TaskActivityBadge` expiring to unknown.
