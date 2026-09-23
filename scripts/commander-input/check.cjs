const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const url = process.env.COMMANDER_INPUT_URL
app.setPath('userData', process.env.COMMANDER_INPUT_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url) && !details.url.startsWith('devtools:') }))
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const wc = win.webContents
  const js = source => wc.executeJavaScript(source)
  const field = 'document.querySelector(\'textarea[aria-label="Message the Commander"]\')'
  const wait = async source => {
    for (let i = 0; i < 100; i++) { if (await js(source)) return; await pause(30) }
    throw new Error('Timed out: ' + source)
  }
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1 || keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await pause(30)
  }
  const type = async text => { for (const char of text) await key(char) }
  const click = async selector => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    wc.sendInputEvent({ type: 'mouseMove', ...point })
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await pause(30)
  }
  const state = () => js(`(() => { const f = ${field}, r = f.getBoundingClientRect(); return { active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), hidden: document.activeElement?.getAttribute("aria-hidden"), readOnly: document.activeElement?.readOnly }, disabled: f.disabled, readOnly: f.readOnly, hidden: !!f.closest('[aria-hidden="true"], [hidden], [inert]'), pointerEvents: getComputedStyle(f).pointerEvents, hit: document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === f, value: f.value } })()`)
  const failures = []
  const check = async (name, test) => {
    await win.loadURL(url)
    win.focus()
    await wait(`${field} && !document.querySelector('[aria-label="Commander model"]').disabled && document.querySelector('[aria-label="Turn voice mode on"]')`)
    try { await test(); console.log('PASS: ' + name) }
    catch (error) { failures.push(name); console.error('FAIL: ' + name, error.message, await state()) }
  }
  await check('native typing, shortcut letters, Shift+Enter and accessibility', async () => {
    await click('textarea[aria-label="Message the Commander"]')
    await type('ceghijkorvwy /?#')
    await key('Tab')
    assert.equal(await js('document.activeElement.ariaLabel'), 'Send')
    await key('Tab', ['shift'])
    assert(await js(`document.activeElement === ${field}`))
    await key('End')
    await key('Enter', ['shift'])
    await type('next')
    const result = await state()
    assert.equal(result.value, 'ceghijkorvwy /?#\nnext')
    assert.equal(result.disabled, false); assert.equal(result.readOnly, false)
    assert.equal(result.hidden, false); assert.equal(result.hit, true); assert.equal(result.pointerEvents, 'auto')
    wc.debugger.attach('1.3')
    const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree')
    assert.equal(nodes.filter(n => !n.ignored && n.role?.value === 'textbox' && n.name?.value === 'Message the Commander').length, 1)
    assert.equal(nodes.filter(n => !n.ignored && n.role?.value === 'textbox' && !n.name?.value).length, 0)
    wc.debugger.detach()
  })
  await check('I shortcut recovers focus; first auto-focus character survives React rerender', async () => {
    await js('document.activeElement.blur()')
    await key('i')
    assert(await js(`document.activeElement === ${field}`))
    await js('document.activeElement.blur()')
    await type('abc')
    await js('window.fixture.activity()')
    assert.equal(await js(`${field}.value`), 'abc')
  })
  await check('voice segments preserve visible typing focus and draft', async () => {
    await click('[aria-label="Turn voice mode on"]')
    await wait('document.querySelector(\'[data-testid="commander-voice-status"]\')?.textContent.includes("Listening")')
    await click('textarea[aria-label="Message the Commander"]')
    await type('before')
    await js('window.fixture.segment("spoken request")')
    await js('window.fixture.activity()')
    await type(' after')
    assert.equal(await js(`${field}.value`), 'before after')
    assert(await js(`document.activeElement === ${field}`))
    assert.deepEqual(await js('window.fixture.voiceSends'), [{ sessionId: 'session-1', text: 'spoken request' }])
    await key('Escape')
    await type(' off')
    assert.equal(await js(`${field}.value`), 'before after off')
  })
  for (const outcome of ['resolveSend', 'rejectSend']) await check('keyboard focus after ' + outcome, async () => {
    await click('textarea[aria-label="Message the Commander"]')
    await type('first')
    await key('Enter')
    await wait('window.fixture.sends.length === 1')
    await key('Enter')
    assert.equal(await js('window.fixture.sends.length'), 1)
    await js(`window.fixture.${outcome}()`)
    await wait(`!${field}.disabled && !${field}.readOnly`)
    if (outcome === 'resolveSend') await js('window.fixture.done()')
    await type('z')
    assert.equal(await js(`${field}.value`), outcome === 'resolveSend' ? 'z' : 'firstz')
    assert(await js(`document.activeElement === ${field}`))
  })
  win.destroy()
  if (failures.length) throw new Error('Failed: ' + failures.join(', '))
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
