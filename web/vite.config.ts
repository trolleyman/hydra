import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'

// API_PORT: port the Go backend listens on (default 8080).
// DEV_PORT: port the Vite dev server listens on (default: Vite default of 5173).
const apiPort = process.env.API_PORT ?? '8080'
const devPort = process.env.DEV_PORT ? parseInt(process.env.DEV_PORT) : undefined
const apiBase = `http://localhost:${apiPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // '@tanstack/router-plugin' must be passed before '@vitejs/plugin-react'
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  clearScreen: false,
  server: {
    port: devPort,
    proxy: {
      '/api': apiBase,
      '/health': apiBase,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
})
