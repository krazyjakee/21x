import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { dangerousToolReason } from './tool-safety'

const workspace = '/home/someone/.config/21x/workspaces/task-1'
const bash = (command: string) => dangerousToolReason({ toolName: 'Bash', input: { command }, workspaceDir: workspace })

describe('dangerousToolReason', () => {
  it.each([
    'npm test',
    'rm -rf node_modules dist',
    `rm -rf ${workspace}/build`,
    'rm -rf /tmp/scratch',
    'git clean -fdx && git reset --hard',
    'find . -name "*.log" -delete',
    'chmod -R 755 scripts',
    'mv old.ts new.ts',
    'sudo apt-get install -y jq',
  ])('lets ordinary work run: %s', (command) => {
    expect(bash(command)).toBeNull()
  })

  it.each([
    ['rm -rf /', 'filesystem root'],
    ['sudo rm -rf --no-preserve-root /', 'filesystem root'],
    ['rm -rf /etc/nginx', 'system path'],
    ['rm -rf ~', 'home directory'],
    ['rm -rf ~/Documents', 'outside the task workspace'],
    ['rm -rf ../../other-task', 'outside the task workspace'],
    ['cd x && rm -r /usr/lib/thing', 'system path'],
    ['find /var/log -name "*.gz" -delete', 'system path'],
    ['mkfs.ext4 /dev/sdb1', 'erase a disk'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'disk device'],
    ['sudo shutdown -h now', 'shutdown'],
    ['chown -R me:me /', 'ownership'],
  ])('asks before %s', (command, reason) => {
    expect(bash(command)).toContain(reason)
  })

  it('reads array commands (Codex) and stated commands (OpenCode, Pi)', () => {
    expect(dangerousToolReason({ input: { command: ['bash', '-lc', 'rm -rf /etc/x'] }, workspaceDir: workspace })).toContain('system path')
    expect(dangerousToolReason({ commands: ['Allow rm -rf /etc/synthetic?'] })).toContain('system path')
  })

  it('asks before file tools write into system directories, not elsewhere', () => {
    expect(dangerousToolReason({ toolName: 'Write', input: { file_path: '/etc/hosts', content: 'x' }, workspaceDir: workspace })).toContain('system path')
    expect(dangerousToolReason({ toolName: 'Edit', input: { file_path: `${workspace}/src/a.ts` }, workspaceDir: workspace })).toBeNull()
    expect(dangerousToolReason({ toolName: 'Write', input: { file_path: `${homedir()}/notes.md` }, workspaceDir: workspace })).toBeNull()
  })

  it('does not treat written file content as a command', () => {
    expect(dangerousToolReason({ toolName: 'Write', input: { file_path: `${workspace}/clean.sh`, content: 'rm -rf /' }, workspaceDir: workspace })).toBeNull()
  })

  it('ignores tools that neither run commands nor write', () => {
    expect(dangerousToolReason({ toolName: 'mcp__task-management__update_project_status', input: { status: 'ok' }, workspaceDir: workspace })).toBeNull()
  })
})
