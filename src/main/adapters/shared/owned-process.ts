import { execFile, type ChildProcess } from 'node:child_process'

const owners = new WeakMap<ChildProcess, OwnedAgentProcess>()

/** Observe at spawn: exit and a successful kill are not pipe-close receipts. */
export function observeAgentProcess(child: ChildProcess, processGroup = false): OwnedAgentProcess {
  let owner = owners.get(child)
  if (!owner) {
    owner = new OwnedAgentProcess(child, processGroup)
    owners.set(child, owner)
  }
  return owner
}

class OwnedAgentProcess {
  private closed = false
  private readonly receipt: Promise<void>
  private stopping?: Promise<void>

  constructor(private readonly child: ChildProcess, private readonly processGroup: boolean) {
    this.receipt = new Promise(resolve => child.once('close', () => { this.closed = true; resolve() }))
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const raw = this.joinClose()
    this.stopping = raw
    void raw.then(() => { this.stopping = undefined }, () => { this.stopping = undefined })
    return raw
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.closed) return
    try {
      if (this.processGroup && this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch {
      // Neither ESRCH nor a failed signal acknowledges the outstanding close.
    }
  }

  private async joinClose(): Promise<void> {
    if (this.closed) return
    let escalation: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    let treeStop: Promise<void> | undefined
    if (this.processGroup && process.platform === 'win32' && this.child.pid) {
      treeStop = new Promise(resolve => {
        execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { timeout: 4000, windowsHide: true }, () => resolve())
      })
    } else this.signal('SIGTERM')
    try {
      escalation = setTimeout(() => this.signal('SIGKILL'), 1000)
      await Promise.race([this.receipt, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('AGENT_PROCESS_CLOSE_UNACKNOWLEDGED')), 5000)
      })])
    } finally {
      clearTimeout(escalation)
      clearTimeout(deadline)
      // A Windows tree-stop command is raw work owned by this retirement too.
      await treeStop
    }
  }
}
