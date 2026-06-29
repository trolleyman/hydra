// Vitest setup, run before every test file (see vitest.config.ts setupFiles).
// Registers @testing-library/jest-dom matchers for future component tests, and
// provides an in-memory localStorage: jsdom (as wired under vitest here) doesn't
// expose one, but the storage-backed modules (storage.ts, projectView,
// agentViewPrefs, …) read the bare global. Cleared between tests so cases don't
// leak persisted state into each other.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

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

afterEach(() => {
  localStorage.clear()
})
