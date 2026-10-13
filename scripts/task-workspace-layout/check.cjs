const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { attachWindowStartup } = require(process.env.STARTUP_HELPER_PATH)
const url = process.env.TASK_LAYOUT_URL
app.setPath('userData', process.env.TASK_LAYOUT_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
// This harness creates several sequential windows; only its final result quits.
app.on('window-all-closed', () => {})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async predicate => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await pause(30) }
  throw new Error('Timed out waiting for desktop observation')
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith(url) && !details.url.startsWith('data:') && !details.url.startsWith('devtools:')
  }))
  const options = { width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } }
  // Use the production helper with a real, initially unmapped X11 window.
  // Suppress first-paint notification to force the load-completion fallback.
  const fallbackWindow = new BrowserWindow(options)
  const emit = fallbackWindow.emit.bind(fallbackWindow)
  fallbackWindow.emit = (event, ...args) => event === 'ready-to-show' ? false : emit(event, ...args)
  let starts = 0
  attachWindowStartup(fallbackWindow, () => { starts++ })
  assert.equal(fallbackWindow.isVisible(), false)
  await fallbackWindow.loadURL('data:text/html,<h1>Linux startup fallback</h1>')
  await wait(() => fallbackWindow.isVisible())
  assert.equal(starts, 1)
  writeFileSync(join(process.env.TASK_LAYOUT_OUTPUT, 'linux-startup-fallback.png'), (await fallbackWindow.webContents.capturePage()).toPNG())
  emit('ready-to-show')
  fallbackWindow.webContents.emit('did-finish-load')
  await pause(1100)
  assert.equal(starts, 1, 'late first-paint and reload never repeat startup work')
  console.log('PASS: Linux desktop maps the window without ready-to-show; startup runs once')
  fallbackWindow.destroy()

  const firstPaintWindow = new BrowserWindow(options)
  let firstPaintStarts = 0
  attachWindowStartup(firstPaintWindow, () => { firstPaintStarts++ })
  await firstPaintWindow.loadURL('data:text/html,<h1>First paint startup</h1>')
  await wait(() => firstPaintWindow.isVisible())
  await pause(1100)
  assert.equal(firstPaintStarts, 1, 'ready-to-show and fallback converge on one startup')
  firstPaintWindow.destroy()
  const closedWindow = new BrowserWindow(options)
  let closedStarts = 0
  const closedEmit = closedWindow.emit.bind(closedWindow)
  closedWindow.emit = (event, ...args) => event === 'ready-to-show' ? false : closedEmit(event, ...args)
  attachWindowStartup(closedWindow, () => { closedStarts++ })
  await closedWindow.loadURL('data:text/html,<h1>Closed before fallback</h1>')
  closedWindow.destroy()
  const replacement = new BrowserWindow(options)
  await pause(1100)
  assert.equal(closedStarts, 0)
  assert.equal(replacement.isVisible(), false, 'old timers cannot show a replacement window')
  replacement.destroy()
  console.log('PASS: first-paint startup is idempotent; closed-window fallback cannot show replacements')

  const win = new BrowserWindow({ ...options, show: true })
  const wc = win.webContents
  const js = source => wc.executeJavaScript(source)
  wc.on('console-message', event => {
    if (event.level >= 2) console.error('Renderer:', event.message)
  })
  const observations = []
  for (const width of [1400, 900]) for (const zoom of [0.8, 1, 1.25, 1.5]) {
    win.setContentSize(width, 850)
    await win.loadURL(url)
    wc.setZoomFactor(zoom)
    win.focus()
    await wait(() => js('!!document.querySelector(\'textarea[aria-label="Kickoff instructions"]\')'))
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const measurements = await js(`(() => {
      const root = document.querySelector('[data-testid="task-fixture"]');
      const workspace = root.querySelector('.ui-scale');
      const input = document.querySelector('textarea[aria-label="Kickoff instructions"]');
      const title = root.querySelector('h1');
      const style = el => { const s = getComputedStyle(el); return { fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) } };
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } };
      return { root: rect(root), input: rect(input), title: style(title), inputStyle: style(input),
        spacing: getComputedStyle(workspace).getPropertyValue('--spacing').trim(),
        overflow: root.scrollWidth - root.clientWidth,
        controls: [...workspace.querySelectorAll('button, select')].filter(el => el.getBoundingClientRect().width > 0 && !el.closest('[role="menu"]')).map(rect),
        scrollports: [...workspace.querySelectorAll('*')].filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight).length
      };
    })()`)
    assert.equal(measurements.spacing, '4px')
    assert.equal(measurements.title.fontSize, 20)
    assert.equal(measurements.inputStyle.fontSize, 13)
    assert(measurements.inputStyle.lineHeight >= 20)
    assert.equal(measurements.overflow, 0, 'task workspace stays within the window')
    assert(measurements.input.bottom <= measurements.root.bottom + 1 && measurements.input.height >= 40, 'kickoff remains readable and available')
    for (const control of measurements.controls) assert(control.left >= -1 && control.right <= measurements.root.right + 1, 'task controls fit at ' + width + 'px / ' + zoom)
    await js('window.fixture.transcript()')
    await wait(() => js('!!document.querySelector(\'[data-testid="transcript-pane"]\') && !document.querySelector(\'textarea[aria-label="Kickoff instructions"]\')'))
    // DOM mutations can precede Chromium's painted frame. Capture only after
    // React has replaced kickoff and two compositor frames have elapsed.
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const transcript = await js(`(() => { const root = document.querySelector('[data-testid="task-fixture"]'); const pane = document.querySelector('[data-testid="transcript-pane"]'); const r = pane.getBoundingClientRect(); return { overflow: root.scrollWidth-root.clientWidth, width: r.width, height: r.height, bottom: r.bottom, limit: root.getBoundingClientRect().bottom, scaled: !!pane.closest('.ui-scale'), text: pane.textContent } })()`)
    assert.equal(transcript.overflow, 0)
    assert(transcript.scaled && transcript.width >= 200 && transcript.height >= 100)
    assert(transcript.bottom <= transcript.limit + 1)
    assert(transcript.text.includes('The checkout review is ready'))
    observations.push({ width, zoom, measurements, transcript })
    writeFileSync(join(process.env.TASK_LAYOUT_OUTPUT, `task-transcript-${width}-${Math.round(zoom * 100)}.png`), (await wc.capturePage()).toPNG())
    console.log('PASS: task kickoff and transcript at ' + width + 'px / ' + (zoom * 100) + '%')
  }
  writeFileSync(join(process.env.TASK_LAYOUT_OUTPUT, 'measurements.json'), JSON.stringify(observations, null, 2) + '\n')
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
