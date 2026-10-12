import { spawn } from 'node:child_process'
import { join } from 'node:path'

function waitBounded(promise, milliseconds) {
  let timer
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, milliseconds) })]).finally(() => clearTimeout(timer))
}

/** Call immediately after spawn so exit/close races cannot miss the receipt. */
export function observeOwnedProcess(child, group = false) {
  let closed = false
  const receipt = new Promise((resolve) => child.once('close', () => { closed = true; resolve() }))
  const signal = async (force) => {
    if (closed || !child.pid) return
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      if (!systemRoot) return
      const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true })
      const killed = new Promise((resolve) => { killer.once('close', resolve); killer.once('error', resolve) })
      await waitBounded(killed, 2000)
      if (killer.exitCode === null) killer.kill()
    } else {
      try { if (group) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); else child.kill(force ? 'SIGKILL' : 'SIGTERM') }
      catch { /* An already-exited owned child is settled by its close receipt. */ }
    }
  }
  return {
    closed: () => closed,
    receipt,
    async stop() {
      await signal(false)
      await waitBounded(receipt, 2000)
      if (!closed) { await signal(true); await waitBounded(receipt, 2000) }
      return closed
    }
  }
}
