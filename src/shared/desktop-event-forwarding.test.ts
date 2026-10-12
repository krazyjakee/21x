import { describe, expect, it } from 'vitest'
import { DESKTOP_EVENT_FORWARDING as policies, isReviewedForwardedName } from './desktop-event-forwarding'

describe('reviewed finite event forwarding source routes', () => {
  it('distinguishes persisted agent inputs from emitted durable events', () => {
    expect(policies['agent-persist-or-broadcast'].persistenceOnlyInputs).toEqual(['agent:output', 'agent:output-batch'])
    expect(isReviewedForwardedName('agent-persist-or-broadcast', 'agent:output')).toBe(false)
    expect(isReviewedForwardedName('agent-persist-or-broadcast', 'agent:output-batch')).toBe(false)
    expect(isReviewedForwardedName('agent-broadcast', 'artifact:updated')).toBe(true)
    expect(isReviewedForwardedName('agent-broadcast', 'transcript:changed')).toBe(false)
    expect(isReviewedForwardedName('guarded-direct', 'transcript:changed')).toBe(true)
  })

  it('keeps TTS/audio desktop-only and refuses wildcard/new names', () => {
    expect(policies['voice-desktop-relay'].desktopOnlyNames).toContain('voice:speech:chunk')
    expect(policies['voice-desktop-relay'].mobileNames).not.toContain('voice:speech:chunk')
    expect(policies['voice-desktop-relay'].mobileNames).not.toContain('voice:tts:status')
    expect(isReviewedForwardedName('voice-desktop-relay', 'voice:*')).toBe(false)
    expect(isReviewedForwardedName('voice-desktop-relay', 'voice:arbitrary')).toBe(false)
    expect(isReviewedForwardedName('__proto__' as never, 'task:updated')).toBe(false)
    expect(isReviewedForwardedName('updater-desktop', 'updater:status')).toBe(true)
    expect(isReviewedForwardedName('updater-desktop', 'task:updated')).toBe(false)
    expect(policies['updater-desktop'].channelOwners['updater:status']).toBe('native-host')
  })

  it('does not turn forwarding review into installed runtime authority', () => {
    expect(Object.keys(policies)).toHaveLength(10)
    for (const policy of Object.values(policies)) {
      expect(policy.runtimeEnforcement).toContain('not-installed')
      expect(policy.destination).toBe('trusted-desktop-main')
      expect(Object.keys(policy.channelOwners).sort()).toEqual([...policy.allowedNames].sort())
    }
  })
})
