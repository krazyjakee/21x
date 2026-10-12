import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
describe('actual portable agent desktop boundary', () => {
  it.skipIf(!process.env.TAURI_SQLITE_MODULE)('requires current approval identity, task scope and acknowledged teardown', async () => {
    const { stdout } = await promisify(execFile)(process.env.TAURI_NODE_RUNTIME || 'node', ['scripts/agent-desktop-proof.mjs'], {
      cwd: root, timeout: 40_000, maxBuffer: 1_048_576,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true, actualLifecycleOwner: true, actualAdapterIdentityGate: true, realSqlite: true, standaloneNode: true,
      publicFixtureAgentOnly: true, requestIdRequired: true, scopedTaskAndSession: true, staleApprovalDenied: true,
      duplicateApprovalDenied: true, approvalAccepted: true, approvalRejected: true, acknowledgedStop: true,
      ownerRecreated: true, staleRestoredCallbackDenied: true, durableProjectionAndDelta: true, liveResumeStatusSnapshot: true, criticalEventFailureExplicit: true
    })
  }, 45_000)
})
