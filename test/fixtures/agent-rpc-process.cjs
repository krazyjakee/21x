// Controlled protocol peer: no SDK, network, account, tools or credentials.
const { createInterface } = require('node:readline')
const { writeFileSync } = require('node:fs')
if (process.env.TWENTYX_SYNTHETIC_AGENT !== '1') process.exit(64)
if (process.argv.includes('--version')) { console.log('0.80.5'); process.exit(0) }
const mode = process.env.TWENTYX_FIXTURE_PROTOCOL || 'pi'
const sessionId = `synthetic-native-session-${process.pid}`
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (request, result = {}) => out(mode === 'pi'
  ? { type: 'response', command: request.type, id: request.id, success: true, data: result }
  : { jsonrpc: '2.0', id: request.id, result })
process.on('SIGTERM', () => {}) // Force the real escalation path.
const receipt = { pid: process.pid, runtime: process.execPath,
  electron: !!process.versions.electron, path: process.env.PATH,
  secretInjected: process.env.TWENTYX_FIXTURE_SECRET === 'synthetic-only-211', promptCount: 0 }
const saveReceipt = () => writeFileSync(process.env.TWENTYX_FIXTURE_RECEIPT, JSON.stringify(receipt))
saveReceipt()
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (mode === 'pi') {
    if (request.type === 'get_state' && process.argv.some(arg => arg.includes('TWENTYX_SYNTHETIC_CREATE_FAIL'))) out({ type: 'response', command: 'get_state', id: request.id, success: false, error: 'Synthetic startup rejection' })
    else if (request.type === 'get_state') reply(request, { sessionId, isStreaming: true })
    else if (request.type === 'get_messages') reply(request, { messages: [] })
    else if (request.type === 'prompt') {
      receipt.promptCount++
      receipt.recapReceived = /Synthetic retained reply/.test(request.message)
      receipt.remainingIntentReceived = /Remaining intent:/.test(request.message)
      saveReceipt()
      out({ type: 'agent_start' })
      if (process.argv.some(arg => arg.includes('TWENTYX_SYNTHETIC_QUOTA'))) {
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Synthetic retained reply' } })
        out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'insufficient_quota', content: [{ type: 'text', text: 'Synthetic retained reply' }] } })
        out({ type: 'agent_settled' })
        return
      }
      out({ type: 'extension_ui_request', id: 'native-permission-211', method: 'confirm', title: 'Synthetic permission', message: 'Allow the synthetic action?' })
    } else if (request.type === 'extension_ui_response' && request.id === 'native-permission-211' && !request.cancelled) {
      out({ type: 'extension_ui_request', id: 'native-question-211', method: 'input', title: 'Synthetic answer', message: 'Choose a synthetic value' })
    } else if (request.type === 'extension_ui_response' && request.id === 'native-question-211' && !request.cancelled) {
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Synthetic retained reply' } })
      out({ type: 'tool_execution_start', toolCallId: 'tool-211', toolName: 'synthetic-tool', args: {} })
      out({ type: 'tool_execution_end', toolCallId: 'tool-211', toolName: 'synthetic-tool', isError: true,
        result: { content: [{ type: 'text', text: 'Synthetic tool failure' }] } })
      out({ type: 'auto_compaction_end', id: 'compact-211', result: { summary: 'Synthetic compaction', tokensBefore: 9000, estimatedTokensAfter: 1000 } })
      // Deliberately stay busy: the abort response must not imply settlement.
    } else if (request.id) reply(request)
  } else if (request.id !== undefined) {
    if (request.method === 'initialize') reply(request, { protocolVersion: 1, authMethods: [] })
    else if (request.method === 'session/new') reply(request, { sessionId })
    else if (request.method === 'thread/start') reply(request, { thread: { id: sessionId } })
    else if (request.method === 'thread/read') reply(request, { thread: { id: sessionId, turns: [] } })
    else reply(request, { data: [] })
  }
})
