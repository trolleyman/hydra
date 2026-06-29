// Vitest setup, run before every test file (see vitest.config.ts setupFiles).
// Registers @testing-library/jest-dom matchers for future component tests, and
// provides an in-memory localStorage: jsdom (as wired under vitest here) doesn't
// expose one, but the storage-backed modules (storage.ts, projectView,
// agentViewPrefs, …) read the bare global. Cleared between tests so cases don't
// leak persisted state into each other.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null }
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string) { this.store.set(k, String(v)) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}

const memory = new MemoryStorage()
for (const target of new Set<object>([globalThis, globalThis.window])) {
  Object.defineProperty(target, 'localStorage', { value: memory, writable: true, configurable: true })
}

// jsdom doesn't implement HTMLCanvasElement.getContext and logs a noisy "Not
// implemented" error the first time any imported module touches a canvas (the
// artifact diff viewers' pixel-diff overlays — DiffCanvas / VideoDiffView). No
// test renders those overlays, and the real code already treats a null context
// as "can't diff", so stub getContext to return null: same effective behaviour,
// without the warning. Override the prototype (not a jsdom internal) so it sticks
// regardless of how the canvas was created.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => null
}

afterEach(() => {
  // Unmount any React trees rendered via @testing-library/react. Vitest runs
  // with globals off, so RTL can't auto-register this itself — without it the
  // jsdom DOM accumulates across cases in a component test file.
  cleanup()
  localStorage.clear()
})
