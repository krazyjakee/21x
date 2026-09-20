import React from 'react'
import { createRoot } from 'react-dom/client'
import { NavRail } from '../../src/renderer/src/components/layout/NavRail'
import './fixture.css'

createRoot(document.getElementById('root')!).render(<>
  <div className="ui-scale bg-background h-9 shrink-0 flex items-center px-3">Settings rail — isolated renderer</div>
  <div className="app-chrome-field flex flex-1 min-h-0 overflow-hidden bg-background">
    <NavRail />
    <main className="flex-1 min-w-0 rounded-2xl border border-border bg-card m-2 p-4">
      Production NavRail and styles; no application services.
    </main>
  </div>
  <div className="bg-background shrink-0 h-4" />
</>)
