import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import './index.css'

import { routeTree } from './routeTree.gen'
import { AuthGate } from './components/AuthGate'
import { ImageLightboxProvider } from './components/ImageLightboxContext'

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
        <ImageLightboxProvider>
          <RouterProvider router={router} />
        </ImageLightboxProvider>
      </AuthGate>
    </StrictMode>,
  )
}