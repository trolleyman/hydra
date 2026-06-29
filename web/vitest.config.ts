import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

// Unit-test config, kept separate from vite.config.ts so the app build is
// untouched. jsdom gives the pure-logic modules a real localStorage/DOM; the
// react plugin is here so future component/hook tests (@testing-library/react)
// transform TSX. Tests import { describe, it, expect } from 'vitest' explicitly
// (globals off) so they need no extra tsconfig types.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // localStorage is polyfilled in setup.ts (jsdom doesn't expose one here).
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
