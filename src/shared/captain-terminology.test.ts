import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The project coordinator is the Captain (#71): Commander → Captain → task
 * agent. The old name survives only where stored data or stored transcripts
 * still spell it, and each such file is listed here with the reason.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/main/database/captain-migration.ts': 'upgrade boundary: renames the persisted legacy identifiers and retires the legacy seeded skill',
  'src/main/database/captain-migration.test.ts': 'schema-16 fixture for the upgrade boundary'
}

describe('Captain terminology', () => {
  it('uses the retired coordinator name only in allowlisted legacy files', () => {
    const legacy = new RegExp(['master', 'mind'].join(' ?'), 'i')
    // Tracked plus not-yet-added files, so a new file cannot slip past.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\0')
      .filter(Boolean)

    const offenders = [...new Set(files)].filter((file) => {
      const path = join(repoRoot, file)
      // A tracked file deleted in the working tree is not part of the source.
      if (file in ALLOWED || !existsSync(path)) return false
      const bytes = readFileSync(path)
      if (bytes.includes(0)) return false // binary assets
      let content = bytes.toString('utf-8')
      if (file === 'src/shared/captain-compat.ts') {
        // Exempt declarations only, never the rest of a UI/prompt module.
        content = content.split('\n').filter((line) =>
          !line.startsWith('export const LEGACY_CAPTAIN_TOOL = ') &&
          !line.startsWith('const LEGACY_CAPTAIN_NAME = ')
        ).join('\n')
      }
      return legacy.test(file) || legacy.test(content)
    })

    expect(
      offenders,
      'Say Captain. The old name is only allowed at an explicit upgrade or compatibility boundary; ' +
      'add such a file to ALLOWED with the reason.'
    ).toEqual([])
  })
})
