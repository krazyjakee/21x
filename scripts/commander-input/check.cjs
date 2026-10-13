const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const url = process.env.COMMANDER_INPUT_URL
app.setPath('userData', process.env.COMMANDER_INPUT_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
if (process.env.COMMANDER_SCREEN_READER === '1') app.commandLine.appendSwitch('force-renderer-accessibility')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url) && !details.url.startsWith('devtools:') }))
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const wc = win.webContents
  wc.on('console-message', event => {
    if (event.level >= 2) console.error('Renderer:', event.message)
  })
  const js = source => wc.executeJavaScript(source)
  const field = 'document.querySelector(\'textarea[aria-label="Message the Commander"]\')'
  const wait = async source => {
    for (let i = 0; i < 500; i++) { if (await js(source)) return; await pause(30) }
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
  const state = () => js(`(() => { const f = ${field}, r = f?.getBoundingClientRect(); return { active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), hidden: document.activeElement?.getAttribute("aria-hidden"), readOnly: document.activeElement?.readOnly }, disabled: f?.disabled, readOnly: f?.readOnly, hidden: f ? !!f.closest('[aria-hidden="true"], [hidden], [inert]') : true, pointerEvents: f ? getComputedStyle(f).pointerEvents : null, hit: r ? document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === f : false, value: f?.value } })()`)
  const failures = []
  const check = async (name, test) => {
    win.setContentSize(1200, 900); wc.setZoomFactor(1)
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
          stage: rect(document.querySelector('.commander-stage')), panel: rect(document.querySelector('.commander-side-panel')), header: rect(document.querySelector('.commander-workspace-header')),
          voice: rect(document.querySelector('.commander-toolbar')),
          user: style('.commander-user-message'), reply: style('.commander-reply p'), reportText: style('[data-testid="commander-report"] p'),
          streaming: style('[data-testid="commander-streaming"] p'), input: style('textarea[aria-label="Message the Commander"]'),
          inlineCode: style('[data-testid="commander-report"] li code'), code: style('[data-testid="commander-report"] pre code'),
          tool: style('[data-testid="commander-tool-chip"]'), error: style('[role="alert"]'),
          title: style('.commander-workspace-header h1'),
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
        assert(metrics.stage.bottom <= metrics.panel.top + 1, 'compact stage sits above the Chat panel')
        assert(metrics.voice.bottom <= metrics.stage.bottom + 1, 'call controls remain inside the stage')
      }
      await js(`document.querySelector('[data-testid="commander-messages"]').scrollTop = document.querySelector('[data-testid="commander-messages"]').scrollHeight`)
      assert(await js(`document.querySelector('[data-testid="commander-messages"]').scrollTop > 0`))
    })
  }
  await check('stage panels preserve draft and sessions drawer traps and restores keyboard focus', async () => {
    await click('textarea[aria-label="Message the Commander"]'); await type('retained draft')
    await click('[aria-label="Hide Chat panel"]')
    assert(await js(`${field}.closest('[hidden]') !== null`))
    await click('[aria-label="Show Chat panel"]')
    assert.equal(await js(`${field}.value`), 'retained draft')
    await click('[role="tab"][id="commander-actions-tab"]')
    assert.equal(await js(`${field}.value`), 'retained draft')
    await click('[role="tab"][id="commander-chat-tab"]')
    await click('[aria-label="Open Commander sessions"]')
    await wait(`document.querySelector('[role="dialog"]')`)
    for (let i = 0; i < 10; i++) { await key('Tab'); assert(await js(`!!document.activeElement.closest('[role="dialog"]')`)) }
    await key('Escape')
    await wait(`!document.querySelector('[role="dialog"]')`)
    assert.equal(await js('document.activeElement.ariaLabel'), 'Open Commander sessions')
    assert.equal(await js(`${field}.value`), 'retained draft')
  })
  await check('PTT Space preserves text entry and completes once on release or focus change', async () => {
    await click('[aria-label="Turn voice mode on"]')
    await wait('window.fixture.callState().status === "live"')
    await click('[aria-label="Microphone mode and input device"]')
    await js(`(() => { const select = document.querySelector('[aria-label="Microphone mode"]'); select.value = 'push-to-talk'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await wait('window.fixture.callState().mode === "push-to-talk"')
    await click('textarea[aria-label="Message the Commander"]'); await type('typed space')
    assert.equal(await js(`${field}.value`), 'typed space')
    assert.equal(await js('window.fixture.captures.length'), 1)
    await js('document.activeElement.blur()')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); await pause(40)
    await wait('window.fixture.callState().pttHeld')
    await js('window.fixture.segment("First sentence.")')
    assert.equal(await js('window.fixture.voiceSends.length'), 0)
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await wait('window.fixture.voiceSends.length === 1')
    assert.equal(await js('window.fixture.releases'), 1)
    assert.equal(await js('window.fixture.voiceSends[0].text'), 'First sentence. Final words')
    await js('document.activeElement.blur()')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); await pause(40)
    await wait('window.fixture.callState().pttHeld')
    await js(`${field}.focus()`)
    await wait('window.fixture.releases === 2')
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await wait('window.fixture.voiceSends.length === 2')
    assert.equal(await js('window.fixture.releases'), 2)
    assert.equal(await js(`${field}.value`), 'typed space')
    await click('[aria-label="Turn voice mode off"]')
    assert.equal(await js('window.fixture.callState().status'), 'off')
  })
  await check('actual shared playback analyser drives speaking ring and Stop removes it', async () => {
    await click('[aria-label="Turn voice mode on"]')
    await wait('window.fixture.callState().status === "live"')
    await js('window.fixture.speech()')
    await wait(`document.querySelector('[data-testid="commander-output-ring"]') && parseFloat(document.querySelector('[data-testid="commander-output-ring"]').style.getPropertyValue('--commander-level')) > .05`)
    assert(await js(`document.querySelector('[data-testid="commander-presence-state"]').textContent.includes('Speaking')`))
    assert(await js(`document.querySelector('.commander-caption-strip mark').textContent === 'The checkout review is complete.'`))
    await click('[aria-label="Stop the reply"]')
    await wait(`!document.querySelector('[data-testid="commander-output-ring"]')`)
    assert.equal(await js('window.fixture.callState().status'), 'live')
  })
  await check('native floating call drag, navigation, single captions and full-view focus restoration', async () => {
    await click('[aria-label="Turn voice mode on"]'); await wait('window.fixture.callState().status === "live"')
    await click('textarea[aria-label="Message the Commander"]'); await type('preserved draft')
    await key('M', ['control', 'shift'])
    await wait(`document.querySelector('[data-testid="commander-pip"]')`)
    assert.equal(await js('document.activeElement.ariaLabel'), 'Expand Commander call')
    await js('window.fixture.partial("Exactly one partial caption")')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-voice-status"]').length`), 1)
    assert(await js(`!document.querySelector('[data-testid="voice-overlay"]')`))
    const point = await js(`(() => { const r=document.querySelector('[aria-label="Move Commander call"]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
    wc.sendInputEvent({ type: 'mouseMove', ...point }); wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseMove', x: 100, y: 70 }); await pause(50)
    wc.sendInputEvent({ type: 'mouseUp', x: 100, y: 70, button: 'left', clickCount: 1 })
    await wait(`document.querySelector('.commander-pip-top-left')`)
    await click('[data-testid="commander-pip-expand"]')
    await wait(`!document.querySelector('[data-testid="commander-pip"]')`)
    assert(await js(`document.activeElement === ${field}`)); assert.equal(await js(`${field}.value`), 'preserved draft')
    await js('window.fixture.navigate("tasks")')
    await wait(`document.querySelector('[data-testid="commander-pip"]') && !${field}`)
    await click('[aria-label="Other workspace control"]'); await key('a')
    assert.equal(await js('document.activeElement.ariaLabel'), 'Other workspace control')
    assert.equal(await js('window.fixture.captures.length'), 1)
    await click('[data-testid="commander-pip-expand"]'); await wait(`${field}`)
    assert.equal(await js(`${field}.value`), 'preserved draft'); assert.equal(await js('window.fixture.captures.length'), 1)
    await key('E', ['control', 'shift'])
    assert.equal(await js('window.fixture.callState().status'), 'off')
  })
  await check('native captions sizes, keyboard controls, contrast and one silent live-region owner', async () => {
    await click('[aria-label="Turn voice mode on"]'); await wait('window.fixture.callState().status === "live"')
    await js('window.fixture.partial("Complete caption text stays available in the dialog and remains silent while it is partial.")')
    await click('[aria-label="Read full captions"]'); await wait(`document.querySelector('[role="dialog"]')`)
    for (const [size, expected] of [['small', 13], ['medium', 14], ['large', 18]]) {
      await js(`(() => { const s=document.querySelector('[aria-label="Caption size"]'); s.value='${size}'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      assert.equal(await js(`parseFloat(getComputedStyle(document.querySelector('.commander-caption-full')).fontSize)`), expected)
    }
    assert(await js(`document.querySelector('[role="dialog"]').textContent.includes('remains silent while it is partial')`))
    await key('Escape'); await wait(`!document.querySelector('[role="dialog"]')`)
    await wait(`document.activeElement.ariaLabel === 'Read full captions'`)
    assert.equal(await js('document.activeElement.ariaLabel'), 'Read full captions')
    assert.equal(await js('window.fixture.callState().status'), 'live')
    assert.equal(await js(`document.querySelectorAll('[data-testid="commander-call-announcer"] [aria-live]').length`), 2)
    assert(await js(`!document.querySelector('[data-testid="commander-call-announcer"]').textContent.includes('remains silent while it is partial')`))
    await js('window.fixture.speech()')
    await wait(`document.querySelector('[data-testid="commander-output-ring"]')`)
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark', ${dark})`)
      const contrast = await js(`(() => {
        const rgb = color => color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});
        const luminance = color => {const c=rgb(color);return c[0]*.2126+c[1]*.7152+c[2]*.0722};
        const ratio=(a,b)=>{a=luminance(a);b=luminance(b);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        const text=getComputedStyle(document.querySelector('.commander-caption-text'));
        const surface=getComputedStyle(document.querySelector('.commander-caption-strip'));
        return {caption:ratio(text.color,surface.backgroundColor)};
      })()`)
      assert(contrast.caption >= 4.5, 'caption contrast at least 4.5:1')
      // The ring contrasts against the card/background it surrounds.
      assert(await js(`(() => {const parse=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});const l=c=>{const v=parse(c);return v[0]*.2126+v[1]*.7152+v[2]*.0722};const a=l(getComputedStyle(document.querySelector('[data-testid="commander-output-ring"]')).borderTopColor),b=l(getComputedStyle(document.querySelector('.commander-stage')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3})()`), 'ring contrast at least 3:1')
    }
    await click('[aria-label="Mute microphone"]'); await key('End')
    assert.equal(await js('document.activeElement.ariaLabel'), 'Turn voice mode off')
    await key('C', ['control', 'shift']); assert(await js(`!document.querySelector('[data-testid="commander-voice-status"]')`))
    await key('C', ['control', 'shift']); assert(await js(`document.querySelector('[data-testid="commander-voice-status"]')`))
  })
  await check('native text undo stays local; eight-second exact-action toast works in PiP', async () => {
    await click('[aria-label="Turn voice mode on"]'); await wait('window.fixture.callState().status === "live"')
    await click('textarea[aria-label="Message the Commander"]'); await type('native undo')
    await js('window.fixture.action()'); await wait(`document.querySelector('[data-testid="commander-action-toast"]')`)
    await key('z', ['control']); assert.equal(await js('window.fixture.undos.length'), 0)
    assert.notEqual(await js(`${field}.value`), 'native undo')
    await js('document.activeElement.blur()'); await key('M', ['control', 'shift'])
    await wait(`document.querySelector('[data-testid="commander-pip"]')`)
    await key('z', ['control']); await wait('window.fixture.undos.length === 1')
    assert.deepEqual(await js('window.fixture.undos[0]'), { sessionId: 'session-1', actionId: 'exact-undo' })
    assert(await js(`document.querySelector('[data-testid="commander-action-toast"]').textContent.includes('Undone')`))
    await wait(`!document.querySelector('[data-testid="commander-action-toast"]')`)
    assert.equal(await js('window.fixture.callState().status'), 'live')
    await key('E', ['control', 'shift']); assert.equal(await js('window.fixture.callState().status'), 'off')
  })
  win.destroy()
  if (failures.length) throw new Error('Failed: ' + failures.join(', '))
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
