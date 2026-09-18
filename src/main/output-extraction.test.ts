import { describe, it, expect } from 'vitest'
import { extractPartialJson, extractOutputFromMessages, collectWrittenFiles } from './output-extraction'
import type { OutputFieldRecord } from './database'
import type { SessionMessage } from './adapters/coding-agent-adapter'

type TestPart = { type: string; text?: string; tool?: { name: string }; state?: { status: string; input: Record<string, string> } }

function message(role: string, ...parts: TestPart[]): SessionMessage {
  return { id: `msg-${role}`, role, parts } as unknown as SessionMessage
}

const assistant = (...parts: TestPart[]): SessionMessage => message('assistant', ...parts)
const text = (value: string): TestPart => ({ type: 'text', text: value })
const toolCall = (tool: string, filePath: string, status = 'completed'): TestPart =>
  ({ type: 'tool', tool: { name: tool }, state: { status, input: { file_path: filePath } } })

const fields = [
  { id: 'f1', name: 'semantic categories', type: 'file', required: true },
  { id: 'f2', name: 'analysis', type: 'text', required: true },
  { id: 'f3', name: 'code', type: 'file', required: true }
] as OutputFieldRecord[]

const analysisOf = (messages: SessionMessage[]): unknown => extractOutputFromMessages(messages, fields)[1].value

describe('extractPartialJson', () => {
  it('extracts complete string pairs from truncated JSON', () => {
    const raw = '{\n  "key1": "value1",\n  "key2": "trun'
    expect(extractPartialJson(raw)).toEqual({ key1: 'value1' })
  })

  it('extracts literal values', () => {
    const raw = '{"count": 42, "active": true, "name": null}'
    const result = extractPartialJson(raw)
    expect(result.count).toBe(42)
    expect(result.active).toBe(true)
    expect(result.name).toBeNull()
  })
})

describe('collectWrittenFiles', () => {
  it('collects file paths from completed write tool calls', () => {
    const messages = [assistant(toolCall('Write', '/tmp/out.json'), toolCall('Read', '/tmp/in.json'))]
    expect(collectWrittenFiles(messages)).toEqual(['/tmp/out.json'])
  })

  it('skips incomplete tool calls', () => {
    expect(collectWrittenFiles([assistant(toolCall('Write', '/tmp/out.json', 'pending'))])).toEqual([])
  })
})

describe('extractOutputFromMessages', () => {
  it('extracts values from real agent output', () => {
    const messages = [assistant(text(`## Task Completion Summary

Done.

\`\`\`json
{
  "semantic categories": "/workspace/semantic_categories.json",
  "analysis": "Successfully implemented the algorithm.",
  "code": "/workspace/gl_mapping.py"
}
\`\`\``))]

    const result = extractOutputFromMessages(messages, fields)
    expect(result[0].value).toBe('/workspace/semantic_categories.json')
    expect(result[1].value).toBe('Successfully implemented the algorithm.')
    expect(result[2].value).toBe('/workspace/gl_mapping.py')
  })

  it('leaves fields unset when there are no assistant messages', () => {
    const result = extractOutputFromMessages([message('user', text('```json\n{"analysis": "x"}\n```'))], fields)
    expect(result.map((f) => f.value)).toEqual([undefined, undefined, undefined])
  })

  it('leaves fields unset when there is no JSON block and no written file', () => {
    expect(analysisOf([assistant(text('No JSON here'))])).toBeUndefined()
  })

  it('uses the first json block of a message', () => {
    expect(analysisOf([assistant(text('```json\n{"analysis": "first"}\n```\n```json\n{"analysis": "second"}\n```'))])).toBe('first')
  })

  it('falls back to a plain code block', () => {
    expect(analysisOf([assistant(text('Some text\n```\n{"analysis": "plain"}\n```'))])).toBe('plain')
  })

  it('prefers a json block over a plain block', () => {
    expect(analysisOf([assistant(text('```\n{"analysis": "plain"}\n```\n```json\n{"analysis": "typed"}\n```'))])).toBe('typed')
  })

  it('skips non-json fenced blocks such as python', () => {
    expect(analysisOf([assistant(text('```python\nprint("hello")\n```\n```json\n{"analysis": 42}\n```'))])).toBe(42)
  })

  it('recovers complete pairs from truncated JSON', () => {
    expect(analysisOf([assistant(text('```json\n{"analysis": "value", "other": "trun\n```'))])).toBe('value')
  })

  it('matches fields case-insensitively by name, then by id', () => {
    const result = extractOutputFromMessages([assistant(text('```json\n{"Semantic Categories": "val", "f2": "by id"}\n```'))], fields)
    expect(result[0].value).toBe('val')
    expect(result[1].value).toBe('by id')
  })

  it('falls back to written files for unfilled file fields', () => {
    const result = extractOutputFromMessages([
      assistant(text('```json\n{"analysis": "done"}\n```'), toolCall('Write', '/tmp/result.py'))
    ], fields)
    expect(result[1].value).toBe('done')
    expect(result[0].value).toBe('/tmp/result.py')
    expect(result[2].value).toBe('/tmp/result.py')
  })

  it('searches the last assistant message first', () => {
    expect(analysisOf([
      assistant(text('```json\n{"analysis": "old"}\n```')),
      assistant(text('```json\n{"analysis": "new"}\n```'))
    ])).toBe('new')
  })

  it('handles text split across multiple parts', () => {
    expect(analysisOf([assistant(text('Some summary\n```json\n{'), text('"analysis": "split value"}\n```'))])).toBe('split value')
  })
})
