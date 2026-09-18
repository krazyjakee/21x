import type { GhCliStatus } from '@/types/electron'
import { platform } from '@/lib/platform'

function installCommands(): string[] {
  if (platform === 'win32') return ['winget install GitHub.cli']
  if (platform === 'linux') return ['sudo apt install gh', 'sudo dnf install gh']
  return ['brew install gh']
}

/**
 * Setup guidance for a missing or unauthenticated gh CLI. 20x never runs these
 * commands or handles credentials — the user runs them in their own terminal.
 */
export function GhCliGuidance({ status }: { status: GhCliStatus | null | undefined }) {
  const installed = status?.installed ?? false

  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        {installed
          ? 'GitHub CLI is installed but not signed in. Run this in your terminal, then re-check:'
          : 'GitHub features use the GitHub CLI (gh). Install it, sign in from your terminal, then re-check:'}
      </p>
      {!installed && installCommands().map((cmd) => (
        <code key={cmd} className="block bg-muted px-3 py-2 rounded select-all">{cmd}</code>
      ))}
      <code className="block bg-muted px-3 py-2 rounded select-all">gh auth login</code>
    </div>
  )
}
