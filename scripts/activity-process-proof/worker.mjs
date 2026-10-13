import { createInterface } from 'node:readline'

// This is a controlled local backend, never a model or SDK transport. It
// accepts only the fixed synthetic RPC vocabulary and produces no timers,
// text cadence, network activity or filesystem writes.
if (process.argv.length !== 3 || process.argv[2] !== '--synthetic-activity-fixture') process.exit(2)
let busy = false
let turn = 0
let pending = []
let observations = 0
const input = createInterface({ input: process.stdin, terminal: false })
input.on('line', line => {
  if (line.length > 4096) process.exit(2)
  let request
  try { request = JSON.parse(line) } catch { process.exit(2) }
  if (!request || !Number.isSafeInteger(request.id) || request.id < 1 || typeof request.method !== 'string'
    || Object.keys(request).some(key => !['id', 'method'].includes(key))) process.exit(2)
  let result
  switch (request.method) {
    case 'ping': result = { alive: true }; break
    case 'start':
      busy = true
      turn++
      pending = [{ id: `synthetic-tool-${turn}`, type: 'tool', role: 'assistant', tool: {
        name: 'synthetic_operation', status: 'running', input: '{}'
      } }]
      result = { accepted: true }
      break
    case 'poll': result = { parts: pending }; pending = []; break
    case 'status': result = { type: busy ? 'busy' : 'idle', observation: ++observations }; break
    case 'complete':
      busy = false
      pending = [{ id: `synthetic-tool-${turn}`, type: 'tool', role: 'assistant', update: true,
        tool: { name: 'synthetic_operation', status: 'completed', output: 'Controlled operation completed.' } },
      { id: `synthetic-answer-${turn}`, type: 'text', role: 'assistant', text: 'Controlled turn completed.' }]
      result = { completed: true }
      break
    case 'abort': busy = false; pending = []; result = { cancelled: true }; break
    case 'destroy':
      process.stdout.write(JSON.stringify({ id: request.id, result: { destroyed: true } }) + '\n', () => { input.close(); process.exit(0) })
      return
    default: process.exit(2)
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
})
input.on('close', () => process.exit(0))
