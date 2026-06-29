import { useThemeStore, THEME_MODES, THEME_MODE_ICON, THEME_MODE_LABEL } from '../../lib/theme'
import { SettingSection } from './shared'

// Theme (light / dark / system). A client-only preference via the shared store —
// no explanation text, just the segmented control under a "Theme" heading.
export function ThemeSection() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  return (
    <SettingSection title="Theme">
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
        {THEME_MODES.map((m) => {
          const Icon = THEME_MODE_ICON[m]
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {THEME_MODE_LABEL[m]}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}
