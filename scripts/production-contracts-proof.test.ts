import { describe, expect, it } from 'vitest'
import { createProductionRequestCorpus, PROOF_COMMAND_CODECS, writeProductionRequestCorpus } from './production-contracts-proof'
import { isRecord } from '../src/shared/service-protocol'
import { PRODUCTION_COMMAND_CODECS } from '../src/service/production-desktop-bindings'

describe('actual production TypeScript-to-native golden request corpus', () => {
  it('uses the actual production override map and encodes all 86 finite command fixtures', () => {
    const corpus = createProductionRequestCorpus()
    expect(corpus.operations).toEqual(Object.keys(PRODUCTION_COMMAND_CODECS).sort())
    expect(corpus.operations).toHaveLength(86)
    expect(new Set(corpus.requests.map(row => row.operation))).toEqual(new Set(corpus.operations))
    for (const row of corpus.requests) {
      const codec = PRODUCTION_COMMAND_CODECS[row.operation as keyof typeof PRODUCTION_COMMAND_CODECS]
      expect(codec.validateArguments(codec.decodeArguments(row.payload)), `${row.operation}/${row.case}`).toBe(true)
    }
  })
  it('includes nested transcript paging, optional metadata and image/tool history cases rather than generic data', () => {
    const corpus = createProductionRequestCorpus()
    expect(corpus.requests.find(row => row.operation === 'agentSession:getTranscriptPage' && row.case === 'baseline')?.payload).toEqual({ taskId: 'task_fixture', page: { version: 1, mode: 'snapshot', after: 0 } })
    expect(corpus.requests.some(row => row.case === 'all-optional-fields' && row.operation === 'skills:create')).toBe(true)
    expect(corpus.requests.find(row => row.case === 'nullable-git-fields')?.payload).toEqual({ id: 'project_fixture', data: { git_provider: null, git_org: null } })
    expect(corpus.requests.some(row => row.case === 'tool-history')).toBe(true)
    const large = corpus.requests.find(row => row.case === 'frame-bounded-large-config')!
    expect(Buffer.byteLength(JSON.stringify(large.payload))).toBeGreaterThan(900_000)
    expect(Buffer.byteLength(JSON.stringify(large.payload))).toBeLessThan(1024 * 1024 - 1024)
    const image = corpus.requests.find(row => row.case === 'image-only')?.payload
    expect(image).toMatchObject({ sessionId: 'session_fixture', text: '', images: { version: 1, images: [{ encoding: 'base64', byteLength: 12 }] } })
  })
  it('rejects an added payload authority grant through every actual TypeScript codec', () => {
    const corpus = createProductionRequestCorpus()
    for (const row of corpus.requests) {
      expect(isRecord(row.payload)).toBe(true)
      const codec = PROOF_COMMAND_CODECS[row.operation as keyof typeof PROOF_COMMAND_CODECS]
      expect(() => codec.decodeArguments({ ...(row.payload as Record<string, unknown>), authority: { namespace: '*' } } as never), `${row.operation}/${row.case}`).toThrow()
    }
  })
  it('exports the validated corpus only when the coordinator selects an artifact path', async () => {
    const path = process.env.TWENTYONEX_PRODUCTION_CONTRACTS_OUT
    if (!path) return
    const corpus = await writeProductionRequestCorpus(path)
    expect(corpus.operations).toHaveLength(86)
  })
})
