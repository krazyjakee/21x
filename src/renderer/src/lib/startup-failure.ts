/**
 * What the desktop window shows when 21x cannot start. Runs before the
 * application (and its stylesheet) loads, so it styles itself inline and
 * shows only the fixed product wording from the native bootstrap status.
 */

const DEFAULT_TITLE = '21x couldn’t start'
const DEFAULT_BODY = 'Its background service did not answer. Try again; if it still fails, close 21x and open it again.'

const STOP_CONFIRM = 'If the old folder is on a drive that isn’t connected, reconnect it and reopen 21x instead. Otherwise: your tasks stay, but their workspaces, repositories and attachments will be empty. 21x will use its own folders from now on and will not go back to the old one, even if it reappears. 21x and the previous app will also stop preventing each other from running. Stop using it?'
const STOP_DONE = 'Done. Close 21x and open it again.'
const STOP_FOLDER_BACK = 'The old folder is back, so nothing was changed. Close 21x and open it again.'
const STOP_FAILED = 'That did not work, and nothing was changed. Close 21x, open it again and try once more.'

/** Asks once more first: a folder on a disconnected drive looks deleted too. */
function stopUsingOldFolderControl(body: HTMLElement, stop: () => Promise<boolean>): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = 'Stop using the old folder'
  Object.assign(control.style, {
    alignSelf: 'flex-start', padding: '8px 16px', border: '1px solid #52525b', borderRadius: '8px',
    background: 'transparent', color: '#e4e4e7', fontSize: '14px', cursor: 'pointer'
  })
  let confirmed = false
  control.addEventListener('click', () => {
    if (!confirmed) {
      confirmed = true
      body.textContent = STOP_CONFIRM
      control.textContent = 'Yes, stop using it'
      return
    }
    control.disabled = true
    void stop().then(changed => { body.textContent = changed ? STOP_DONE : STOP_FOLDER_BACK }, () => { body.textContent = STOP_FAILED })
      .finally(() => control.remove())
  })
  return control
}

/** Replace the root with a readable failure screen. With no `retry`, reloading cannot help, so there is no Try again control. */
export function renderStartupFailure(root: HTMLElement, explanation: string | undefined, retry: (() => void) | null, stopUsingOldFolder?: () => Promise<boolean>): void {
  const copy = { title: DEFAULT_TITLE, body: explanation || DEFAULT_BODY }
  root.replaceChildren()
  root.setAttribute('role', 'alert')
  Object.assign(root.style, {
    display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: '32px',
    background: '#18181b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif'
  })
  const panel = document.createElement('div')
  Object.assign(panel.style, { maxWidth: '440px', display: 'flex', flexDirection: 'column', gap: '12px' })
  const title = document.createElement('h1')
  title.textContent = copy.title
  Object.assign(title.style, { margin: '0', fontSize: '20px', fontWeight: '600' })
  const body = document.createElement('p')
  body.textContent = copy.body
  Object.assign(body.style, { margin: '0', fontSize: '14px', lineHeight: '1.5', color: '#a1a1aa' })
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Try again'
  Object.assign(button.style, {
    alignSelf: 'flex-start', marginTop: '8px', padding: '8px 16px', border: '0', borderRadius: '8px',
    background: '#2563eb', color: '#fff', fontSize: '14px', cursor: 'pointer'
  })
  panel.append(title, body)
  if (retry) {
    button.addEventListener('click', retry, { once: true })
    panel.append(button)
  }
  if (stopUsingOldFolder) panel.append(stopUsingOldFolderControl(body, stopUsingOldFolder))
  root.append(panel)
}
