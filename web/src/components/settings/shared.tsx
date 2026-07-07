import type { ReactNode } from 'react'

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'codex' | 'defaults'

// A labelled block at the top of settings: a Title-Case heading, an optional
// one-line description, then the control(s). Used for Theme / Scope / Agent.
export function SettingSection({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {action}
      </div>
      {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

// A small uppercase heading that groups several SettingSections (e.g. the
// browser-local preferences vs. the user config file on the User tab).
export function SettingsGroupHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mt-8 mb-4 first:mt-0">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{title}</h2>
      {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>}
    </div>
  )
}

// ── EnabledToggle ─────────────────────────────────────────────────────────────
// A small on/off switch used to enable or disable a single artifact or service
// without deleting it. Green + "Enabled" when on; muted + "Disabled" when off.
export function EnabledToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer select-none">
      <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
      <div className="w-9 h-5 bg-gray-300 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400/40 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
      <span className={`ml-2 text-xs font-semibold ${enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`}>
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
    </label>
  )
}
