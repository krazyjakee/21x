const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
if (!process.env.TASK_GROUP_URL || !process.env.TASK_GROUP_PROFILE) throw new Error('Use scripts/task-group-input/run.mjs')
app.setPath('userData', process.env.TASK_GROUP_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
const output = process.env.TASK_GROUP_OUTPUT
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const events = [], failures = []
let win, wc
const js = source => wc.executeJavaScript(source, true)
const log = (step, phase, details = {}) => { const event = { timestamp: new Date().toISOString(), step, phase, ...details }; events.push(event); console.log('TASK_GROUP_NATIVE ' + JSON.stringify(event)) }
async function wait(expression, timeout = 10_000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await js(expression)) return; await pause(40) } throw new Error('Timed out: ' + expression) }
async function key(keyCode, modifiers = []) { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode.length === 1 || keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(50) }
async function focus(selector) { await wait(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`); assert(await js(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});element.focus();return document.activeElement===element&&!element.disabled})()`), 'Enabled keyboard target: ' + selector) }
async function activate(selector) { await focus(selector); await key(await js(`document.querySelector(${JSON.stringify(selector)}).type==='checkbox'`) ? 'Space' : 'Enter') }
async function button(text, scope = 'document') { await wait(`!![...${scope}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)})`); await js(`(() => { const el=[...${scope}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});el.dataset.nativeTarget='true' })()`); try { await activate('[data-native-target="true"]') } finally { await js(`document.querySelector('[data-native-target="true"]')?.removeAttribute('data-native-target')`) } }
async function type(text) { for (const character of text) await key(character) }
async function state() { return js(`({group:window.fixture.group,tasks:window.fixture.tasks.map(task=>({id:task.id,status:task.status,group_id:task.group_id})),calls:window.fixture.calls,dialog:document.querySelector('[role="dialog"]')?.textContent.trim(),focus:document.activeElement?.getAttribute('aria-label')})`) }
async function step(name, body) { log(name, 'begin'); try { await body(); log(name, 'passed', { state: await state() }) } catch (error) { failures.push(name); log(name, 'failed', { error: String(error), state: await state() }); await writeFile(join(output, name.replace(/[^a-z0-9]+/gi,'-')+'.png'), (await wc.capturePage()).toPNG()) } }
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1500, height: 1050, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); wc = win.webContents
  wc.on('console-message', (_event, level, message) => { if (level >= 2 || message.startsWith('TASK_GROUP_CALL ')) console.log(message) })
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(process.env.TASK_GROUP_URL) && !details.url.startsWith('devtools:') }))
  log('scope', 'controlled IPC, real production renderer and native input; no SDK/source/database/worktree claim')
  await win.loadURL(process.env.TASK_GROUP_URL)
  await wait(`document.querySelector('[data-testid="task-group-native-group"]')`, 25_000)
  await step('one distinct group card, no independently draggable members, keyboard disclosure', async () => {
    assert.equal(await js(`document.querySelectorAll('[data-testid^="task-group-"]').length`), 1)
    assert.equal(await js(`document.querySelectorAll('[data-testid^="task-card-"]').length`), 0)
    await activate('[data-testid="task-group-native-group"] summary')
    assert(await js(`document.querySelector('[data-testid="group-member-one"]').textContent.includes('Agent finished · awaiting review')`))
    assert(await js(`!document.querySelector('[data-testid="group-member-one"]').hasAttribute('draggable')`))
    await focus('[data-testid="task-group-native-group"]'); await key('Enter')
    await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('Shared agent session')`)
    for (let index = 0; index < 8; index++) { await key('Tab'); assert(await js(`!!document.activeElement.closest('[role="dialog"]')`)) }
    assert(await js(`!document.querySelector('[role="dialog"] [aria-label="Change task status"]')&&!document.querySelector('[role="dialog"] [data-testid="header-cta-complete"]')`))
  })
  await step('shared Start and HITL target only the hidden execution task', async () => {
    await button('Start group')
    await wait(`window.fixture.calls.some(call=>call.method==='start')`)
    assert.deepEqual(await js(`window.fixture.calls.filter(call=>call.method==='start').map(call=>call.taskId)`), ['execution'])
    await wait(`document.querySelector('[role="dialog"] [aria-label="Remove Checkout copy from group"]').disabled`)
    await js('window.fixture.hitl()')
    await wait(`document.querySelector('[role="dialog"]').textContent.includes('Approve editing the checkout files?')`)
    await focus('[role="dialog"] textarea[placeholder="Write a message..."]'); await type('Allow checkout edits.'); await key('Enter')
    await wait(`window.fixture.calls.some(call=>call.method==='approve')`)
    const approved = await js(`window.fixture.calls.find(call=>call.method==='approve')`)
    assert.equal(approved.sessionId, 'shared-native-session'); assert.equal(approved.responseType, 'permission'); assert.equal(approved.requestId, 'group-request')
    await button('Stop group')
    await wait(`window.fixture.group.status==='ready_for_review'`)
    await focus('[role="dialog"] textarea[placeholder="Write a message..."]'); await type('Keep the checkout changes together.'); await key('Enter')
    await wait(`window.fixture.calls.some(call=>call.method==='send')`)
    assert.equal(await js(`window.fixture.calls.find(call=>call.method==='send').taskId`), 'execution')
    assert.equal(await js(`window.fixture.calls.filter(call=>call.method==='start').length`), 1)
    await key('Escape'); await wait(`!document.querySelector('[role="dialog"]')`)
  })
  await step('native pointer drag moves one group unit through the group API', async () => {
    // Radix removes dialog content before its exit overlay stops intercepting
    // pointer events. Wait for the actual native hit target, not just a missing
    // dialog node, before starting the drag.
    await wait(`(() => {const card=document.querySelector('[data-testid="task-group-native-group"]');const r=card.getBoundingClientRect();return card.contains(document.elementFromPoint(r.left+20,r.top+20))})()`)
    const origin = await js(`(() => {const r=document.querySelector('[data-testid="task-group-native-group"]').getBoundingClientRect();return{x:Math.round(r.left+20),y:Math.round(r.top+20)}})()`)
    const destination = await js(`(() => {const r=document.querySelector('[data-testid="task-column-not_started"]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+70)}})()`)
    wc.sendInputEvent({type:'mouseMove',...origin});wc.sendInputEvent({type:'mouseDown',...origin,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseMove',x:origin.x+15,y:origin.y+15});await pause(80)
    wc.sendInputEvent({type:'mouseMove',...destination});await pause(100);wc.sendInputEvent({type:'mouseUp',...destination,button:'left',clickCount:1})
    await wait(`window.fixture.calls.some(call=>call.method==='move')`)
    assert.deepEqual(await js(`window.fixture.calls.filter(call=>call.method==='move').map(call=>({id:call.id,status:call.status}))`), [{id:'native-group',status:'not_started'}])
    assert(await js(`document.querySelector('[data-testid="task-column-not_started"]').contains(document.querySelector('[data-testid="task-group-native-group"]'))`))
    assert(await js(`window.fixture.tasks.every(task=>task.status==='not_started')`))
    await js(`window.fixture.phase('ready_for_review')`)
    await focus('[data-testid="task-group-native-group"]');await key('Enter');await wait(`document.querySelector('[role="dialog"]')`)
  })
  await step('selected source failure stays selected; app-only approval affects one member', async () => {
    await activate('[aria-label="Select Checkout copy for review"]')
    await button('Approve selected')
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Task source unavailable')`)
    assert(await js(`document.querySelector('[aria-label="Select Checkout copy for review"]').checked`))
    assert.equal(await js(`window.fixture.tasks.find(task=>task.id==='one').status`), 'ready_for_review')
    await activate('[aria-label="Select Checkout copy for review"]');await activate('[aria-label="Select Checkout configuration for review"]')
    await js(`(() => { const input=[...document.querySelectorAll('label')].find(el=>el.textContent.includes('Complete at task sources')).querySelector('input'); input.dataset.nativeSource='true' })()`)
    await focus('[data-native-source="true"]');await key('Space')
    await button('Approve selected')
    await wait(`window.fixture.tasks.find(task=>task.id==='two').status==='completed'`)
    const calls = await js(`window.fixture.calls.filter(call=>call.method==='review')`)
    assert.deepEqual(calls[0].task_ids, ['one']); assert.equal(calls[0].complete_at_source, true)
    assert.deepEqual(calls[1].task_ids, ['two']); assert.equal(calls[1].complete_at_source, false)
    assert.equal(await js(`window.fixture.tasks.find(task=>task.id==='one').status`), 'ready_for_review')
  })
  await step('queued membership refusal is visible; removal preserves shared history', async () => {
    await js('window.fixture.refuseRemove=true')
    await activate('[role="dialog"] [aria-label="Remove Checkout copy from group"]')
    await wait(`[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent.includes('group is queued'))`)
    assert(await js(`window.fixture.group.task_ids.includes('one')`))
    await js('window.fixture.refuseRemove=false')
    await activate('[role="dialog"] [aria-label="Remove Checkout copy from group"]')
    await wait(`!window.fixture.group.task_ids.includes('one')`)
    assert.equal(await js(`window.fixture.tasks.find(task=>task.id==='one').group_id`), null)
    assert.equal(await js(`window.fixture.tasks.find(task=>task.id==='one').status`), 'ready_for_review')
    await button('Dissolve group')
    await wait(`document.querySelector('[role="dialog"]').textContent.includes('Retained shared conversation')`)
    assert(await js(`!document.querySelector('[role="dialog"] textarea[placeholder="Write a message..."]')`), 'Dissolved history has no sending composer')
    assert(await js(`document.querySelector('[role="dialog"]').textContent.includes('Shared checkout conversation is retained.')`))
    await key('Escape');await wait(`!document.querySelector('[role="dialog"]')`)
    await wait(`document.querySelector('[data-testid="task-card-one"]')&&!document.querySelector('[data-testid="task-group-native-group"]')`)
    await focus('[data-testid="task-card-one"]');await key('Enter')
    await wait(`document.querySelector('[aria-label="Task group history"]')`)
    await activate('[aria-label="Open shared conversation for Checkout polish"]')
    await wait(`document.querySelector('[role="dialog"]').textContent.includes('Retained shared conversation')`)
    assert(await js(`document.querySelector('[role="dialog"]').textContent.includes('Shared checkout conversation is retained.')`))
  })
  await writeFile(join(output,'task-groups-native.json'), JSON.stringify({failures,events,calls:await js('window.fixture.calls'),scope:'Controlled API/source responses with real production renderer and native keyboard/pointer; no real backend execution or task-source claim.'},null,2))
  await writeFile(join(output,'task-groups-final.png'),(await wc.capturePage()).toPNG())
  win.destroy();if(failures.length)throw new Error('Task group native failures: '+failures.join(', '));app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
