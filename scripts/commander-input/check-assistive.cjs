/* Single-page assistive exercise. DOM evidence does not certify Orca output:
 * correlate ASSISTIVE_STEP / ASSISTIVE_LIVE timestamps with the reader log.
 * Input and IPC are controlled; the output ring uses generated PCM and the
 * production Web Audio driver. No microphone, model or provider is contacted.
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')

if (!process.env.COMMANDER_INPUT_URL || !process.env.COMMANDER_INPUT_PROFILE) throw new Error('Run through run.mjs --assistive')
app.setPath('userData', process.env.COMMANDER_INPUT_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
if (process.env.COMMANDER_SCREEN_READER === '1') app.commandLine.appendSwitch('force-renderer-accessibility')
const dwell = Math.min(5_000, Math.max(500, Number(process.env.COMMANDER_ASSISTIVE_STEP_MS) || 2_000))
const startedAt = Date.now()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (kind, data) => console.log(kind, JSON.stringify({ timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...data }))
const field = 'textarea[aria-label="Message the Commander"]'
const polite = '[data-testid="commander-polite-announcer"]'
const urgent = '[data-testid="commander-assertive-announcer"]'
let win
let wc
let navigations = 0
let pageLoads = 0
const failures = []
const js = code => wc.executeJavaScript(code, true)
async function wait(expression, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await js(expression)) return
    await pause(40)
  }
  throw new Error('Timed out: ' + expression)
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode.length === 1 || keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await pause(50)
}
async function focus(selector) {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  assert(await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if (el.disabled || el.closest('[hidden]')) return false; el.focus(); return document.activeElement===el })()`), 'Control must be enabled, visible and keyboard focusable: ' + selector)
}
async function activate(selector) { await focus(selector); await key('Enter') }
async function textButton(text, within = 'document') {
  const selector = await js(`(() => {const scope=${within}; const el=[...scope.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}); if (!el) return null; el.dataset.assistiveTarget='true'; return '[data-assistive-target="true"]' })()`)
  assert(selector, 'Missing button: ' + text)
  try { await activate(selector) } finally { await js(`document.querySelector('[data-assistive-target="true"]')?.removeAttribute('data-assistive-target')`) }
}
const emit = event => js(`window.fixture.emit(${JSON.stringify(event)})`)
const turn = (turnId, sessionId = 'session-1') => emit({ type: 'turn_started', sessionId, turnId })
const runtime = (turnId, event, sessionId = 'session-1') => emit({ type: 'turn_event', sessionId, turnId, event })
const message = (id, content, fields = {}) => ({ id, session_id: 'session-1', role: 'assistant', content, tool_calls: null, tool_call_id: null, tool_name: null, is_error: false, project_id: null, correlation_id: null, created_at: Date.now(), ...fields })
const append = (turnId, messages, sessionId = 'session-1') => emit({ type: 'messages_appended', sessionId, turnId, messages })
const finish = (turnId, stopReason = 'end_turn') => runtime(turnId, { type: 'done', stopReason })
const liveIndex = () => js('window.fixture.assistiveLiveLog.length')
const connectionErrorCount = () => js(`window.fixture.assistiveLiveLog.filter(row=>row.region==='assertive'&&row.text==='Commander error: The connection was lost. Retry the reply or type instead.').length`)
async function noLiveSince(index, reason) {
  await pause(150)
  assert.deepEqual(await js(`window.fixture.assistiveLiveLog.slice(${index})`), [], reason)
}
async function snapshot() {
  return js(`(() => {
    const text=selector=>document.querySelector(selector)?.textContent.trim()??null;
    const active=document.activeElement;
    return {call:window.fixture.callState(),stage:document.querySelector('[data-testid="commander-stage"]')?.dataset.callState??null,
      presence:text('[data-testid="commander-presence-state"]'),pip:text('[data-testid="commander-pip-state"]'),
      caption:text('.commander-caption-text'),captionSurfaces:document.querySelectorAll('[data-testid="commander-voice-status"]').length,
      polite:text(${JSON.stringify(polite)}),assertive:text(${JSON.stringify(urgent)}),
      liveOwners:document.querySelectorAll('[data-testid="commander-call-announcer"]').length,
      dialog:text('[role="dialog"]'),focus:{tag:active?.tagName,label:active?.getAttribute('aria-label'),text:active?.textContent.trim().slice(0,120)},
      messages:document.querySelectorAll('[data-testid="commander-messages"] [data-testid="commander-report"]').length,
      sends:window.fixture.sends.length,voiceSends:window.fixture.voiceSends.length,undos:window.fixture.undos.length,
      mutations:window.fixture.assistiveLiveLog.length}
  })()`)
}
async function step(name, body) {
  log('ASSISTIVE_STEP', { step: name, phase: 'begin', dom: await snapshot() })
  try {
    await body()
    await pause(dwell)
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-call-announcer"]').length`), 1, 'One app-owned announcer')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-call-announcer"] [aria-live]').length`), 2, 'One polite and one assertive owner')
    assert.equal(pageLoads, 1, 'Assistive exercise must keep the same loaded document')
    assert.equal(navigations, 1, 'Workspace transitions must not navigate the loaded document')
    log('ASSISTIVE_STEP', { step: name, phase: 'passed', dom: await snapshot() })
  } catch (error) {
    failures.push(name)
    log('ASSISTIVE_STEP', { step: name, phase: 'failed', error: String(error), dom: await snapshot().catch(() => null) })
  }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1200, height: 900, show: true, title: 'Commander assistive exercise', webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  wc = win.webContents
  const url = new URL(process.env.COMMANDER_INPUT_URL)
  url.searchParams.set('assistive', '1')
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url.origin + '/') && !details.url.startsWith('devtools:') }))
  wc.on('console-message', (_event, level, text) => {
    if (text.startsWith('ASSISTIVE_LIVE ')) console.log(text)
    else if (level >= 2) log('ASSISTIVE_CONSOLE', { level, message: text })
  })
  wc.on('did-start-navigation', (_event, target, _inPlace, isMainFrame) => {
    if (isMainFrame) log('ASSISTIVE_NAVIGATION', { number: ++navigations, url: target })
  })
  wc.on('did-finish-load', () => log('ASSISTIVE_LOAD', { number: ++pageLoads }))
  wc.on('render-process-gone', (_event, details) => { log('ASSISTIVE_CRASH', details); app.exit(1) })
  log('ASSISTIVE_START', { forcedAccessibility: process.env.COMMANDER_SCREEN_READER === '1', dwellMs: dwell, input: 'controlled capture and IPC', output: 'generated PCM through production Web Audio', readerGate: 'Review actual reader utterances separately; DOM assertions alone do not establish a screen-reader pass.' })
  // Exactly one loadURL: navigation below only changes the app's workspace.
  await win.loadURL(url.href)
  await wait(`window.fixture.permission && document.querySelector(${JSON.stringify(field)}) && document.querySelector(${JSON.stringify(polite)})?.textContent.includes('Microphone access is blocked')`, 25_000)
  await js(`(() => {
    window.fixture.assistiveLiveLog=[];
    const root=document.querySelector('[data-testid="commander-call-announcer"]');
    const record=region=>{const row={timestamp:new Date().toISOString(),elapsedMs:performance.now(),region:region.getAttribute('aria-live'),text:region.textContent.trim()};window.fixture.assistiveLiveLog.push(row);console.log('ASSISTIVE_LIVE '+JSON.stringify(row))};
    for(const region of root.querySelectorAll('[aria-live]')) if(region.textContent.trim())record(region);
    window.fixture.assistiveObserver=new MutationObserver(records=>{
      const regions=new Set();for(const mutation of records){const el=mutation.target.nodeType===Node.ELEMENT_NODE?mutation.target:mutation.target.parentElement;const region=el?.closest('[aria-live]');if(region)regions.add(region)}
      for(const region of regions)record(region);
    });window.fixture.assistiveObserver.observe(root,{subtree:true,childList:true,characterData:true});
  })()`)
  await step('unavailable reason and keyboard composer', async () => {
    assert.equal(await js(`document.querySelector('[data-testid="commander-stage"]').dataset.callState`), 'unavailable')
    const before = await liveIndex()
    await js(`window.fixture.permission('denied')`)
    await focus(field)
    for (const character of 'Retained reader draft') await key(character)
    await noLiveSince(before, 'Unchanged unavailable reason must not announce twice')
  })
  await step('listening with silent partial captions', async () => {
    await js(`window.fixture.permission('granted')`)
    await activate('[aria-label="Turn voice mode on"]')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='listening'`)
    const before = await liveIndex()
    await js(`window.fixture.partial('PARTIAL WORDS MUST STAY SILENT')`)
    await wait(`document.querySelector('.commander-caption-text')?.textContent.includes('PARTIAL WORDS')`)
    await noLiveSince(before, 'Recognition partial must not enter either live region')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-voice-status"]').length`), 1)
  })
  await step('caption dialog keyboard sizes, focus containment and return', async () => {
    const before = await liveIndex()
    await activate('[aria-label="Read full captions"]')
    await wait(`document.querySelector('[role="dialog"]')`)
    await focus('[role="dialog"] [aria-label="Caption size"]')
    await key('End')
    await wait(`document.querySelector('[role="dialog"] [aria-label="Caption size"]').value==='large'`)
    assert.equal(await js(`parseFloat(getComputedStyle(document.querySelector('.commander-caption-full')).fontSize)`), 18)
    await key('Home')
    await wait(`document.querySelector('[role="dialog"] [aria-label="Caption size"]').value==='small'`)
    assert.equal(await js(`parseFloat(getComputedStyle(document.querySelector('.commander-caption-full')).fontSize)`), 13)
    await key('Down')
    await wait(`document.querySelector('[role="dialog"] [aria-label="Caption size"]').value==='medium'`)
    assert.equal(await js(`parseFloat(getComputedStyle(document.querySelector('.commander-caption-full')).fontSize)`), 14)
    for (let index = 0; index < 5; index++) { await key('Tab'); assert(await js(`!!document.activeElement.closest('[role="dialog"]')`)) }
    await key('Escape')
    await wait(`!document.querySelector('[role="dialog"]') && document.activeElement.ariaLabel==='Read full captions'`)
    assert.equal(await js('window.fixture.callState().status'), 'live')
    await noLiveSince(before, 'Opening or sizing a partial caption must not announce its words')
  })
  await step('subsecond thinking cancelled before delayed cue', async () => {
    await js(`window.fixture.partial('')`)
    await activate('[aria-label="Mute microphone"]')
    const before = await liveIndex()
    await turn('short-thinking')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='thinking'`)
    await pause(300)
    await append('short-thinking', [message('cancelled-partial', 'CANCELLED PARTIAL MUST STAY SILENT')])
    await finish('short-thinking', 'cancelled')
    await pause(1_100)
    await noLiveSince(before, 'Cancelling before one second must cancel thinking and partial-final announcements')
  })
  await step('one-second thinking then cancelled: one cue and no final speech', async () => {
    const before = await liveIndex()
    await turn('reader-thinking-cancelled')
    await wait(`window.fixture.assistiveLiveLog.slice(${before}).some(row=>row.region==='polite'&&row.text==='Commander is thinking.')`)
    log('ASSISTIVE_STATE', { step: 'thinking-before-cancellation', dom: await snapshot() })
    await pause(dwell)
    assert.equal(await js(`window.fixture.assistiveLiveLog.slice(${before}).filter(row=>row.text==='Commander is thinking.').length`), 1)
    const announced = await liveIndex()
    await append('reader-thinking-cancelled', [message('thinking-cancelled-row', 'CANCELLED THINKING REPLY MUST STAY SILENT')])
    await finish('reader-thinking-cancelled', 'cancelled')
    await noLiveSince(announced, 'Cancelling after the thinking cue must not read the unfinished reply')
  })
  await step('one-second thinking cue once, then genuine tool working', async () => {
    const thinkingIndex = await liveIndex()
    await turn('working-turn')
    await wait(`window.fixture.assistiveLiveLog.slice(${thinkingIndex}).some(row=>row.region==='polite'&&row.text==='Commander is thinking.')`)
    const before = await liveIndex()
    await runtime('working-turn', { type: 'text_delta', text: 'TOOL PREFIX MUST STAY SILENT' })
    await runtime('working-turn', { type: 'tool_call_start', id: 'review-call', name: 'ask_captain', input: { project: 'Web', message: 'Review checkout' } })
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='working'`)
    await pause(1_100)
    await noLiveSince(before, 'Working must not repeat a thinking cue or read the tool prefix')
    await runtime('working-turn', { type: 'tool_call_result', id: 'review-call', name: 'ask_captain', content: 'Review requested.', isError: false })
    await append('working-turn', [message('tool-prefix', 'TOOL PREFIX MUST STAY SILENT', { tool_calls: [{ id: 'review-call', name: 'ask_captain', input: { project: 'Web' } }] })])
    await finish('working-turn')
  })
  await step('speaking uses actual output and does not duplicate sentence', async () => {
    await turn('spoken-turn')
    const before = await liveIndex()
    await runtime('spoken-turn', { type: 'text_delta', text: 'The checkout review is complete.' })
    await append('spoken-turn', [message('spoken-final', 'The checkout review is complete.')])
    await finish('spoken-turn')
    await js('window.fixture.speech(12)')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='speaking' && parseFloat(document.querySelector('[data-testid="commander-output-ring"]')?.style.getPropertyValue('--commander-level'))>.05`)
    assert.equal(await js(`document.querySelector('.commander-caption-strip mark').textContent`), 'The checkout review is complete.')
    await noLiveSince(before, 'An owned spoken reply must not also enter the reader live region')
  })
  await step('interrupted from keyboard Stop retains call', async () => {
    await activate('[aria-label="Stop the reply"]')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='interrupted'`)
    log('ASSISTIVE_STATE', { step: 'interrupted', dom: await snapshot() })
    assert.equal(await js('window.fixture.callState().status'), 'live')
    await wait(`!document.querySelector('[data-testid="commander-output-ring"]')`)
    assert(await js('window.fixture.bargeIns.length>0'))
  })
  await step('reply error once, cancelled partial never read, keyboard Retry', async () => {
    await turn('error-turn')
    await runtime('error-turn', { type: 'text_delta', text: 'FAILED PARTIAL MUST STAY SILENT' })
    await runtime('error-turn', { type: 'error', message: 'The connection was lost. Retry the reply or type instead.' })
    await wait(`document.querySelector(${JSON.stringify(urgent)}).textContent==='Commander error: The connection was lost. Retry the reply or type instead.'`)
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='error'`)
    log('ASSISTIVE_STATE', { step: 'reply-error', dom: await snapshot() })
    await pause(dwell)
    const before = await liveIndex()
    await append('error-turn', [message('failed-partial', 'FAILED PARTIAL MUST STAY SILENT')])
    await pause(100)
    await noLiveSince(before, 'Error persistence must not duplicate the error or read failed text')
    await textButton('Retry', `document.querySelector('[data-testid="commander-stage"]')`)
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState!=='error'`)
    await finish('error-turn', 'cancelled')
    assert.equal(await connectionErrorCount(), 1, 'Retry must retain the error occurrence identity')
  })
  await step('toolbar arrow navigation and keyboard caption toggle', async () => {
    await focus('[aria-label="Unmute microphone"]')
    await key('End')
    assert.equal(await js('document.activeElement.ariaLabel'), 'Turn voice mode off')
    await key('Home')
    assert.equal(await js('document.activeElement.ariaLabel'), 'Unmute microphone')
    await activate('[aria-label="Hide captions"]')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-voice-status"]').length`), 0)
    await activate('[aria-label="Show captions"]')
    await wait(`document.querySelector('[data-testid="commander-voice-status"]')`)
  })
  await step('single PiP caption, keyboard corner and navigation survival', async () => {
    await activate('[aria-label="Unmute microphone"]')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='listening'`)
    await js(`window.fixture.partial('PIP PARTIAL MUST STAY SILENT')`)
    const before = await liveIndex()
    await focus(field)
    await key('M', ['control', 'shift'])
    await wait(`document.querySelector('[data-testid="commander-pip"]')`)
    await focus('[aria-label="Move Commander call"]')
    await key('Up'); await key('Left')
    assert(await js(`!!document.querySelector('.commander-pip-top-left')`))
    await js(`window.fixture.navigate('tasks')`)
    await wait(`document.querySelector('[data-testid="commander-pip"]') && !document.querySelector(${JSON.stringify(field)})`)
    assert.equal(await js('window.fixture.callState().status'), 'live')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-voice-status"]').length`), 1)
    assert.equal(await js(`document.querySelector('.commander-caption-text').textContent`), 'PIP PARTIAL MUST STAY SILENT')
    assert(await js(`!document.querySelector('[data-testid="voice-overlay"]')`))
    await activate('[data-testid="commander-pip-expand"]')
    await wait(`document.querySelector(${JSON.stringify(field)}) && !document.querySelector('[data-testid="commander-pip"]')`)
    await wait(`document.activeElement===document.querySelector(${JSON.stringify(field)})`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(field)}).value`), 'Retained reader draft')
    await noLiveSince(before, 'Moving between PiP and full must not announce partial captions')
    assert.equal(await connectionErrorCount(), 1, 'PiP/navigation must not reannounce the retained error')
  })
  await step('sessions drawer traps keyboard focus and restores Sessions', async () => {
    await activate('[aria-label="Open Commander sessions"]')
    await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('Commander sessions')`)
    assert.equal(await js(`document.querySelectorAll('[role="dialog"] ul[aria-label="Commander sessions"] li').length`), 2)
    for (let index = 0; index < 12; index++) { await key('Tab'); assert(await js(`!!document.activeElement.closest('[role="dialog"]')`)) }
    await key('Escape')
    await wait(`!document.querySelector('[role="dialog"]') && document.activeElement.ariaLabel==='Open Commander sessions'`)
  })
  await step('quiet durable report: one arrival cue, explicit inbox read', async () => {
    const report = message('quiet-report', 'REPORT CONTENT MUST NOT BE SPOKEN. Checkout is ready for review.', { session_id: 'report-inbox', role: 'report', project_id: 'web' })
    await append(undefined, [report], 'report-inbox')
    const inbox = await js(`window.fixture.sessions.find(session=>session.id==='report-inbox')`)
    await emit({ type: 'session_updated', session: { ...inbox, unread_count: 1 } })
    await wait(`document.querySelector(${JSON.stringify(polite)}).textContent==='New project report in Project reports.'`)
    const before = await liveIndex()
    await append(undefined, [report], 'report-inbox')
    await activate('[aria-label="Project reports, 1 unread"]')
    await wait(`document.querySelector('[data-testid="commander-report"]')?.textContent.includes('REPORT CONTENT')`)
    await noLiveSince(before, 'Duplicate report/opening inbox must not repeat the arrival cue or speak content')
    assert.equal(await js('window.fixture.sends.length'), 0)
    assert.equal(await js('window.fixture.voiceSends.length'), 0)
    assert.equal(await js('window.fixture.callState().status'), 'live')
    assert(await js(`document.querySelector('[data-testid="commander-stage"]').textContent.includes('Call continues in Checkout review')`))
    await activate('[aria-label="Open Commander sessions"]')
    await js(`(() => { const row=[...document.querySelectorAll('[role="dialog"] ul[aria-label="Commander sessions"] li')].find(el=>el.textContent.includes('Checkout review')); if(!row)throw new Error('Checkout session missing');row.dataset.assistiveSession='true' })()`)
    await focus('[data-assistive-session="true"]')
    await key('Enter')
    await wait(`!document.querySelector('[role="dialog"]') && document.querySelector('.commander-workspace-header h1').textContent==='Checkout review'`)
    assert.equal(await connectionErrorCount(), 1, 'Returning from the inbox must not reannounce the retained error')
  })
  await step('executed action, one destructive cue, eight-second exact Undo toast', async () => {
    await js(`window.fixture.partial('')`)
    await turn('action-turn')
    const call = { id: 'reader-archive', name: 'archive_project', input: { project: 'Web' } }
    const content = JSON.stringify({ status: 'ok', target: { kind: 'project', id: 'web', name: 'Web' }, changes: [{ field: 'archived', before: false, after: true }], undoId: 'reader-exact-undo' })
    await runtime('action-turn', { type: 'tool_call_start', ...call })
    await runtime('action-turn', { type: 'tool_call_result', id: call.id, name: call.name, content, isError: false })
    await wait(`document.querySelector('[data-testid="commander-action-toast"]')`)
    await wait(`document.querySelector(${JSON.stringify(urgent)}).textContent.includes('Web')`)
    const before = await liveIndex()
    await append('action-turn', [message('action-owner', '', { tool_calls: [call] }), message('action-result', content, { role: 'tool', tool_name: call.name, tool_call_id: call.id })])
    await finish('action-turn')
    await activate('#commander-actions-tab')
    assert(await js(`document.querySelector('[role="tabpanel"] [data-testid="commander-action-card"]').textContent.includes('archived: false → true')`))
    await noLiveSince(before, 'Action persistence must not announce success twice')
    await textButton('Undo', `document.querySelector('[data-testid="commander-action-toast"]')`)
    await wait('window.fixture.undos.length===1')
    assert.deepEqual(await js('window.fixture.undos[0]'), { sessionId: 'session-1', actionId: 'reader-exact-undo' })
    await wait(`document.querySelector('[data-testid="commander-action-toast"]').textContent.includes('Undone')`)
    log('ASSISTIVE_STATE', { step: 'exact-action-undone', dom: await snapshot() })
    await wait(`!document.querySelector('[data-testid="commander-action-toast"]')`)
    await activate('#commander-chat-tab')
  })
  await step('End before spoken-final persistence never reannounces', async () => {
    await turn('end-before-store')
    await runtime('end-before-store', { type: 'text_delta', text: 'ALREADY SPOKEN BEFORE END' })
    await js('window.fixture.speech(3)')
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='speaking'`)
    await activate('[aria-label="Turn voice mode off"]')
    await wait(`window.fixture.callState().status==='off'`)
    const before = await liveIndex()
    await append('end-before-store', [message('ended-spoken-final', 'ALREADY SPOKEN BEFORE END')])
    await finish('end-before-store')
    await pause(100)
    await noLiveSince(before, 'End cannot erase per-turn speech intent before delayed persistence')
    assert.equal(await connectionErrorCount(), 1, 'End must not reannounce an earlier retained error')
  })
  await step('typed final with global TTS on/call off: wait for done, announce once', async () => {
    assert.equal(await js('window.fixture.callState().status'), 'off')
    const before = await liveIndex()
    await turn('reader-typed')
    await runtime('reader-typed', { type: 'text_delta', text: 'TYPED PARTIAL MUST STAY SILENT' })
    await append('reader-typed', [message('typed-final-reader', 'Your typed checkout review is complete.')])
    await pause(200)
    await noLiveSince(before, 'Stored bare reply must wait for the matching completion')
    await finish('reader-typed')
    await wait(`document.querySelector(${JSON.stringify(polite)}).textContent==='Commander replied: Your typed checkout review is complete.'`)
    const after = await liveIndex()
    await append('reader-typed', [message('typed-final-reader', 'Your typed checkout review is complete.')])
    await finish('reader-typed')
    await pause(100)
    await noLiveSince(after, 'Duplicate final/done must not read the answer twice')
  })
  await step('call-off tool prefix and cancelled/error partial finals remain silent', async () => {
    const before = await liveIndex()
    await turn('typed-tool-prefix')
    await append('typed-tool-prefix', [message('typed-tool-prefix-row', 'TYPED TOOL PREFIX MUST STAY SILENT', { tool_calls: [{ id: 'read-only-call', name: 'list_projects', input: {} }] })])
    await finish('typed-tool-prefix')
    await turn('typed-cancelled')
    await append('typed-cancelled', [message('typed-cancelled-row', 'CANCELLED TYPED PARTIAL MUST STAY SILENT')])
    await finish('typed-cancelled', 'cancelled')
    await pause(100)
    await noLiveSince(before, 'Call-off prefixes and cancelled stored partials must not be read')
    await turn('typed-failed')
    await runtime('typed-failed', { type: 'error', message: 'The typed review could not finish. Try again.' })
    await wait(`document.querySelector(${JSON.stringify(urgent)}).textContent==='Commander error: The typed review could not finish. Try again.'`)
    const errorIndex = await liveIndex()
    await append('typed-failed', [message('typed-failed-row', 'FAILED TYPED PARTIAL MUST STAY SILENT')])
    await finish('typed-failed', 'cancelled')
    await pause(100)
    await noLiveSince(errorIndex, 'Failed final must not read incomplete text or repeat its error')
  })
  await step('same error wording on a distinct turn is a new occurrence', async () => {
    await turn('new-connection-error')
    await runtime('new-connection-error', { type: 'error', message: 'The connection was lost. Retry the reply or type instead.' })
    await wait(`window.fixture.assistiveLiveLog.filter(row=>row.region==='assertive'&&row.text==='Commander error: The connection was lost. Retry the reply or type instead.').length===2`)
    log('ASSISTIVE_STATE', { step: 'new-turn-same-error', dom: await snapshot() })
    const before = await liveIndex()
    await finish('new-connection-error', 'cancelled')
    await noLiveSince(before, 'Completing the new failed turn must not repeat its error')
  })
  log('ASSISTIVE_RESULT', { failures, pageLoads, navigations, dom: await snapshot(), readerGate: 'Actual screen-reader utterances still require review.' })
  win.destroy()
  if (failures.length) throw new Error('Assistive DOM failures: ' + failures.join(', '))
  app.quit()
}).catch(error => { log('ASSISTIVE_FATAL', { error: String(error), pageLoads, navigations }); app.exit(1) })
