import { setTimeout as delay } from 'node:timers/promises'
import { type CodingAgentAdapter, type SessionConfig, MessagePartType, SessionStatusType } from '../main/adapters/coding-agent-adapter'
import { ProductionAdapters } from './production-adapters'

/** Explicit live harness only. No account access occurs merely by importing it. */
export async function proveAgentBackend(adapter: CodingAgentAdapter, config: SessionConfig, signal = new AbortController().signal) {
  const owner = new ProductionAdapters(), owned = owner.wrap(adapter)!
  const report = { passed: false, phase: 'initialize', created: false, health: false, sent: false,
    streamedText: false, status: false, abortAccepted: false, abortSettled: false, stopped: false,
    resumed: false, resumedReply: false, teardownAcknowledged: false, pendingNativeRequest: false, cancelled: false }
  let id: string | undefined
  const marker = 'SYNTHETIC_211_OK'
  const check = () => { if (signal.aborted) throw new Error('LIVE_PROOF_CANCELLED') }
  const waitForIdle = async (requireText: boolean): Promise<boolean> => {
    const deadline = Date.now() + 120_000
    let sawText = false
    const seenMessages = new Set<string>(), seenParts = new Set<string>(), lengths = new Map<string, string>()
    while (Date.now() < deadline) {
      check()
      const parts = await owned.pollMessages(id!, seenMessages, seenParts, lengths, config)
      sawText ||= parts.some(part => part.type === MessagePartType.TEXT && part.text?.includes(marker))
      const status = await owned.getStatus(id!, config)
      if (status.type === SessionStatusType.WAITING_APPROVAL) {
        report.pendingNativeRequest = true
        throw new Error('LIVE_PROOF_PENDING_HUMAN_DECISION')
      }
      if (status.type === SessionStatusType.ERROR) throw new Error('LIVE_PROOF_PROVIDER_ERROR')
      if (status.type === SessionStatusType.IDLE) {
        if (requireText && !sawText) throw new Error('LIVE_PROOF_MISSING_REPLY')
        return sawText
      }
      await delay(100)
    }
    throw new Error('LIVE_PROOF_UNSETTLED')
  }
  const prompt = [{ type: MessagePartType.TEXT, text: `Reply with exactly ${marker}. Do not call tools, access files or run commands.` }]
  try {
    check()
    await owned.initialize()
    check()
    report.phase = 'create'; id = await owned.createSession(config); report.created = !!id
    // OpenCode health must address the server selected by create, not port 4096.
    report.phase = 'health'; report.health = (await owned.checkHealth()).available
    if (!report.health) throw new Error('LIVE_PROOF_UNHEALTHY')
    report.phase = 'send'; await owned.sendPrompt(id, prompt, config); report.sent = true
    report.streamedText = await waitForIdle(true); report.status = true
    report.phase = 'interrupt'; await owned.sendPrompt(id, prompt, config)
    if ((await owned.getStatus(id, config)).type !== SessionStatusType.BUSY) throw new Error('LIVE_PROOF_NO_ACTIVE_TURN')
    await owned.abortPrompt(id, config); report.abortAccepted = true
    await waitForIdle(false); report.abortSettled = true
    report.phase = 'stop'; await owned.destroySession(id, config); report.stopped = true
    report.phase = 'resume'; await owned.resumeSession(id, config); report.resumed = true
    await owned.sendPrompt(id, prompt, config); report.resumedReply = await waitForIdle(true)
    report.phase = 'teardown'
  } catch {
    // Provider errors/transcripts can contain account data; persist fixed phases only.
  } finally {
    try { await owner.close(); report.teardownAcknowledged = true } catch { report.teardownAcknowledged = false }
    report.cancelled = signal.aborted
  }
  report.passed = report.created && report.health && report.sent && report.streamedText && report.status &&
    report.abortAccepted && report.abortSettled && report.stopped && report.resumed && report.resumedReply && report.teardownAcknowledged && !report.cancelled
  if (report.passed) report.phase = 'complete'
  return report
}
