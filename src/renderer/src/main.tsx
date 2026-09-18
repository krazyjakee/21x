import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
// Eagerly boot the theme store so it applies the persisted theme and starts
// listening for OS-level light/dark changes before first paint.
import '@/stores/theme-store'
import { platform } from '@/lib/platform'

// Suppress xterm.js internal "toFixed is not a function" crash.
// xterm's _reportWindowsOptions() calls .toFixed() on dimension values that
// are undefined when the renderer hasn't computed layout yet (e.g. during
// window moves, canvas viewport transitions, or shell startup queries).
// The error is cosmetic — xterm recovers on the next valid render cycle.
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('toFixed is not a function')) {
    e.preventDefault()
  }
})

// Tag <html> with platform so CSS can adapt (e.g. Windows title-bar padding)
document.documentElement.setAttribute('data-platform', platform)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
