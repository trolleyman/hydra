import { useState, type ReactNode } from 'react'
import { ChevronRight, LoaderCircle, Save } from 'lucide-react'
import { readLocal, writeLocal } from '../../lib/storage'
import { TopBarPortal } from '../TopBarPortal'
import { Tooltip } from '../Tooltip'
import { CollapseSlide } from '../CollapseSlide'

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'codex' | 'defaults'

// The settings pages' share of the global top bar, portalled into __root's slot
// the way the agent page puts its toolbar there. The bar already renders the
// "Settings" crumb, so a page-level header of its own would just say "Settings"
// twice - this is the whole page chrome, and it is only the action.
//
// The button doubles as the unsaved-changes indicator: filled blue while the
// page holds a draft, quiet otherwise. Without that, the navigation blocker's
// "discard them?" confirm was the first and only hint that the page considered
// itself dirty.
export function SettingsSaveAction({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
}) {
  return (
    <TopBarPortal>
      {/* ml-auto: the slot is a flex row shared with the crumb, so the action
          takes the far end of the bar. */}
      <div className="ml-auto shrink-0 flex items-center gap-1.5">
        <Tooltip content={dirty ? 'Save settings - you have unsaved changes' : 'Save settings'} side="bottom">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            aria-label="Save settings"
            className={`shrink-0 h-8 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg text-[13px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              dirty
                ? 'bg-blue-600 hover:bg-blue-500 text-white border border-blue-700/30 shadow-sm'
                : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {saving ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span className="whitespace-nowrap optical-center">{saving ? 'Saving...' : 'Save'}</span>
          </button>
        </Tooltip>
      </div>
    </TopBarPortal>
  )
}

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
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="flex items-center gap-1 -ml-1 cursor-pointer group"
          >
            <ChevronRight
              className={`w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}
            />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 group-hover:text-gray-700 dark:group-hover:text-gray-300 optical-center">{title}</h2>
          </button>
        ) : (
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        )}
        {action}
      </div>
      {collapsible ? (
        /* The shared glide (see CollapseSlide). keepMounted: a settings section
           holds live form state - a half-typed field must not be thrown away by
           folding the section over it. A section renders at its resolved row
           size on first paint (the stored state is read in the useState
           initializer), so only a user toggle animates. Only the collapsible
           path is wrapped: the clipping the slide needs would cut off anything a
           plain section overflows. */
        <CollapseSlide open={!collapsed} keepMounted>
          {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
          <div className="mt-2">{children}</div>
        </CollapseSlide>
      ) : (
        <>
          {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
          <div className="mt-2">{children}</div>
        </>
      )}
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
