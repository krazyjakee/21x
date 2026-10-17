import { describe, expect, it } from 'vitest'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { MessagePartType, SessionStatusType } from '../main/adapters/coding-agent-adapter'
import { proveAgentBackend } from './agent-backend-proof'

const config = { agentId: 'synthetic', taskId: 'synthetic', workspaceDir: '/tmp/synthetic', authMethod: 'subscription' as const }
function fixture() {
  const adapter = new FakeAdapter()
  let prompts = 0, interrupted = false
  adapter.sendPrompt.mockImplementation(async () => { prompts++ })
  adapter.pollMessages.mockResolvedValue([{ type: MessagePartType.TEXT, text: 'SYNTHETIC_211_OK' }])
  adapter.getStatus.mockImplementation(async () => ({ type: prompts === 2 && !interrupted ? SessionStatusType.BUSY : SessionStatusType.IDLE }))
  adapter.abortPrompt.mockImplementation(async () => { interrupted = true })
  return adapter
}
describe('explicit backend proof runner', () => {
  it('does no provider work after cancellation', async () => {
    const adapter = fixture(), controller = new AbortController(); controller.abort()
    expect(await proveAgentBackend(adapter, config, controller.signal)).toMatchObject({ passed: false, cancelled: true, teardownAcknowledged: true })
    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.createSession).not.toHaveBeenCalled()
  })
  it('requires actual replies, a busy interrupt, settlement and a resumed reply before reporting success', async () => {
    const adapter = fixture(), report = await proveAgentBackend(adapter, config)
    expect(report).toMatchObject({ passed: true, phase: 'complete', abortSettled: true, resumedReply: true, teardownAcknowledged: true })
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(3)
    expect(adapter.destroySession).toHaveBeenCalledTimes(2)
  })
  it('reports a native pending decision without fabricating an answer and still retires the owner', async () => {
    const adapter = fixture()
    adapter.getStatus.mockResolvedValue({ type: SessionStatusType.WAITING_APPROVAL })
    const report = await proveAgentBackend(adapter, config)
    expect(report).toMatchObject({ passed: false, phase: 'send', pendingNativeRequest: true, streamedText: false, teardownAcknowledged: true })
    expect(adapter.respondToApproval).not.toHaveBeenCalled()
  })
  it('does not confuse an accepted abort with settled work or a teardown refusal with success', async () => {
    const adapter = fixture()
    adapter.abortPrompt.mockImplementation(async () => { adapter.getStatus.mockResolvedValue({ type: SessionStatusType.ERROR }) })
    adapter.destroySession.mockRejectedValue(new Error('synthetic private error'))
    const report = await proveAgentBackend(adapter, config)
    expect(report).toMatchObject({ passed: false, phase: 'interrupt', abortAccepted: true, abortSettled: false, teardownAcknowledged: false })
    expect(JSON.stringify(report)).not.toContain('private error')
  })
})
