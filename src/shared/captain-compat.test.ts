import { describe, expect, it } from 'vitest'
import { captainTerminology, captainToolName, LEGACY_CAPTAIN_TOOL } from './captain-compat'

describe('Captain read compatibility', () => {
  it('normalizes case and the spaced role name without renaming stored tool identifiers', () => {
    const legacy = ['Master', 'mind'].join('')
    for (const name of [legacy, legacy.toLowerCase(), legacy.toUpperCase(), ['master', 'mind'].join(' ')]) {
      expect(captainTerminology(`The ${name} reported back.`)).toBe('The Captain reported back.')
    }
    expect(captainTerminology(LEGACY_CAPTAIN_TOOL)).toBe(LEGACY_CAPTAIN_TOOL)
    for (const literal of [`rename-${legacy.toLowerCase()}-to-captain`, `/notes/${legacy}`, `https://${legacy.toLowerCase()}.example`]) {
      expect(captainTerminology(literal)).toBe(literal)
    }
    expect(captainTerminology(`Ask ${legacy}.`)).toBe('Ask Captain.')
    expect(captainTerminology('Captain')).toBe('Captain')
  })

  it('recognizes the old delegation tool without changing unrelated identifiers', () => {
    expect(captainToolName(LEGACY_CAPTAIN_TOOL)).toBe('ask_captain')
    expect(captainToolName('get_task')).toBe('get_task')
  })
})
