import { expect, it, vi } from 'vitest'
import { runOwnedPreflightChecks } from './heartbeat-preflight'
import { execFileAsync } from './find-executable'
vi.mock('./find-executable', () => ({ execFileAsync: vi.fn() }))
const content = '# Checks\n- Check https://github.com/fixture/repo/pull/42 for CI or new activity.'
const sha = 'a'.repeat(40)
it('uses the captured executor for every actual preflight check without ambient CLI fallback', async () => {
  const execute = vi.fn(async (args: string[]) => ({ stdout: args[3] === '.head.sha' ? sha : args[3].includes('mergeable:') ? JSON.stringify({ mergeable: true, mergeable_state: 'clean', head_sha: sha }) : '0', stderr: '' }))
  expect(await runOwnedPreflightChecks(content, '2026-10-14T00:00:00Z', { execute, beforeEffect() {} })).toBe('no_changes')
  expect(execute).toHaveBeenCalled(); expect(execFileAsync).not.toHaveBeenCalled()
  for (const [args] of execute.mock.calls) { expect(args[0]).toBe('api'); expect(args[2]).toBe('--jq'); expect(args[1]).toMatch(/^repos\/fixture\/repo\//) }
  expect(execute.mock.calls.some(([args]) => args[3].includes('2026-10-14T00:00:00.000Z'))).toBe(true)
})
it('does not convert withdrawn authority into an inconclusive result or another child command', async () => {
  let release!: () => void, entered!: () => void, allowed = true
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve }), withdrawn = new Error('Actual task authority withdrawn')
  const execute = vi.fn(async () => { entered(); await gate; return { stdout: sha, stderr: '' } })
  const request = runOwnedPreflightChecks(content, '2026-10-14T00:00:00Z', { execute, beforeEffect() { if (!allowed) throw withdrawn } })
  const rejected = expect(request).rejects.toBe(withdrawn)
  await started; allowed = false; release(); await rejected
  expect(execute).toHaveBeenCalledOnce(); expect(execFileAsync).not.toHaveBeenCalled()
})
it('keeps uncertain provider results inconclusive and refuses unbounded or malformed references before CLI effects', async () => {
  const execute = vi.fn(async () => ({ stdout: 'not-a-commit', stderr: '' })), host = { execute, beforeEffect() {} }
  expect(await runOwnedPreflightChecks(content, '2026-10-14', host)).toBe('inconclusive')
  expect(execute).toHaveBeenCalledOnce(); execute.mockClear()
  for (const [checks, last] of [[content.repeat(33), '2026-10-14'], [content.replace('fixture/repo', '../repo'), '2026-10-14'], [content, 'invalid-date'], ['X'.repeat(131073), '2026-10-14']] as const)
    expect(await runOwnedPreflightChecks(checks, last, host)).toBe('inconclusive')
  expect(execute).not.toHaveBeenCalled(); expect(execFileAsync).not.toHaveBeenCalled()
})
