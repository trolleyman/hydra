import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import './index.css'

import { routeTree } from './routeTree.gen'
import { AuthGate } from './components/AuthGate'
import { LightboxHost } from './components/LightboxHost'
import { installToastHarness } from './lib/toastHarness'

// Screenshot/test harness hook (dormant unless its localStorage flag is set).
installToastHarness()

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <AuthGate>
        <RouterProvider router={router} />
        <LightboxHost />
      </AuthGate>
    </StrictMode>,
  )
}