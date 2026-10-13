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
  for (const width of [1200, 640]) for (const zoom of [1, 1.5]) {
    await check(`readable typography and long-report layout at ${width}px / ${zoom * 100}%`, async () => {
      win.setContentSize(width, 900)
      wc.setZoomFactor(zoom)
      await js('window.fixture.typography()')
      await wait(`document.querySelector('[data-testid="commander-report"] pre')`)
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const metrics = await js(`(() => {
        const workspace = document.querySelector('.commander-workspace');
        const messages = document.querySelector('[data-testid="commander-messages"]');
        const report = document.querySelector('[data-testid="commander-report"]');
        const composer = ${field};
        const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } };
        const style = selector => { const element = document.querySelector(selector); if (!element) throw new Error('Missing typography measurement element: ' + selector); const s = getComputedStyle(element); return { fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) } };
        const code = report.querySelector('pre');
        const smallText = [];
        const walker = document.createTreeWalker(workspace, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, parent = node.parentElement;
          if (node.textContent.trim() && !parent.closest('svg, option') && parseFloat(getComputedStyle(parent).fontSize) < 12) smallText.push(node.textContent.trim());
        }
        return {
          workspace: rect(workspace), messages: rect(messages), report: rect(report), composer: rect(composer),
          list: rect(document.querySelector('.commander-session-list')), header: rect(document.querySelector('.commander-chat header')),
          voice: rect(document.querySelector('.commander-voice-controls')),
          user: style('.commander-user-message'), reply: style('.commander-reply p'), reportText: style('[data-testid="commander-report"] p'),
          streaming: style('[data-testid="commander-streaming"] p'), input: style('textarea[aria-label="Message the Commander"]'),
          inlineCode: style('[data-testid="commander-report"] li code'), code: style('[data-testid="commander-report"] pre code'),
          tool: style('[data-testid="commander-tool-chip"]'), error: style('[role="alert"]'),
          title: style('.commander-session-list li > div > div'),
          primaryOverflow: messages.scrollWidth - messages.clientWidth,
          codeOverflow: code.scrollWidth - code.clientWidth,
          contentScrolls: messages.scrollHeight > messages.clientHeight,
          smallText,
          controls: [...document.querySelectorAll('.commander-chat select, .commander-chat button')].map(rect),
          columns: getComputedStyle(document.querySelector('.commander-layout')).flexDirection
        };
      })()`)
      assert.equal(wc.getZoomFactor(), zoom)
      for (const key of ['user', 'reply', 'reportText', 'streaming', 'input']) {
        assert.equal(metrics[key].fontSize, 14, key + ' uses shared 14px primary text before zoom')
        assert(metrics[key].lineHeight >= 21, key + ' has readable line height')
      }
      for (const key of ['inlineCode', 'code', 'tool', 'error']) assert.equal(metrics[key].fontSize, 13, key + ' uses readable shared secondary text')
      assert.equal(metrics.title.fontSize, 14)
      assert.deepEqual(metrics.smallText, [], 'no essential 10px/11px text')
      assert.equal(metrics.primaryOverflow, 0, 'report and unbroken user text do not widen the chat')
      assert(metrics.codeOverflow > 0, 'long code scrolls within its own block')
      assert(metrics.contentScrolls, 'long reports remain available through the message scrollport')
      assert(metrics.messages.height >= 80, 'message scrollport remains usable')
      assert(metrics.report.width <= metrics.messages.width, 'report is bounded by the chat width')
      assert(metrics.report.width <= 1100 / zoom, 'reading line length is bounded')
      assert(metrics.composer.bottom <= metrics.workspace.bottom, 'composer stays visible')
      assert(metrics.composer.top >= metrics.messages.bottom - 1, 'composer and messages do not overlap')
      for (const control of metrics.controls) {
        assert(control.width > 0 && control.height > 0)
        assert(control.left >= metrics.workspace.left && control.right <= metrics.workspace.right + 1, 'controls fit the available width')
      }
      if (width / zoom <= 760) {
        assert.equal(metrics.columns, 'column')
        assert(metrics.list.bottom <= metrics.header.top + 1, 'compact sessions sit above the chat')
        assert(metrics.voice.top >= metrics.composer.bottom, 'compact voice controls sit below the composer')
      }
      await js(`document.querySelector('[data-testid="commander-messages"]').scrollTop = document.querySelector('[data-testid="commander-messages"]').scrollHeight`)
      assert(await js(`document.querySelector('[data-testid="commander-messages"]').scrollTop > 0`))
    })
  }
  win.destroy()
  if (failures.length) throw new Error('Failed: ' + failures.join(', '))
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
