/** Real bundled service, bounded display pages and durable recovery; isolated profile only. */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { connectDatabaseService } from './database-service-proof.mjs'

export async function runTranscriptPageProof({ serviceEntry, node = process.env.TAURI_NODE_RUNTIME || 'node' }) {
  const entry = await realpath(serviceEntry)
  const resourceRoot = await realpath(dirname(dirname(entry)))
  const profileRoot = await realpath(await mkdtemp(join(tmpdir(), '21x-database-service-')))
  const client = connectDatabaseService({ node, entry, resourceRoot, profileRoot })
  const report = { reportVersion: 1, passed: false, actualBundledService: true, phase: 'initialize' }
  let largestPage = 0
  const validate = (page, request, taskId) => {
    const bytes = Buffer.byteLength(JSON.stringify(page))
    largestPage = Math.max(largestPage, bytes)
    assert.ok(bytes <= 256 * 1024 && page.version === 1 && page.taskId === taskId && page.mode === request.mode && page.after === request.after)
    assert.ok(page.parts.length <= (request.limit ?? 64))
    if (request.watermark !== undefined) assert.equal(page.watermark, request.watermark)
    let cursor = request.after
    for (const part of page.parts) {
      assert.equal(part.taskId, taskId)
      assert.ok(part.rev <= page.watermark)
      const next = request.mode === 'snapshot' ? part.seq : part.rev
      assert.ok(next > cursor)
      cursor = next
    }
    assert.equal(page.cursor, request.mode === 'delta' && !page.hasMore ? page.watermark : cursor)
    assert.ok(!page.hasMore || page.parts.length > 0)
  }
  try {
    await client.initialize()
    const task = await client.command('db:createTask', { data: { title: 'Paged transcript proof' } })
    const taskId = task.id
    report.phase = 'seed-real-projection'
    for (let start = 0; start < 640; start += 32) {
      await client.request('fixture.transcriptUpsert', { taskId, parts: Array.from({ length: 32 }, (_, i) => ({
        id: `part-${start + i}`, role: 'assistant', content: '🚀'.repeat(4096), receivedAt: 2000 - start - i
      })) })
    }
    // A field larger than a display page survives storage but is not loaded into a page DTO.
    await client.request('fixture.transcriptUpsert', { taskId, parts: [{ id: 'large', role: 'assistant', content: 'Large stored tool', tool: { name: 'read', output: 'x'.repeat(400_000) } }] })
    const invalidations = client.events.filter(event => event.operation === 'transcript:changed' && event.payload.reloadRequired)
    assert.ok(invalidations.length >= 21)
    for (const event of invalidations) {
      assert.deepEqual(event.payload.parts, [])
      assert.equal(event.payload.taskId, taskId)
      assert.ok(event.payload.maxRev > 0 && Buffer.byteLength(JSON.stringify(event.payload)) < 1024)
    }
    report.phase = 'paged-snapshot-with-racing-writes'
    const parts = new Map()
    let after = 0
    let watermark
    let snapshotPages = 0
    while (true) {
      const request = { version: 1, mode: 'snapshot', after, limit: 31, ...(watermark === undefined ? {} : { watermark }) }
      const page = await client.command('agentSession:getTranscriptPage', { taskId, page: request })
      validate(page, request, taskId)
      for (const part of page.parts) parts.set(part.partId, part)
      watermark ??= page.watermark
      if (++snapshotPages === 1) {
        await client.request('fixture.transcriptUpsert', { taskId, parts: [
          { id: 'part-0', role: 'assistant', content: 'Updated after snapshot' },
          { id: 'part-60', role: 'assistant', content: 'Updated before its snapshot page' },
          { id: 'inserted', role: 'assistant', content: 'Inserted during hydration' }
        ] })
      }
      if (!page.hasMore) break
      after = page.cursor
    }
    report.phase = 'paged-delta-recovery'
    after = watermark
    let deltaWatermark
    let deltaPages = 0
    while (true) {
      const request = { version: 1, mode: 'delta', after, limit: 1, ...(deltaWatermark === undefined ? {} : { watermark: deltaWatermark }) }
      const page = await client.command('agentSession:getTranscriptPage', { taskId, page: request })
      validate(page, request, taskId)
      for (const part of page.parts) if (!parts.has(part.partId) || parts.get(part.partId).rev <= part.rev) parts.set(part.partId, part)
      deltaWatermark ??= page.watermark
      deltaPages++
      after = page.cursor
      if (!page.hasMore) break
    }
    assert.equal(parts.size, 642)
    assert.equal(parts.get('part-0').content, 'Updated after snapshot')
    assert.equal(parts.get('part-60').content, 'Updated before its snapshot page')
    assert.equal(parts.get('inserted').content, 'Inserted during hydration')
    assert.ok(parts.get('large').content.includes('full record remains saved'))
    assert.equal(parts.get('large').tool, undefined)
    assert.ok(largestPage > 128 * 1024)
    // The stored tool remains available through the legacy narrow read, proving no preview writeback.
    const large = await client.command('agentSession:getTranscriptSnapshot', { taskId, sinceSeq: 640 })
    assert.equal(large.find(part => part.partId === 'large').tool.output.length, 400_000)
    report.phase = 'authority-and-version-denial'
    await assert.rejects(client.command('agentSession:getTranscriptPage', { taskId: 'missing', page: { version: 1, mode: 'snapshot', after: 0 } }), { code: 'INVALID_REQUEST' })
    await assert.rejects(client.command('agentSession:getTranscriptPage', { taskId, page: { version: 2, mode: 'snapshot', after: 0 } }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(client.command('agentSession:getTranscriptPage', { taskId, page: { version: 1, mode: 'snapshot', after: 0, limit: 65 } }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(client.command('agentSession:getTranscriptPage', { taskId, page: { version: 1, mode: 'snapshot', after: 0, watermark: after + 1 } }), { code: 'STALE_EPOCH' })
    report.phase = 'shutdown'
    await client.request('engine.shutdown', {})
    assert.equal((await client.waitClosed()).code, 0)
    Object.assign(report, { passed: true, phase: 'complete', parts: parts.size, snapshotPages, deltaPages,
      largestPageBytes: largestPage, pageByteLimit: 256 * 1024, racingUpdatesRecovered: true,
      widePayloadsBounded: true,
      overflowInvalidations: invalidations.length, boundedLiveInvalidationRecovery: true,
      oversizedFieldPreviewOnly: true, missingTaskAndMalformedRequestsDenied: true, acknowledgedServiceExit: true })
  } catch (error) {
    report.errorCode = ['INVALID_RESULT', 'INVALID_REQUEST', 'INVALID_ARGUMENTS', 'FRAME_TOO_LARGE', 'STALE_EPOCH', 'TIMEOUT', 'DISCONNECTED'].includes(error.code) ? error.code : 'PROOF_FAILED'
  } finally {
    try { await client.stop(); await rm(profileRoot, { recursive: true, force: true }); report.syntheticProfileRemoved = true }
    catch { report.passed = false; report.syntheticProfileRemoved = false }
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runTranscriptPageProof({ serviceEntry: process.env.TAURI_DATABASE_SERVICE_ENTRY })
    console.log(JSON.stringify(report, null, 2))
    if (!report.passed) process.exitCode = 1
  } catch { console.error('Explicit staged transcript service unavailable.'); process.exitCode = 1 }
}
