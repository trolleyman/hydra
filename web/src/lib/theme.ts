// Theme preference, shared between the app shell (which applies the `dark` class
// and tracks the OS preference) and the Settings page (which renders the
// Appearance control). Kept in one zustand store so both stay in sync - the
// control writes the store, the shell's apply-effect reacts.
//
// Previously this lived inline in __root.tsx with the toggle in the header. The
// header was removed (Claude-style layout), so the control moved into Settings
// and the state had to be hoisted out of the layout component.

import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Sun, Moon, Monitor } from 'lucide-react'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// An explicit light/dark choice, or `system` to follow the OS
// `prefers-color-scheme` and react to changes while the app is open.
export type ThemeMode = 'light' | 'dark' | 'system'

// Cycle order (kept for any future quick-toggle affordance).
export const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}
export const THEME_MODE_ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}
export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}
export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']

// Exported for unit testing. Reads the persisted theme preference, defaulting to
// `system` when nothing valid is stored.
export function loadThemeMode(): ThemeMode {
  const stored = readLocal(StorageKeys.themeMode)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

// persist owns the read-on-init (via the store's storage adapter) and the
// write-on-set, so setMode just updates state. singleFieldStorage keeps the
// stored value as the bare mode string under the existing themeMode key (rather
// than persist's default JSON envelope), reusing loadThemeMode's validation.
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: loadThemeMode(),
      setMode: (mode) => set({ mode }),
    }),
    {
      name: StorageKeys.themeMode,
      storage: singleFieldStorage('mode', loadThemeMode, (mode) =>
        writeLocal(StorageKeys.themeMode, mode),
      ),
      partialize: (s) => ({ mode: s.mode }),
    },
  ),
)

// Mount once at the app root: toggles the `dark` class on <html> from the stored
// mode, and - in `system` mode - keeps tracking the OS preference live.
export function useApplyTheme() {
  const mode = useThemeStore((s) => s.mode)
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const isDark = mode === 'dark' || (mode === 'system' && mql.matches)
      document.documentElement.classList.toggle('dark', isDark)
    }
    apply()
    if (mode === 'system') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
  }, [mode])
}

// useIsDark reports whether dark mode is currently active by observing the `dark`
// class that useApplyTheme toggles on <html>. It tracks all three theme modes
// (including live OS changes in `system` mode) without duplicating the apply
// logic, so non-DOM consumers like the xterm log terminal - which needs explicit
// theme colours rather than CSS classes - can react to theme changes.
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const sync = () => setIsDark(el.classList.contains('dark'))
    const obs = new MutationObserver(sync)
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    sync()
    return () => obs.disconnect()
  }, [])
  return isDark
}
