import { afterEach, describe, expect, it } from 'vitest'
import { __resetMotionOwners, claimMotion, ownsMotion, releaseMotion } from './motion-owner'

afterEach(() => __resetMotionOwners())

describe('motion ownership', () => {
  it('allows one moving indicator per region', () => {
    claimMotion('a', 'canvas-panel:1', 'task:1')
    claimMotion('b', 'canvas-panel:1', 'task:2')
    expect(ownsMotion('a')).toBe(true)
    expect(ownsMotion('b')).toBe(false)
    releaseMotion('a')
    expect(ownsMotion('b')).toBe(true)
  })

  it('allows one moving indicator per entity across mirrored regions', () => {
    claimMotion('panel', 'canvas-panel:1', 'task:1')
    claimMotion('card', 'board-card:1', 'task:1')
    expect(ownsMotion('panel')).toBe(true)
    expect(ownsMotion('card')).toBe(false)
  })

  it('an unclaimed token never owns motion', () => {
    expect(ownsMotion('nobody')).toBe(false)
  })
})
