import { mountSyntheticTaskSlice } from './task-slice'
import type { TauriDesktopApi } from '../renderer/src/lib/tauri-desktop-transport'

const native = (window as unknown as {
  __TAURI__?: TauriDesktopApi
}).__TAURI__
let sliceMounted = false
const message = document.querySelector<HTMLParagraphElement>('#message')!
const output = document.querySelector<HTMLPreElement>('#result')!
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#status, #ping, #probe')]

async function run(command: string, args?: Record<string, unknown>): Promise<void> {
  if (!native) {
    message.textContent = 'Open this experiment with pnpm tauri:dev to connect the native host.'
    return
  }
  for (const button of buttons) button.disabled = true
  message.textContent = 'Checking runtime…'
  try {
    const result = await native.core.invoke<unknown>(command, args)
    if (command === 'engine_status' && result && typeof result === 'object' &&
      'syntheticDesktop' in result && result.syntheticDesktop === true && !sliceMounted) {
      sliceMounted = true
      document.querySelector<HTMLButtonElement>('#probe')!.hidden = true
      void mountSyntheticTaskSlice(native).catch(() => { message.textContent = 'The isolated task service is unavailable.' })
    }
    output.textContent = JSON.stringify(result, null, 2)
    message.textContent = 'Check finished.'
  } catch {
    // Native failures may contain third-party details. The UI shows a fixed error.
    output.textContent = ''
    message.textContent = 'The runtime check failed. Check the redacted native host logs.'
  } finally {
    for (const button of buttons) button.disabled = false
  }
}

document.querySelector('#status')!.addEventListener('click', () => { void run('engine_status') })
document.querySelector('#ping')!.addEventListener('click', () => {
  void run('engine_invoke', { operation: 'engine.ping', payload: {} })
})
document.querySelector('#probe')!.addEventListener('click', () => {
  void run('engine_invoke', { operation: 'engine.probe', payload: {} })
})
void run('engine_status')
