import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import { fileURLToPath } from 'node:url'

// Unit-test config, kept separate from vite.config.ts so the app build is
// untouched. jsdom gives the pure-logic modules a real localStorage/DOM; the
// react plugin is here so future component/hook tests (@testing-library/react)
// transform TSX. Tests import { describe, it, expect } from 'vitest' explicitly
// (globals off) so they need no extra tsconfig types.
export default defineConfig({
  plugins: [react()],
  // Pin the Vite/Vitest cache to web/node_modules. Resolved relative to a
  // detected project root, it otherwise lands in the GIT-ROOT node_modules
  // (vitest run from web/ walks up to the worktree root), creating a stray
  // top-level node_modules/.vite the repo doesn't ignore. Anchoring it to this
  // file's directory keeps the cache — and the repo root — where they belong.
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
  test: {
    environment: 'jsdom',
    // localStorage is polyfilled in setup.ts (jsdom doesn't expose one here).
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
