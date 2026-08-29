import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  clearScreen: false,
  optimizeDeps: {
    // Prebundle every editor entry used by the fixture before Playwright opens
    // it. Discovering @tiptap/pm/view after the first test otherwise makes Vite
    // reload the page in the middle of that test.
    include: ['@tiptap/core', '@tiptap/pm/history', '@tiptap/pm/state', '@tiptap/pm/view'],
  },
  server: {
    fs: { allow: ['../..'] },
  },
})
