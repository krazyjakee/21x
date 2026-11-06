import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
// Eagerly boot the theme store so it applies the persisted theme and starts
// listening for OS-level light/dark changes before first paint.
import '@/stores/theme-store'
import { platform } from '@/lib/platform'

// Tag <html> with platform so CSS can adapt (e.g. Windows title-bar padding)
document.documentElement.setAttribute('data-platform', platform)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
