// Terminal geometry shared between the live terminal (AgentTerminal), the spawn
// form, and the user settings page.
//
// The terminal panel's layout is the same across agents/windows, so the last
// geometry a client successfully sent is a good seed for the next one. The
// backend uses it as the *initial* PTY size when it starts or resumes a session,
// so a fresh/resumed agent renders at the right width immediately instead of
// flashing the classic 80x24 default and reflowing - those narrow-wrapped bytes
// can't be re-flowed once a wider client replays the scrollback.

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, readJSON, writeJSON, singleFieldStorage } from './storage'

// Fallback height (rows) when the user hasn't chosen one and no last-height
// geometry exists yet - a comfortable default for a typical browser panel.
export const DEFAULT_SPAWN_ROWS = 24
// Guardrails for the user-chosen default so a fat-fingered value can't request a
// degenerate or giant PTY. Mirrors the backend's own 1..2000 clamp.
export const MIN_SPAWN_ROWS = 4
export const MAX_SPAWN_ROWS = 200

export interface TerminalGeometry {
  cols: number
  rows: number
}

// The last geometry a live terminal measured and sent, or null if none yet.
export function loadLastGeometry(): TerminalGeometry | null {
  return readJSON(StorageKeys.terminalGeometry, (v) => {
    const g = v as { cols?: unknown; rows?: unknown }
    if (g && typeof g.cols === 'number' && typeof g.rows === 'number' && g.cols > 0 && g.rows > 0) {
      return { cols: g.cols, rows: g.rows }
    }
    return null
  })
}

export function saveLastGeometry(cols: number, rows: number) {
  writeJSON(StorageKeys.terminalGeometry, { cols, rows })
}

// The user-chosen default spawn height (rows), or null when unset (use the
// built-in fallback). Read at module load so non-React callers (the spawn form)
// see the latest value without subscribing.
export function loadDefaultRows(): number | null {
  const raw = readLocal(StorageKeys.terminalDefaultRows)
  if (raw === null) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(MAX_SPAWN_ROWS, Math.max(MIN_SPAWN_ROWS, n))
}

// spawnGeometry resolves the geometry to send when spawning a new head. Width
// prefers the browser's last measured width (and so is omitted entirely when this
// browser has never run a terminal, letting the server fall back to the project's
// last known width). Height prefers the last measured height, then the user's
// configured default, then the built-in fallback - so a fresh browser still spawns
// at a sensible height rather than 24 rows of 80-column wrapping.
export function spawnGeometry(): { cols?: number; rows: number } {
  const last = loadLastGeometry()
  const rows = last?.rows ?? loadDefaultRows() ?? DEFAULT_SPAWN_ROWS
  return last ? { cols: last.cols, rows } : { rows }
}

// A tiny store so the settings control and any future reader stay in sync. The
// control writes the store (which persists to localStorage); the spawn form reads
// localStorage directly at spawn time, so it always sees the saved value.
//
// persist owns the read-on-init + write-on-set; singleFieldStorage keeps the
// stored value as the bare rows string under the existing key, reusing
// loadDefaultRows' validation/clamping - so loadDefaultRows/spawnGeometry can
// keep reading the raw value directly at spawn time, outside the store.
interface DefaultRowsState {
  rows: number | null
  setRows: (rows: number | null) => void
}

export const useDefaultRowsStore = create<DefaultRowsState>()(
  persist(
    (set) => ({
      rows: loadDefaultRows(),
      setRows: (rows) => set({ rows }),
    }),
    {
      name: StorageKeys.terminalDefaultRows,
      storage: singleFieldStorage('rows', loadDefaultRows, (rows) =>
        writeLocal(StorageKeys.terminalDefaultRows, rows === null ? null : String(rows)),
      ),
      partialize: (s) => ({ rows: s.rows }),
    },
  ),
)

// Convenience hook for the settings control: current value + setter.
export function useDefaultTerminalRows(): [number | null, (rows: number | null) => void] {
  const rows = useDefaultRowsStore((s) => s.rows)
  const setRows = useDefaultRowsStore((s) => s.setRows)
  // Re-sync once on mount in case another tab changed the value while unmounted.
  useEffect(() => {
    useDefaultRowsStore.setState({ rows: loadDefaultRows() })
  }, [])
  return [rows, setRows]
}
