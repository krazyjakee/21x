import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs script without type declarations
import { checkPins, declaredLicense, isLicenseAllowed, parseAllowlistSource } from './check-connector-pieces.mjs'

const allowlistSource = readFileSync(join(__dirname, '../src/main/connectors/allowlist.ts'), 'utf8')

describe('check-connector-pieces', () => {
  it('parses the allowlist data block from allowlist.ts', () => {
    const allowlist = parseAllowlistSource(allowlistSource)
    expect(allowlist.pieces['@activepieces/piece-trello'].version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(allowlist.allowedLicenses).toContain('MIT')
  })

  it('the repository package.json passes the pin check', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
    expect(checkPins(pkg, parseAllowlistSource(allowlistSource))).toEqual([])
  })

  it('rejects ranges, unknown @activepieces packages and version drift', () => {
    const allowlist = parseAllowlistSource(allowlistSource)
    const trello = allowlist.pieces['@activepieces/piece-trello'].version
    const errors: string[] = checkPins(
      {
        dependencies: {
          '@activepieces/piece-trello': `^${trello}`,
          '@activepieces/piece-gmail': '1.0.0',
          '@activepieces/pieces-framework': '0.0.1'
        }
      },
      allowlist
    )
    expect(errors.some((e) => e.includes('piece-trello') && e.includes('exact version'))).toBe(true)
    expect(errors.some((e) => e.includes('piece-gmail') && e.includes('not in the connector allowlist'))).toBe(true)
    expect(errors.some((e) => e.includes('pieces-framework') && e.includes('allowlist says'))).toBe(true)
  })

  it('evaluates SPDX expressions', () => {
    const allowed = ['MIT', 'Apache-2.0']
    expect(isLicenseAllowed('MIT', allowed)).toBe(true)
    expect(isLicenseAllowed('(MIT OR GPL-3.0)', allowed)).toBe(true)
    expect(isLicenseAllowed('MIT AND GPL-3.0', allowed)).toBe(false)
    expect(isLicenseAllowed('GPL-2.0 WITH Classpath-exception-2.0', allowed)).toBe(false)
    expect(isLicenseAllowed('Apache-2.0 WITH LLVM-exception', allowed)).toBe(true)
    expect(isLicenseAllowed('SEE LICENSE IN LICENSE.md', allowed)).toBe(false)
    expect(isLicenseAllowed('', allowed)).toBe(false)
  })

  it('reads license, license objects and legacy licenses arrays', () => {
    expect(declaredLicense({ license: 'ISC' })).toBe('ISC')
    expect(declaredLicense({ license: { type: 'MIT' } })).toBe('MIT')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)')
    expect(declaredLicense({})).toBeNull()
  })
})
