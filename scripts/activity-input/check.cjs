/* Native renderer audit only. Controlled IPC inputs are not proof of an SDK
 * poll or backend process. No activity derivation, clock or owner is mocked.
 * Run the existing Commander native suite separately for actual PCM output,
 * Stop/barge-in/drain and controlled capture ownership.
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

if (!process.env.ACTIVITY_INPUT_URL || !process.env.ACTIVITY_INPUT_PROFILE || !process.env.ACTIVITY_INPUT_OUTPUT) throw new Error('Use scripts/activity-input/run.mjs')
app.setPath('userData', process.env.ACTIVITY_INPUT_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
if (process.env.ACTIVITY_SCREEN_READER === '1') app.commandLine.appendSwitch('force-renderer-accessibility')
const output = process.env.ACTIVITY_INPUT_OUTPUT
const started = Date.now()
const records = []
const sourceLogs = []
const failures = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
let wc
let loads = 0
const log = (kind, data) => {
  const row = { timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, kind, ...data }
  records.push(row); console.log('ACTIVITY_NATIVE ' + JSON.stringify(row))
}
const js = code => wc.executeJavaScript(code, true)
async function wait(expression, timeout = 10_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await js(expression)) return
    await pause(40)
  }
  throw new Error('Timed out: ' + expression)
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode.length === 1 || keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await pause(60)
}
async function focus(selector) {
  await wait(`document.querySelector(${JSON.stringify(selector)})`)
  assert(await js(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); element.focus(); return document.activeElement===element && !element.disabled && element.getBoundingClientRect().width>0 })()`), 'Native focus target must be accessible: ' + selector)
}
async function activate(selector) { await focus(selector); await key('Enter') }
const status = (taskId, state, fields = {}) => js(`window.fixture.status(${JSON.stringify(taskId)},${JSON.stringify(state)},${JSON.stringify(fields)})`)
const commander = (event, fields = {}) => js(`window.fixture.commander(${JSON.stringify(event)},${JSON.stringify(fields)})`)
const startCommander = turnId => commander({ type: 'turn_started', sessionId: 'commander-session', turnId })
const toolCommander = turnId => commander({ type: 'turn_event', sessionId: 'commander-session', turnId, event: { type: 'tool_call_start', id: 'native-tool-' + turnId, name: 'shell', input: { command: 'controlled silent tool' } } })
const endCommander = (turnId, stopReason) => commander({ type: 'turn_event', sessionId: 'commander-session', turnId, event: { type: 'done', stopReason } })
const card = id => `[data-testid="task-card-${id}"] [data-activity-state]`
const expanded = kind => `[data-testid="expanded-${kind}"] [data-activity-state]`
async function snapshot() {
  return js(`(() => {
    const inspect=window.fixture.inspect(), now=inspect.now;
    const region=el=>el.closest('[data-testid="audit-topbar"]')?'top-bar':el.closest('[data-testid="audit-nav"]')?'nav-rail':el.closest('[data-testid="audit-status"]')?'status-bar':el.closest('[data-canvas-panel]')?'canvas':el.closest('.audit-board')?'board':el.closest('[data-testid="hero-captain-activity"]')?'hero':'expanded';
    const nodes=[...document.querySelectorAll('[data-activity-state]')].map(el=>({region:region(el),name:el.getAttribute('aria-label')??el.closest('button')?.getAttribute('aria-label')??el.getAttribute('title'),state:el.dataset.activityState,motion:el.dataset.activityMotion,text:el.textContent.trim(),accents:[...el.querySelectorAll('[data-accent]')].map(accent=>accent.dataset.accent),animations:[...el.querySelectorAll('*')].flatMap(child=>[getComputedStyle(child).animationName,getComputedStyle(child,'::after').animationName]).filter(name=>name&&name!=='none')}));
    return {visibility:document.visibilityState,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,dark:document.documentElement.classList.contains('dark'),nodes,
      observations:Object.fromEntries(Object.entries(inspect.session.sessions).map(([id,value])=>[id,{...value,ageMs:now-value.observedAt}])),
      sourceEpoch:inspect.commander.epoch,sourceSequences:inspect.commander.sequences,
      commander:Object.fromEntries(Object.entries(inspect.commander.sessions).map(([id,value])=>[id,{...value,ageMs:now-value.observedAt}])),
      agentEpoch:inspect.session.epoch,agentSequence:inspect.session.seq,queue:inspect.session.queue,agentCache:inspect.agentCache,deadlines:inspect.deadlines,call:inspect.call,
      running:document.querySelector('[data-testid="status-running"]')?.textContent.trim(),
      announcers:{activity:document.querySelectorAll('[data-testid="activity-announcer"]').length,commander:document.querySelectorAll('[data-testid="commander-call-announcer"]').length},
      live:{activity:document.querySelector('[data-testid="activity-announcer"]')?.textContent,polite:document.querySelector('[data-testid="commander-polite-announcer"]')?.textContent,assertive:document.querySelector('[data-testid="commander-assertive-announcer"]')?.textContent},
      pip:document.querySelector('[data-testid="commander-pip-state"]')?.textContent.trim(),stage:document.querySelector('[data-testid="commander-stage"]')?.dataset.callState,
      focus:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}};
  })()`)
}
function assertOwners(state) {
  const moving = state.nodes.filter(node => node.motion && node.motion !== 'none')
  for (const mirror of state.nodes.filter(node => ['top-bar', 'hero', 'nav-rail', 'status-bar'].includes(node.region))) {
    assert.equal(mirror.motion, 'none', mirror.region + ' mirror stays static')
    assert.deepEqual(mirror.animations, [], mirror.region + ' mirror has no CSS activity animation')
  }
  const board = moving.filter(node => node.region === 'board')
  const canvas = moving.filter(node => node.region === 'canvas')
  assert(board.length <= 1, 'One moving board indicator')
  assert(canvas.length <= 1, 'Only the frontmost canvas task may move')
  const entities = moving.map(node => node.name?.split(' — ')[0])
  assert.equal(new Set(entities).size, entities.length, 'One motion owner per mirrored entity')
  assert.equal(state.announcers.activity, 1, 'One task/Captain announcer')
  assert.equal(state.announcers.commander, 1, 'One Commander announcer')
}
async function evidence(name) {
  const state = await snapshot()
  log('receipt', { step: name, state })
  return state
}
async function step(name, body) {
  log('step', { step: name, phase: 'begin' })
  try {
    await body()
    const state = await evidence(name)
    assertOwners(state)
    assert.equal(loads, 1, 'All cross-surface cases retain the same native document')
    log('step', { step: name, phase: 'passed' })
  } catch (error) {
    failures.push(name)
    log('step', { step: name, phase: 'failed', error: String(error), state: await snapshot().catch(() => null) })
    await writeFile(join(output, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png'), (await wc.capturePage()).toPNG()).catch(() => {})
  }
}
async function motionPreference(reduced) {
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
  await wait(`matchMedia('(prefers-reduced-motion: reduce)').matches===${reduced}`)
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}
async function contrast() {
  return js(`(() => {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
    const color=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].map((n,index)=>index===3?n/255:n)};
    const blend=(over,under)=>over.slice(0,3).map((n,index)=>n*over[3]+under[index]*(1-over[3]));
    const background=el=>{const layers=[];for(let parent=el;parent;parent=parent.parentElement)layers.unshift(color(getComputedStyle(parent).backgroundColor));return layers.reduce((current,layer)=>blend(layer,current),[255,255,255])};
    const l=rgb=>rgb.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((sum,n,index)=>sum+n*[.2126,.7152,.0722][index],0);
    const ratio=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);
    return [...document.querySelectorAll('[data-activity-state]')].filter(el=>el.getBoundingClientRect().width>0).map(el=>{const bg=background(el),svg=el.querySelector('svg'),text=el.querySelector('span.truncate');return {name:el.getAttribute('aria-label')??el.closest('button')?.getAttribute('aria-label'),state:el.dataset.activityState,tone:el.className.match(/activity-tone-\\w+/)?.[0],icon:svg?ratio(blend(color(getComputedStyle(svg).color),bg),bg):null,text:text?ratio(blend(color(getComputedStyle(el).color),bg),bg):null}});
  })()`)
}

app.whenReady().then(async () => {
  await mkdir(output, { recursive: true })
  win = new BrowserWindow({ width: 1600, height: 1100, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  wc = win.webContents
  wc.on('did-finish-load', () => log('load', { number: ++loads }))
  wc.on('render-process-gone', (_event, details) => { log('crash', details); app.exit(1) })
  wc.on('console-message', (_event, level, text) => {
    if (text.startsWith('ACTIVITY_SOURCE ')) { sourceLogs.push(JSON.parse(text.slice('ACTIVITY_SOURCE '.length))); console.log(text) }
    else if (level >= 2) log('console', { level, message: text })
  })
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(process.env.ACTIVITY_INPUT_URL) && !details.url.startsWith('devtools:') }))
  log('scope', { inputs: 'Controlled stamped IPC/source observations', production: 'Actual board, canvas, shell, Commander/PiP, stores, derivation, monotonic clock, deadlines, motion owners and announcers', excluded: 'No SDK, real agent process, physical capture or provider proof; Commander PCM/Stop/drain remains in existing native suite', screenReaderGate: 'Native DOM/accessibility names are evidence only; actual reader audit is separate.' })
  await win.loadURL(process.env.ACTIVITY_INPUT_URL)
  await wait(`window.fixture.inspect && document.querySelector('[data-testid="task-card-task-ready"]') && document.querySelectorAll('[data-canvas-panel]').length===2`, 25_000)
  await js(`(() => {
    const regions=[document.querySelector('[data-testid="activity-announcer"]'),...document.querySelectorAll('[data-testid="commander-call-announcer"] [aria-live]')];
    window.fixture.liveObserver=new MutationObserver(changes=>{
      const changed=new Set();for(const change of changes){const element=change.target.nodeType===Node.ELEMENT_NODE?change.target:change.target.parentElement;const region=element?.closest('[aria-live]');if(region&&regions.includes(region))changed.add(region)}
      for(const region of changed)window.fixture.receipt('live-region',{owner:region.dataset.testid,politeness:region.getAttribute('aria-live'),text:region.textContent.trim()});
    });for(const region of regions)if(region)window.fixture.liveObserver.observe(region,{childList:true,characterData:true,subtree:true});
  })()`)
  wc.debugger.attach('1.3')
  await motionPreference(false)
  await step('hydration is static and agent health cannot bless a cached dead session', async () => {
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-ready'))}).dataset.activityState`), 'finished')
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-ready'))}).textContent.trim()`), 'Ready for review')
    assert.deepEqual(await js(`[...document.querySelector(${JSON.stringify(card('task-ready'))}).querySelectorAll('[data-accent]')].map(el=>el.dataset.accent)`), ['none'])
    await js('window.fixture.hydrateLegacy()')
    await js('window.electronAPI.agents.checkHealth("fixture-agent")')
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-one'))})`), null)
    assert.equal((await snapshot()).running, '0 running')
    assert.equal((await snapshot()).live.activity, '')
    await status('captain-audit', 'idle', { activityOutcome: 'completed' })
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('captain'))}).dataset.activityState`), 'idle', 'First sighting of a completed Captain is history, not a live finish')
    assert.equal(await js(`document.querySelector('[data-testid="expanded-captain"] [data-accent]')`), null)
    await js(`window.fixture.source={epoch:window.fixture.sourceEpoch,sequence:++window.fixture.sourceSequence,turnId:'historical-turn',phase:'idle',ageMs:0,openTools:[],hasText:true,outcome:'finished'};window.fixture.sourceAt=performance.now()`)
    win.hide(); await wait(`document.visibilityState==='hidden'`); win.show(); win.focus()
    await wait(`window.fixture.inspect().commander.sessions['commander-session']?.turnId==='historical-turn'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState`), 'idle', 'Snapshot hydration must not replay Commander finish')
    assert.equal(await js(`document.querySelector('[data-testid="expanded-commander"] [data-accent]')`), null)
  })
  await step('many cards and canvas mirrors have one motion owner per entity', async () => {
    await focus('[data-testid="task-card-task-one"]')
    await status('task-one', 'working'); await status('task-two', 'working'); await status('captain-audit', 'working')
    await startCommander('silent-tool'); await toolCommander('silent-tool')
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))})?.dataset.activityState==='running' && document.querySelector(${JSON.stringify(card('task-two'))})?.dataset.activityState==='running'`)
    await wait(`document.querySelectorAll('.audit-board [data-activity-motion="breathe"]').length===1`)
    assert.equal(await js(`document.querySelectorAll('[data-canvas-panel] [data-activity-state]').length`), 2, 'Canvas embedded task headers must not duplicate panel badges')
    assert(await js(`document.querySelector('[data-testid="hero-captain-activity"]')?.textContent.includes('Running')`))
    assert.equal((await snapshot()).running, '3 running')
    assert(await js(`document.activeElement===document.querySelector('[data-testid="task-card-task-one"]')`), 'Activity updates must not move keyboard focus')
  })
  await step('successful five-second observations keep an eighteen-second silent tool fresh', async () => {
    await js(`window.fixture.heartbeats={'task-one':'working','task-two':'working','captain-audit':'working'};window.fixture.sourceMode='live'`)
    const first = await evidence('silent tool before real elapsed wait')
    await pause(18_000)
    const after = await evidence('silent tool after eighteen seconds')
    assert(after.observations['task-one'].observedAt > first.observations['task-one'].observedAt)
    assert(after.commander['commander-session'].observedAt > first.commander['commander-session'].observedAt)
    assert(after.observations['task-one'].ageMs < 6_000)
    assert(after.commander['commander-session'].ageMs < 6_000)
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState`), 'tool')
    assert(await js(`!document.querySelector(${JSON.stringify(expanded('commander'))}).querySelector('[role="progressbar"],[aria-valuenow]')`), 'Tool shimmer must not imply measurable progress')
    assert.equal(after.running, '3 running')
    const reads = await js(`window.fixture.reads.filter(row=>row.kind==='commander').map(row=>row.at)`)
    assert(reads.length >= 4, 'Production shared source loop made multiple reads')
    for (let index = reads.length - 3; index < reads.length; index++) assert(reads[index] - reads[index - 1] <= 5_600, 'Controlled successful source is re-read at the five-second cadence')
  })
  await step('no new observation and a missed done expire at the fifteen-second deadline', async () => {
    await js(`window.fixture.heartbeats={};window.fixture.sourceMode='failed'`)
    await status('task-one', 'working', { heartbeat: true }); await status('task-two', 'working', { heartbeat: true }); await status('captain-audit', 'working', { heartbeat: true })
    await startCommander('missed-done'); await toolCommander('missed-done')
    const receipt = await evidence('expiry starts from final accepted receipts')
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))})?.dataset.activityState==='unknown' && document.querySelector(${JSON.stringify(expanded('commander'))})?.dataset.activityState==='unknown'`, 16_000)
    const expired = await evidence('expiry observed without a tick or clock stub')
    for (const id of ['task-one', 'task-two', 'captain-audit']) {
      assert(expired.observations[id].ageMs >= 15_000)
      assert(expired.observations[id].ageMs < 15_600, 'UI expiry permits only the scheduler margin and native dispatch delay')
      assert.equal(expired.observations[id].observedAt, receipt.observations[id].observedAt)
    }
    assert.equal(expired.running, '0 running')
    assert(expired.nodes.every(node=>node.motion==='none'))
    assert(await js(`document.querySelector(${JSON.stringify(card('task-one'))}).getAttribute('aria-label').includes('Last seen running')`))
    await js('window.electronAPI.agents.checkHealth("fixture-agent")')
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState`), 'unknown')
    assert.equal((await snapshot()).observations['task-one'].observedAt, receipt.observations['task-one'].observedAt)
  })
  await step('explicit disconnect immediately removes motion and shows unknown', async () => {
    await status('task-one', 'working')
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState==='running'`)
    const at = Date.now()
    await status('task-one', 'working', { disconnected: true })
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState==='unknown'`)
    assert(Date.now() - at < 1_000)
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityMotion`), 'none')
    await startCommander('disconnected-turn')
    await commander({ type: 'turn_event', sessionId: 'commander-session', turnId: 'disconnected-turn', event: { type: 'text_delta', text: 'Controlled lost transport.' } }, { phase: 'unknown', reason: 'Controlled IPC source disconnected' })
    await wait(`document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState==='unknown'`)
  })
  await step('real hidden/show/focus rechecks elapsed age before motion resumes', async () => {
    await status('task-one', 'working')
    await startCommander('hidden-turn'); await toolCommander('hidden-turn')
    await js(`window.fixture.sourceMode='deferred'`)
    win.hide()
    await wait(`document.visibilityState==='hidden'`)
    await wait(`[...document.querySelectorAll('[data-activity-motion]')].every(el=>el.dataset.activityMotion==='none')`)
    await evidence('hidden indicators are static')
    await pause(16_000)
    win.show(); win.focus()
    await wait(`document.visibilityState==='visible' && window.fixture.pendingSources.length>0`)
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState==='unknown' && document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState==='unknown'`)
    const beforeRead = await evidence('visible before held source response')
    assert(beforeRead.nodes.every(node=>node.motion==='none'))
    await status('task-one', 'working', { heartbeat: true })
    const fresh = await js(`({...window.fixture.source,sequence:++window.fixture.sourceSequence,ageMs:0})`)
    await js(`window.fixture.resolveSource(${JSON.stringify(fresh)});window.fixture.sourceMode='failed'`)
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState==='running' && document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState==='tool'`)
    await evidence('only accepted revalidation restores activity')
  })
  await step('agent epochs, replaced sessions and replayed stamps cannot renew ownership', async () => {
    await status('task-one', 'working', { epoch: 'fixture-agent-b', seq: 1, sessionId: 'replacement-one' })
    const accepted = await snapshot()
    assert.equal(accepted.agentEpoch, 'fixture-agent-b')
    assert.equal(accepted.observations['task-two'], undefined, 'A new process epoch invalidates other old claims')
    await status('task-one', 'working', { epoch: 'fixture-agent-a', seq: 9999, heartbeat: true })
    await status('task-one', 'working', { epoch: 'fixture-agent-b', seq: 1, heartbeat: true })
    assert.equal((await snapshot()).observations['task-one'].observedAt, accepted.observations['task-one'].observedAt)
    await status('task-one', 'working', { epoch: 'fixture-agent-b', seq: 2, sessionId: 'replacement-two' })
    const replaced = await snapshot()
    await status('task-one', 'working', { epoch: 'fixture-agent-b', seq: 3, sessionId: 'replacement-one', heartbeat: true })
    assert.equal((await snapshot()).observations['task-one'].sessionId, 'replacement-two')
    assert.equal((await snapshot()).observations['task-one'].observedAt, replaced.observations['task-one'].observedAt)
    await js(`window.fixture.epoch='fixture-agent-b';window.fixture.sequence=3`)
  })
  await step('late source response and retired Commander epoch are fenced', async () => {
    const old = await js(`({...window.fixture.source,sequence:window.fixture.sourceSequence+10,ageMs:0})`)
    await js(`window.fixture.sourceMode='deferred'`)
    win.hide(); await wait(`document.visibilityState==='hidden'`); win.show(); win.focus()
    await wait('window.fixture.pendingSources.length>0')
    await js(`window.fixture.sourceEpoch='fixture-commander-b';window.fixture.sourceSequence=0`)
    await startCommander('new-source-turn'); await toolCommander('new-source-turn')
    const newer = await snapshot()
    await js(`window.fixture.resolveSource(${JSON.stringify(old)});window.fixture.sourceMode='failed'`)
    await pause(200)
    const after = await snapshot()
    assert.equal(after.sourceEpoch, 'fixture-commander-b')
    assert.equal(after.commander['commander-session'].turnId, 'new-source-turn')
    assert.equal(after.commander['commander-session'].observedAt, newer.commander['commander-session'].observedAt)
    await js(`window.fixture.emit('commander',{type:'turn_event',sessionId:'commander-session',turnId:'retired-turn',event:{type:'text_delta',text:'Late retired text'},activity:${JSON.stringify(old)}})`)
    assert.equal((await snapshot()).sourceSequences['commander-session'], newer.sourceSequences['commander-session'])
    const replay = await js('({...window.fixture.source,ageMs:0})')
    await js(`window.fixture.emit('commander',{type:'turn_event',sessionId:'commander-session',turnId:'new-source-turn',event:{type:'text_delta',text:'Replay'},activity:${JSON.stringify(replay)}})`)
    assert.equal((await snapshot()).commander['commander-session'].observedAt, newer.commander['commander-session'].observedAt)
  })
  await step('new queue push wins over an older in-flight queue read', async () => {
    await js(`window.fixture.queueMode='deferred'`)
    win.hide(); await wait(`document.visibilityState==='hidden'`); win.show(); win.focus()
    await wait('window.fixture.pendingQueues.length>0')
    await js(`window.fixture.queuePush([{taskId:'task-two',agentId:'fixture-agent',reason:'global_limit',position:1,state:'queued'}])`)
    await wait(`window.fixture.inspect().session.queue['task-two']?.reason==='global_limit'`)
    await js(`window.fixture.resolveQueue([]);window.fixture.queueMode='failed'`)
    await pause(200)
    assert.equal((await snapshot()).queue['task-two'].reason, 'global_limit')
    await wait(`document.querySelector(${JSON.stringify(card('task-two'))})?.dataset.activityState==='queued'`)
    assert(await js(`document.querySelector(${JSON.stringify(card('task-two'))}).getAttribute('aria-label').includes('global session limit reached')`))
    await js(`window.fixture.queueMode='live';window.fixture.queuePush([])`)
  })
  await step('cancelled and interrupted Captain/task turns stay Stopped, explicit success alone finishes', async () => {
    await status('captain-audit', 'working')
    await status('captain-audit', 'idle', { activityOutcome: 'cancelled' })
    await wait(`document.querySelector(${JSON.stringify(expanded('captain'))}).textContent.trim()==='Stopped'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('captain'))}).dataset.activityState`), 'idle')
    assert.equal(await js(`document.querySelector('[data-testid="expanded-captain"] [data-accent]')`), null)
    await status('captain-audit', 'working')
    await status('captain-audit', 'idle', { activityOutcome: 'interrupted' })
    await wait(`document.querySelector(${JSON.stringify(expanded('captain'))}).textContent.trim()==='Stopped'`)
    await status('task-one', 'idle', { sessionId: 'replacement-two', activityOutcome: 'cancelled' })
    await wait(`document.querySelector(${JSON.stringify(card('task-one'))})?.textContent.trim()==='Stopped'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-one'))}).dataset.activityState`), 'idle')
    await status('captain-audit', 'working'); await status('captain-audit', 'idle')
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('captain'))}).dataset.activityState`), 'idle')
    assert(await js(`!document.querySelector('[data-testid="expanded-captain"] [data-accent]')`))
    await status('captain-audit', 'working'); await status('captain-audit', 'idle', { activityOutcome: 'completed' })
    await wait(`document.querySelector(${JSON.stringify(expanded('captain'))}).dataset.activityState==='finished'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('captain'))}).textContent.trim()`), 'Reply finished')
    await evidence('explicit Captain success accent')
    await wait(`document.querySelector(${JSON.stringify(expanded('captain'))}).dataset.activityState==='idle'`, 4_000)
    await endCommander('new-source-turn', 'cancelled')
    await wait(`document.querySelector(${JSON.stringify(expanded('commander'))}).textContent.trim()==='Stopped'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(expanded('commander'))}).dataset.activityState`), 'idle')
    assert(await js(`!document.querySelector('[data-testid="expanded-commander"] [data-accent]')`))
  })
  await step('observed review accent settles while Ready for review persists', async () => {
    await js(`window.fixture.taskStatus('task-two','ready_for_review')`)
    await status('task-two', 'idle', { activityOutcome: 'completed' })
    await wait(`document.querySelector(${JSON.stringify(card('task-two'))})?.textContent.trim()==='Ready for review'`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-two'))}).querySelector('[data-accent]').dataset.accent`), 'static')
    await evidence('review transition observed')
    await wait(`document.querySelector(${JSON.stringify(card('task-two'))}).querySelector('[data-accent]').dataset.accent==='none'`, 4_000)
    assert.equal(await js(`document.querySelector(${JSON.stringify(card('task-two'))}).textContent.trim()`), 'Ready for review')
    assert(await js(`!document.querySelector('.canvas-status-transition-flash')`), 'Canvas review must not add a second completion flash')
  })
  await step('both themes honor reduced motion and actual badge contrast', async () => {
    await js(`window.fixture.taskStatus('task-two','agent_working')`)
    await status('task-one', 'working', { sessionId: 'replacement-two' })
    await status('task-two', 'waiting_approval')
    await status('captain-audit', 'error', { activityOutcome: 'failed' })
    await startCommander('contrast-finished'); await endCommander('contrast-finished', 'end_turn')
    for (const dark of [false, true]) {
      if ((await snapshot()).dark !== dark) await activate('[aria-label="Toggle theme"]')
      for (const reduced of [false, true]) {
        await motionPreference(reduced)
        const state = await evidence(`theme ${dark ? 'dark' : 'light'}, reduced motion ${reduced}`)
        assert.equal(state.dark, dark)
        assert.equal(state.reduced, reduced)
        if (reduced) { assert(state.nodes.every(node=>node.motion==='none')); assert(state.nodes.every(node=>node.animations.length===0)) }
        const ratios = await contrast()
        log('contrast', { dark, reduced, ratios })
        for (const row of ratios) {
          if (row.icon !== null) assert(row.icon >= 3, `Activity icon contrast >=3:1: ${JSON.stringify(row)}`)
          if (row.text !== null) assert(row.text >= 4.5, `Activity text contrast >=4.5:1: ${JSON.stringify(row)}`)
        }
        await writeFile(join(output, `activity-${dark ? 'dark' : 'light'}-${reduced ? 'reduced' : 'motion'}.png`), (await wc.capturePage()).toPNG())
      }
    }
    await motionPreference(false)
  })
  await step('native NavRail tooltip focus and Commander/PiP share source ownership', async () => {
    await startCommander('native-pip-turn'); await toolCommander('native-pip-turn')
    await focus('[data-testid="audit-nav"] button[aria-label^="Commander"]')
    await wait(`[...document.querySelectorAll('[role="tooltip"]')].some(el=>el.textContent.includes('Commander — Using shell'))`)
    await key('Enter')
    await wait(`document.querySelector('[data-testid="commander-stage"]')`)
    await activate('[aria-label="Turn voice mode on"]')
    await wait(`window.fixture.inspect().call.status==='live'`)
    await wait(`document.querySelector('[data-testid="commander-stage"]').dataset.callState==='working'`)
    assert(await js(`!document.querySelector('[aria-label="Commander is thinking"]')`), 'Chat must not add another presence animation')
    await activate('[aria-label="Picture in picture"]')
    await wait(`document.querySelector('[data-testid="commander-pip"]')`)
    await focus('[data-testid="audit-nav"] button[aria-label="Tasks"]'); await key('Enter')
    await wait(`document.querySelector('[data-testid="task-card-task-one"]') && document.querySelector('[data-testid="commander-pip"]')`)
    await evidence('PiP plus static NavRail and StatusBar mirrors')
    await activate('[data-testid="commander-pip-expand"]')
    await wait(`document.querySelector('[data-testid="commander-stage"]') && !document.querySelector('[data-testid="commander-pip"]')`)
    await activate('[aria-label="Turn voice mode off"]')
    await wait(`window.fixture.inspect().call.status==='off'`)
    await endCommander('native-pip-turn', 'cancelled')
    await focus('[data-testid="audit-nav"] button[aria-label="Tasks"]'); await key('Enter')
    await wait(`document.querySelector('[data-testid="task-card-task-one"]')`)
  })
  if (process.env.ACTIVITY_SCREEN_READER === '1') {
    await step('assistive reader receives completed reply and separate repeated actionable failures', async () => {
      await pause(1500)
      await status('captain-audit', 'working')
      await status('captain-audit', 'idle', { activityOutcome: 'completed' })
      await wait(`document.querySelector('[data-testid="activity-announcer"]').textContent==='Captain reply finished'`)
      await pause(1500)
      for (let turn = 0; turn < 2; turn++) {
        await status('captain-audit', 'working')
        const before = sourceLogs.filter(row => row.kind === 'live-region' && row.text?.startsWith('Captain failed')).length
        await status('captain-audit', 'error', { activityOutcome: 'failed' })
        await wait(`document.querySelector('[data-testid="activity-announcer"]').textContent.startsWith('Captain failed')`)
        await pause(1500)
        assert(sourceLogs.filter(row => row.kind === 'live-region' && row.text?.startsWith('Captain failed')).length > before, 'Each distinct failure reaches the existing live region')
      }
      await status('task-two', 'working')
      await status('task-two', 'waiting_approval')
      await wait(`document.querySelector('[data-testid="activity-announcer"]').textContent==='task-two needs approval'`)
      await pause(1500)
    })
  }
  const result = { scope: 'Native renderer with controlled IPC only', failures, loads, records, sourceLogs, receipts: await js('window.fixture.receipts'), final: await snapshot(), remaining: ['Independent human and other-platform screen-reader audits remain separate', 'Real SDK/main polling and backend-process death proof are separate', 'Real PCM output and controlled capture checked by the unchanged Commander native suite'] }
  await writeFile(join(output, 'activity-native.json'), JSON.stringify(result, null, 2))
  log('result', { failures, loads, output })
  win.destroy()
  if (failures.length) throw new Error('Native activity failures: ' + failures.join(', '))
  app.quit()
}).catch(async error => {
  log('fatal', { error: String(error), loads })
  await writeFile(join(output, 'activity-native-fatal.json'), JSON.stringify({ error: String(error), records, sourceLogs }, null, 2)).catch(() => {})
  app.exit(1)
})
