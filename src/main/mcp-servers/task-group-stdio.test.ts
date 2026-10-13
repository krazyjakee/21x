import { describe, expect, it, vi } from 'vitest'
import { forwardTaskGroupTool, signedTaskMcpForwarding } from './task-group-stdio'

const api = 'http://127.0.0.1:4999'
const url = `${api}/mcp?token=token&project=project&task=anchor&agent=agent&session=nonce&scope_signature=${'a'.repeat(64)}`
describe('signed task-group stdio forwarding', () => {
  it('derives advertised scope from the exact app URL and does not invent authority from environment scope', () => {
    expect(signedTaskMcpForwarding(undefined, api)).toBeNull()
    expect(signedTaskMcpForwarding(url, api)?.scope).toEqual({ parentTaskId: null, projectId: 'project', taskId: 'anchor', artifactTaskId: 'anchor', agentId: 'agent', sessionNonce: 'nonce' })
    for (const invalid of [url.replace('/mcp?', '/create_task_group?'), url.replace('127.0.0.1', 'example.invalid'), url.replace(':4999', ':5000'), url.replace('scope_signature=', 'not_a_signature='), url + '#fragment']) {
      expect(() => signedTaskMcpForwarding(invalid, api)).toThrow('app-issued')
    }
  })
  it('forwards tools/call to the signed endpoint instead of authorizing a plain JSON route or body scope', async () => {
    const result = { content: [{ type: 'text', text: '{"progress":"done"}' }] }
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }))
    const forwarding = signedTaskMcpForwarding(url, api)!
    const args = { group_id: 'group', task_id: 'member', state: 'done', message: 'Implemented', trustedScope: { taskId: 'spoofed' } }
    expect(await forwardTaskGroupTool(forwarding, 'report_group_task', args, fetcher)).toEqual(result)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe(url)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_group_task', arguments: args } })
  })
  it('fails closed on missing credentials, forbidden names, rejected signatures or malformed responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }))
    expect((await forwardTaskGroupTool(null, 'create_task_group', {}, fetcher)).isError).toBe(true)
    expect((await forwardTaskGroupTool(signedTaskMcpForwarding(url, api), 'update_task', {}, fetcher)).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await forwardTaskGroupTool(signedTaskMcpForwarding(url, api), 'create_task_group', {}, fetcher)).isError).toBe(true)
    fetcher.mockResolvedValue(new Response(JSON.stringify({ result: { content: [{ type: 'image', data: 'untrusted' }] } }), { status: 200 }))
    expect((await forwardTaskGroupTool(signedTaskMcpForwarding(url, api), 'create_task_group', {}, fetcher)).isError).toBe(true)
  })
})
