// Test harness only: loads the actual built application and its production IPC.
// No shipping bundle imports this file or enables an automation endpoint.
const { app, session } = require('electron')
const { readFileSync, statSync, lstatSync, realpathSync, writeSync } = require('node:fs')
const { join, resolve, basename, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const { performance } = require('node:perf_hooks')
const root = resolve(__dirname, '../..')
const profile = process.env.TWENTYONEX_BASELINE_PROFILE
let phase = 'profile'
try {
  const pipe = statSync(3)
  if (!profile || !basename(profile).startsWith('21x-desktop-baseline-') || realpathSync(profile) !== profile ||
      dirname(profile) !== realpathSync(tmpdir()) || !lstatSync(profile).isDirectory() ||
      readFileSync(join(profile, '.baseline-owned'), 'utf8') !== process.env.TWENTYONEX_BASELINE_TOKEN ||
      statSync(profile).uid !== process.getuid() || !(pipe.isFIFO() || pipe.isSocket())) throw new Error()
  app.setPath('userData', profile)
  app.setPath('sessionData', join(profile, 'session'))
} catch { app.exit(1); return }
const start = performance.now()
const pause = ms => new Promise(done => setTimeout(done, ms))
const report = { schemaVersion: 1, engine: 'electron', passed: false }
const finish = () => {
  try { writeSync(3, JSON.stringify(report) + '\n') } catch { app.exit(1); return }
  app.quit()
}
// No remote content/accounts are needed for this fixture. Production IPC,
// database initialization, native modules and renderer remain unchanged.
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/i.test(details.url) })
  })
})
let attached = false
app.on('browser-window-created', (_, win) => {
  if (attached) return
  attached = true
  win.webContents.once('did-finish-load', async () => {
    try {
      phase = 'interactive'
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await win.webContents.executeJavaScript('!!document.querySelector("nav button") && !!window.electronAPI?.db')) break
        await pause(50)
      }
      if (!await win.webContents.executeJavaScript('!!document.querySelector("nav button") && !!window.electronAPI?.db')) throw new Error()
      report.interactiveMs = performance.now() - start
      phase = 'task-workload'
      const metrics = await win.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI;
        const started = performance.now();
        const initial = await api.db.getTasks();
        const listMs = performance.now() - started;
        let task = initial.find(row => row.title === 'Desktop baseline fixture');
        const freshProfile = !task;
        const createStart = performance.now();
        if (!task) task = await api.db.createTask({ title: 'Desktop baseline fixture' });
        const createMs = freshProfile ? performance.now() - createStart : null;
        const updateStart = performance.now();
        await api.db.updateTask(task.id, { description: 'Persisted baseline content' });
        const updateMs = performance.now() - updateStart;
        const saved = await api.db.getTask(task.id);
        if (saved?.description !== 'Persisted baseline content') throw new Error('fixture');
        sessionStorage.setItem('21x-baseline-task', task.id);
        return { listMs, createMs, updateMs, freshProfile, taskCount: initial.length };
      })()`)
      Object.assign(report, metrics)
      phase = 'reload'
      const reloadStart = performance.now()
      await new Promise((done, fail) => {
        win.webContents.once('did-finish-load', done)
        win.webContents.once('did-fail-load', fail)
        win.reload()
      })
      const persisted = await win.webContents.executeJavaScript(`(async () => {
        const task = await window.electronAPI.db.getTask(sessionStorage.getItem('21x-baseline-task'));
        return task?.title === 'Desktop baseline fixture' && task?.description === 'Persisted baseline content';
      })()`)
      if (!persisted) throw new Error()
      report.reloadAndReadMs = performance.now() - reloadStart
      phase = 'idle'
      await pause(3000)
      report.electronVersion = process.versions.electron
      report.nodeVersion = process.versions.node
      report.passed = true
      report.quitRequestedMs = performance.now() - start
      finish()
    } catch {
      report.failurePhase = phase
      finish()
    }
  })
})
process.on('uncaughtException', () => { report.failurePhase = phase; finish() })
phase = 'application-bootstrap'
require(join(root, 'out/main/index.js'))
