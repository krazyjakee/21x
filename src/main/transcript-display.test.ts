import { describe, it, expect } from 'vitest'
import { transcriptDisplayPart, TRANSCRIPT_RECORD_BYTES } from './transcript-display'
import { measureIpcMessage } from './ipc-message-size'

describe('transcript display transport', () => {
  const part = { taskId: 't', partId: 'p', seq: 1, role: 'assistant', content: 'ok', rev: 1, createdAt: 1, updatedAt: 1, tool: { name: 'Read' } }

  it('passes normal and moderately large records through unchanged', () => {
    expect(transcriptDisplayPart(part)).toBe(part)
    const fileRead = { ...part, tool: { name: 'Read', status: 'completed', output: 'x'.repeat(200_000) } }
    expect(transcriptDisplayPart(fileRead)).toBe(fileRead)
  })

  it('bounds a huge text record without touching the stored object', () => {
    const large = { ...part, tool: undefined, content: 'x'.repeat(5 * 1024 * 1024) }
    const preview = transcriptDisplayPart(large)
    expect(preview.content).toContain('only a preview is displayed')
    expect(preview.rev).toBe(1)
    expect(preview.partId).toBe('p')
    expect(measureIpcMessage(preview, TRANSCRIPT_RECORD_BYTES).reason).toBeUndefined()
    expect(large.content.length).toBe(5 * 1024 * 1024)
  })

  it('keeps the tool card for a huge tool output and clips its strings', () => {
    const large = { ...part, content: '', partType: 'tool', tool: { name: 'Bash', status: 'completed', input: 'cat big.log', output: 'y'.repeat(5 * 1024 * 1024) } }
    const preview = transcriptDisplayPart(large)
    const tool = preview.tool as Record<string, string>
    expect(preview.partType).toBe('tool')
    expect(tool.name).toBe('Bash')
    expect(tool.status).toBe('completed')
    expect(tool.input).toBe('cat big.log')
    expect(tool.output).toContain('only a preview is displayed')
    expect(tool.output.length).toBeLessThan(10_000)
    expect(measureIpcMessage(preview, TRANSCRIPT_RECORD_BYTES).reason).toBeUndefined()
  })
})
