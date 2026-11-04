/**
 * What the desktop window shows when 21x cannot start. Runs before the
 * application (and its stylesheet) loads, so it styles itself inline and
 * shows only the fixed product wording from the native bootstrap status.
 */

const DEFAULT_TITLE = '21x couldn’t start'
const DEFAULT_BODY = 'Its background service did not answer. Try again; if it still fails, close 21x and open it again.'

/** Replace the root with a readable failure screen and a Try again control. */
export function renderStartupFailure(root: HTMLElement, explanation: string | undefined, retry: () => void): void {
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
  root.append(panel)
}
