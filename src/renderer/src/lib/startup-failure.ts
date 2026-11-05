/**
 * What the desktop window shows when 21x cannot start. Runs before the
 * application (and its stylesheet) loads, so it styles itself inline and
 * shows only the fixed product wording from the native bootstrap status.
 */

const DEFAULT_TITLE = '21x couldn’t start'
const DEFAULT_BODY = 'Its background service did not answer. Try again; if it still fails, close 21x and open it again.'

const STOP_CONFIRM = 'Your tasks stay in 21x, and from now on it keeps its work in its own folders. Anything that was in the old folder stays gone, and 21x will not go back to that folder if it reappears. Stop using it?'
const STOP_DONE = 'Done. Close 21x and open it again.'
const STOP_FOLDER_BACK = 'The old folder is back, so nothing was changed. Close 21x and open it again.'
const STOP_FAILED = 'That did not work, and nothing was changed. Close 21x, open it again and try once more.'

/** Asks once more first: a folder on a disconnected drive looks deleted too. */
function stopUsingOldFolderControl(body: HTMLElement, retry: HTMLElement, stop: () => Promise<boolean>): HTMLButtonElement {
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
      .finally(() => { control.remove(); retry.remove() })
  })
  return control
}

/** Replace the root with a readable failure screen and a Try again control. */
export function renderStartupFailure(root: HTMLElement, explanation: string | undefined, retry: () => void, stopUsingOldFolder?: () => Promise<boolean>): void {
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
  button.addEventListener('click', retry, { once: true })
  panel.append(title, body, button)
  if (stopUsingOldFolder) panel.append(stopUsingOldFolderControl(body, button, stopUsingOldFolder))
  root.append(panel)
}
