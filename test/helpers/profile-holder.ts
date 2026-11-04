import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PROFILE_LOCK_FILE, TAURI_HOLDER_FILE } from '../../src/main/platform/profile-lock'

const require = createRequire(import.meta.url)
// Each suite runs on its own runtime; the child must load the SQLite built for it.
const sqliteModule = process.env.TAURI_SQLITE_MODULE ?? require.resolve('better-sqlite3')

/** The same SQLite steps as acquireProfileLock, from a separate process. */
const CLAIMANT = `
  const Database = require(process.argv[1]);
  let db;
  process.stdin.once('data', () => {
    try {
      db = new Database(process.argv[2], { timeout: Number(process.argv[3]) });
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('WON\\n');
    } catch {
      if (db && db.open) db.close();
      process.stdout.write('LOST\\n');
    }
  });
  process.stdin.once('end', () => { if (db && db.open) db.close(); process.exit(0) });
  process.stdin.resume();
  process.stdout.write('READY\\n');
`
const running = new Set<ChildProcess>()
const closed = (child: ChildProcess) => new Promise<void>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve()
  else child.once('close', () => resolve())
})

function claimant(root: string, timeoutMs: number) {
  const child = spawn(process.execPath, ['-e', CLAIMANT, sqliteModule, join(root, PROFILE_LOCK_FILE), String(timeoutMs)], { stdio: ['pipe', 'pipe', 'ignore'] })
  running.add(child)
  void closed(child).then(() => running.delete(child))
  const lines: string[] = [], waiting: Array<(line: string) => void> = []
  let partial = ''
  child.stdout!.on('data', (value: Buffer) => {
    const parts = (partial + value.toString()).split('\n')
    partial = parts.pop()!
    for (const line of parts) { const wake = waiting.shift(); if (wake) wake(line); else lines.push(line) }
  })
  const next = () => new Promise<string>((resolve, reject) => {
    const queued = lines.shift()
    if (queued) { resolve(queued); return }
    const deadline = setTimeout(() => reject(new Error('The other process did not answer')), 5000)
    waiting.push(line => { clearTimeout(deadline); resolve(line) })
  })
  return { child, next, claim: () => { child.stdin!.write('GO\n') } }
}

export interface OtherHost {
  /** Dies without cleaning up, as a crash or kill -9 would. */
  crash(): Promise<void>
  quit(): Promise<void>
}

/** Another app as the kernel sees it: a separate process holding the real lock. */
export async function holdProfileElsewhere(root: string, options: { tauri?: boolean } = {}): Promise<OtherHost> {
  const other = claimant(root, 0)
  if (await other.next() !== 'READY') throw new Error('The other process did not start')
  other.claim()
  if (await other.next() !== 'WON') throw new Error('The other process could not take the lock')
  if (options.tauri) writeFileSync(join(root, TAURI_HOLDER_FILE), 'tauri\n')
  return {
    crash: async () => { const done = closed(other.child); other.child.kill('SIGKILL'); await done },
    quit: async () => { const done = closed(other.child); other.child.stdin!.end(); await done }
  }
}

/** Whether another process, which is what the other app is, could take the profile now. */
export async function profileFreeElsewhere(root: string): Promise<boolean> {
  const other = claimant(root, 0)
  if (await other.next() !== 'READY') throw new Error('The other process did not start')
  other.claim()
  const free = await other.next() === 'WON'
  const done = closed(other.child)
  other.child.stdin!.end()
  await done
  return free
}

/** Releases `count` processes at the same instant and counts who owns the profile. */
export async function raceForProfile(root: string, count: number, timeoutMs: number): Promise<{ winners: number; finish(): Promise<void> }> {
  const racers = Array.from({ length: count }, () => claimant(root, timeoutMs))
  await Promise.all(racers.map(async racer => { if (await racer.next() !== 'READY') throw new Error('A racer did not start') }))
  for (const racer of racers) racer.claim()
  // Each winner keeps holding while the rest answer, so a late start cannot win too.
  const results = await Promise.all(racers.map(racer => racer.next()))
  return {
    winners: results.filter(result => result === 'WON').length,
    finish: async () => { await Promise.all(racers.map(racer => { const done = closed(racer.child); racer.child.stdin!.end(); return done })) }
  }
}

export async function stopOtherHosts(): Promise<void> {
  await Promise.all([...running].map(child => { const done = closed(child); child.kill('SIGKILL'); return done }))
}

/** Names, sizes and modification times: any write to the directory changes this. */
export function profileListing(root: string): string[] {
  return readdirSync(root).sort().map(name => {
    const entry = lstatSync(join(root, name))
    return `${name}:${entry.size}:${entry.mtimeMs}`
  })
}
