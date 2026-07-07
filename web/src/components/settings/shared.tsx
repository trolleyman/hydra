import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { readLocal, writeLocal } from '../../lib/storage'

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'codex' | 'defaults'

// A labelled block at the top of settings: a Title-Case heading, an optional
// one-line description, then the control(s). Used for Theme / Scope / Agent.
// When `collapsible`, the heading becomes a chevron toggle that hides the body;
// pass `storageKey` to remember the open/closed state across visits.
export function SettingSection({
  title,
  description,
  action,
  children,
  collapsible = false,
  defaultCollapsed = false,
  storageKey,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  collapsible?: boolean
  defaultCollapsed?: boolean
  storageKey?: string
}) {
  const [collapsed, setCollapsed] = useState(() => {
    if (!collapsible) return false
    if (storageKey) {
      const v = readLocal(storageKey)
      if (v === '1') return true
      if (v === '0') return false
    }
    return defaultCollapsed
  })
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    if (storageKey) writeLocal(storageKey, next ? '1' : '0')
  }
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2">
        {collapsible ? (
          <button type="button" onClick={toggle} className="flex items-center gap-1 -ml-1 cursor-pointer group">
            <ChevronRight className={`w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 group-hover:text-gray-700 dark:group-hover:text-gray-300">{title}</h2>
          </button>
        ) : (
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        )}
        {action}
      </div>
      {description && !collapsed && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      {!collapsed && <div className="mt-2">{children}</div>}
    </div>
  )
}

// ── ScopeTabs ─────────────────────────────────────────────────────────────────
// The tab strip at the top of a settings page selecting which settings store is
// being edited (project config.toml / user config.toml / this browser), with a
// one-line description of the active tab underneath. Shared by both settings
// pages so the strips can't drift apart.
export function ScopeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  description,
}: {
  tabs: { id: T; label: string }[]
  active: T
  onSelect: (id: T) => void
  description: string
}) {
  return (
    <div className="mb-6">
      <div className="flex border-b border-gray-200 dark:border-gray-700" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => onSelect(t.id)}
            className={`px-4 py-2 -mb-px text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              active === t.id
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{description}</p>
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
