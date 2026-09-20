const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const output = process.env.NAV_RAIL_OUTPUT
const url = process.env.NAV_RAIL_URL
app.setPath('userData', process.env.NAV_RAIL_PROFILE)
app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar')
app.commandLine.appendSwitch('disable-gpu')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url) && !details.url.startsWith('devtools:') }))
  const win = new BrowserWindow({ width: 1200, height: 900, frame: false, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const wc = win.webContents
  wc.on('console-message', (_event, ...args) => console.log('renderer', ...args))
  wc.on('did-fail-load', (_event,...args) => console.log('load failed',...args))
  await win.loadURL(url)
  const js = source => wc.executeJavaScript(source)
  // Flush layout/scroll events before advancing focus; a background window
  // must not defer a previous target's scroll until Settings receives focus.
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  for (let tries=0; tries<100; tries++) {
    if (await js('!!document.querySelector("nav button")')) break
    await pause(100)
  }
  console.log(await js('document.body.innerText')); assert(await js('!!document.querySelector("nav button")'), 'fixture loaded')
  const results = []
  for (const theme of ['light','dark']) for (const height of [900,600]) for (const zoom of [1,1.25,1.5,2]) for (const textScale of [1,2]) for (const scrollbar of [8,15,17]) {
    win.setContentSize(height === 900 ? 1200 : 900, height)
    await pause(100); wc.setZoomFactor(zoom)
    await js(`document.documentElement.classList.toggle('dark', ${theme === 'dark'}); document.documentElement.style.fontSize='${12*textScale}px'; document.documentElement.style.setProperty('--review-text-scale','${textScale}'); document.activeElement?.blur(); document.querySelector('nav button').click(); document.querySelector('[aria-label="Main views"]').scrollTop=0;`)
    await js(`document.getElementById('text-scaling')?.remove(); var style=document.createElement('style'); style.id='text-scaling'; style.textContent='.ui-scale { --text-xs: ${12*textScale}px; --text-2xs: ${11*textScale}px; }'; document.head.append(style)`)
    await js(`document.getElementById('forced-scrollbar')?.remove(); var scrollbarStyle=document.createElement('style'); scrollbarStyle.id='forced-scrollbar'; scrollbarStyle.textContent='[aria-label=\"Main views\"]::-webkit-scrollbar { width: ${scrollbar}px; height: ${scrollbar}px; }'; document.head.append(scrollbarStyle)`)
    await pause(70)
    const measurements = await js(`(() => {
      const nav=document.querySelector('nav'), main=nav.children[0], bottom=nav.children[1], settings=bottom.querySelector('button');
      const r=el=>{const b=el.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height}};
      const before=r(settings), navBefore=r(nav), pageScrollBefore=window.scrollY; main.scrollTop=main.scrollHeight; const after=r(settings);
      const scrollport={left:r(main).left+main.clientLeft,right:r(main).left+main.clientLeft+main.clientWidth};
      const buttons=[...nav.querySelectorAll('button')];
      return {navBefore,pageScrollBefore,pageScrollAfter:window.scrollY,clientWidth:main.clientWidth,scrollWidth:main.scrollWidth,scrollport,actualScrollbar:main.offsetWidth-main.clientWidth,nav:r(nav),main:r(main),bottom:r(bottom),settings:before,afterScroll:after,buttons:buttons.map(r),names:buttons.map(b=>b.ariaLabel),maxScroll:main.scrollHeight-main.clientHeight,scrollTop:main.scrollTop,innerHeight,overflow:getComputedStyle(main).overflowY,paddingBottom:parseFloat(getComputedStyle(nav).paddingBottom)};
    })()`)
    assert.equal(wc.getZoomFactor(),zoom); assert(Math.abs(measurements.innerHeight-height/zoom)<1, 'actual zoom viewport'); assert.equal(measurements.names.at(-1),'Settings')
    assert.equal(measurements.overflow,'auto')
    assert(measurements.main.bottom <= measurements.bottom.top + .1, 'no overlap')
    assert(measurements.settings.bottom <= measurements.innerHeight, 'visible')
    assert(Math.abs(measurements.nav.bottom-measurements.settings.bottom-measurements.paddingBottom)<1, 'pinned')
    assert.deepEqual(measurements.settings,measurements.afterScroll)
    assert.deepEqual(measurements.nav,measurements.navBefore, 'scrolling main leaves the rail fixed')
    assert.equal(measurements.pageScrollBefore,measurements.pageScrollAfter, 'main scrolling does not scroll the page')
    for (const b of measurements.buttons) assert(b.width >=44 && b.height>=44, '44 px target')
    assert.equal(measurements.scrollWidth, measurements.clientWidth, `no horizontal overflow: ${JSON.stringify({theme,height,zoom,textScale,scrollbar,clientWidth:measurements.clientWidth,actualScrollbar:measurements.actualScrollbar})}`);
    assert(measurements.clientWidth >= 44, 'scrollport fits the full target');
    if (measurements.maxScroll > 0) assert.equal(measurements.actualScrollbar, scrollbar, 'forced classic scrollbar consumes its requested width');
    for (const b of measurements.buttons.slice(0,-1)) assert(b.left >= measurements.scrollport.left && b.right <= measurements.scrollport.right, 'main target inside actual client scrollport');
    assert(measurements.settings.left >= measurements.bottom.left && measurements.settings.right <= measurements.bottom.right, 'Settings target inside its group')
    if (height===600 && zoom===2) assert(measurements.scrollTop>0, 'short zoomed rail scrolls')
    results.push({theme,height,zoom,textScale,scrollbar,...measurements})
    await settle()
  }
  // Real keyboard traversal scrolls the main group and reaches Settings last.
  for (const theme of ['light','dark']) {
    win.setContentSize(900,600); await pause(100); wc.setZoomFactor(2)
    await js(`document.documentElement.classList.toggle('dark',${theme==='dark'}); document.querySelector('nav button').focus();`)
    await pause(100)
    for (const name of ['Canvas','Tasks','Skills','Commander','Projects','Settings']) {
      wc.sendInputEvent({type:'keyDown',keyCode:'Tab'}); wc.sendInputEvent({type:'keyUp',keyCode:'Tab'}); await settle(); await pause(60)
      assert.equal(await js('document.activeElement.ariaLabel'),name)
      assert(await js(`(() => {const b=document.activeElement.getBoundingClientRect(), g=document.activeElement.parentElement.getBoundingClientRect();return b.top>=g.top && b.bottom<=g.bottom})()`), 'Tab scrolls the whole focused target into view')
    }
    assert.equal(await js('document.querySelector("[role=tooltip]")?.textContent'),'Settings')
    const contrast = await js(`(() => {
      const b=document.activeElement, nav=document.querySelector('nav'), canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
      const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const ring=getComputedStyle(b).getPropertyValue('--tw-ring-color');
      const ratio=bg=>{const a=lum(rgb(ring)),z=lum(rgb(bg));return (Math.max(a,z)+.05)/(Math.min(a,z)+.05)};
      const colors=getComputedStyle(nav);return {ring,focusVisible:b.matches(':focus-visible'),boxShadow:getComputedStyle(b).boxShadow,background:ratio(colors.backgroundColor),hover:ratio(colors.getPropertyValue('--accent'))};
    })()`)
    assert(contrast.focusVisible); assert(contrast.background>=3 && contrast.hover>=3)
    console.log(theme+' focus contrast '+JSON.stringify(contrast))
    wc.sendInputEvent({type:'keyDown',keyCode:'Enter'}); wc.sendInputEvent({type:'char',keyCode:'\r'}); wc.sendInputEvent({type:'keyUp',keyCode:'Enter'}); await settle(); await pause(350)
    assert.equal(await js('document.activeElement.getAttribute("aria-current")'),'page')
    const activeContrast = await js(`(() => {
      const b=document.activeElement, nav=document.querySelector('nav'), ctx=document.createElement('canvas').getContext('2d');
      const pixel=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(nav).backgroundColor;ctx.fillRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
      const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const a=lum(pixel(getComputedStyle(b).getPropertyValue('--tw-ring-color'))),z=lum(pixel(getComputedStyle(b).backgroundColor));return (Math.max(a,z)+.05)/(Math.min(a,z)+.05);
    })()`)
    assert(activeContrast>=3); console.log(theme+' active contrast '+activeContrast)
    const point=await js(`(() => {const b=document.activeElement.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`)
    wc.sendInputEvent({type:'mouseMove', x:point.x*2, y:point.y*2}); await pause(80)
    wc.sendInputEvent({type:'mouseMove', x:300, y:100}); await pause(80)
    assert.equal(await js('document.querySelector("[role=tooltip]")?.textContent'),'Settings')

    wc.sendInputEvent({type:'keyDown',keyCode:'Escape'}); wc.sendInputEvent({type:'keyUp',keyCode:'Escape'}); await pause(60)
    assert.equal(await js('document.querySelector("[role=tooltip]")'),null)
    for (const height of [900,600]) {
      win.setContentSize(900,height); await pause(100); wc.setZoomFactor(height===600?2:1)
      await js(`document.documentElement.style.fontSize='12px';document.getElementById('text-scaling')?.remove();document.activeElement.blur();document.querySelector('[aria-label="Main views"]').scrollTop=0`)
      await pause(200)
      assert.equal(await js('innerHeight'),height/(height===600?2:1)); console.log('capture',theme,height,wc.getZoomFactor())
      fs.writeFileSync(join(output,theme+'-'+(height===600?'minimum-200pct':'normal')+'.png'),(await wc.capturePage()).toPNG())
    }
  }
  fs.writeFileSync(join(output,'layout-matrix.json'),JSON.stringify(results,null,2))
  console.log('PASS: '+results.length+' layout combinations; real keyboard Tab, Enter, Escape; light/dark focus contrast. 15/17px classic scrollbars measured with clientWidth; screenshots captured')
  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Accessibility.enable')
  const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree')
  const nav = nodes.find(n => n.role?.value === 'navigation')
  assert.equal(nav.name.value, 'Primary')
  const groups = nav.childIds.map(id => nodes.find(n => n.nodeId === id))
  assert.deepEqual(groups.map(n => [n.role.value, n.name.value]), [['group', 'Main views'], ['group', 'Settings']])
  assert.equal(nodes.find(n => n.nodeId === groups[1].childIds[0]).name.value, 'Settings')
  fs.writeFileSync(join(output, 'accessibility-tree.json'), JSON.stringify({ navigation: nav, groups }, null, 2))
  const point = await js(`(() => {const b=document.querySelector('[aria-label="Settings"] button').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', ...point}); await pause(100)
  assert.equal(await js('document.querySelector("[role=tooltip]")?.textContent'), 'Settings')
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', x:300, y:100}); await pause(100)
  assert.equal(await js('document.querySelector("[role=tooltip]")'), null)
  console.log('PASS: accessibility tree and unfocused pointer tooltip behavior')
  win.destroy(); app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
