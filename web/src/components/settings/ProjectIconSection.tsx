import { useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import type { ProjectInfo } from '../../api'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { useProjectStore } from '../../stores/projectStore'
import { useToastStore } from '../../stores/toastStore'
import { ProjectIcon } from '../../lib/projectIcon'
import { useLucideIcon } from '../../lib/lucideIcons'
import { IMAGE_ICON_RE, isGlyphIcon } from '../../lib/projectIconValue'
import { Tooltip } from '../Tooltip'
import { IconPicker } from './IconPicker'
import { SettingSection } from './shared'
import { pillText } from '../../lib/branchPills'

// A few one-click presets to make the field discoverable. Mix of emoji and
// lucide icon names (resolved by ProjectIcon just like a typed value). The
// lucide names are written the way lucide.dev spells them; the field accepts
// "Rocket" just the same.
const PRESETS = ['🚀', '🐍', '⚙️', '📦', '🌐', '🔥', 'rocket', 'database', 'terminal', 'cloud', 'bot', 'flame']

// Editor for a project's custom icon, shown on the project settings page. The
// icon lives in the project's .hydra/config.toml (committed with the repo), set
// via its own endpoint - so this saves independently of the main config Save
// button, and updates the project store immediately so the dropdown / switcher
// reflect the change without a reload.
export function ProjectIconSection({ project }: { project: ProjectInfo }) {
  const { projects, setProjects } = useProjectStore()
  const [draft, setDraft] = useState(project.icon ?? '')
  const [saving, setSaving] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  const current = (project.icon ?? '').trim()
  const dirty = draft.trim() !== current

  // A word that is neither an image nor a lucide icon renders as a bare initial
  // on a tile, which is easy to mistake for "still loading" - say so instead.
  const value = draft.trim()
  const { icon: resolved, pending } = useLucideIcon(value)
  const unknownName =
    value !== '' && !resolved && !pending && !IMAGE_ICON_RE.test(value) && !isGlyphIcon(value)

  async function save() {
    if (saving || !dirty) return
    setSaving(true)
    try {
      const updated = await api.default.setProjectIcon(project.id, { icon: draft.trim() })
      setProjects(projects.map((p) => (p.id === project.id ? updated : p)))
      setDraft(updated.icon ?? '')
      useToastStore.getState().show({ message: 'Project icon updated', type: 'success' })
    } catch (err) {
      useToastStore.getState().show({ message: pillText`Failed to set icon: ${formatError(err)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingSection
      title="Project icon"
      description="Shown in the project switcher and dropdown, in place of the folder icon. Stored in this project's .hydra/config.toml."
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-200">
          <ProjectIcon icon={draft} projectId={project.id} size={22} />
        </div>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }}
          placeholder="emoji, icon name, or image path"
          className="flex-1 min-w-0 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500"
        />
        <Tooltip content={browsing ? 'Hide the icon browser' : 'Browse all lucide icons'}>
          <button
            type="button"
            onClick={() => setBrowsing((b) => !b)}
            aria-expanded={browsing}
            aria-label="Browse icons"
            className={`shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
              browsing
                ? 'border-blue-400 dark:border-blue-500 text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
                : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {unknownName && !browsing && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 leading-snug">
          No lucide icon is called "{value}" - it falls back to a letter tile.{' '}
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            className="underline underline-offset-2 hover:no-underline cursor-pointer"
          >
            Browse icons
          </button>{' '}
          to find one.
        </p>
      )}

      {browsing && <IconPicker value={draft} onPick={setDraft} />}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <Tooltip key={preset} content={preset}>
            <button
              type="button"
              onClick={() => setDraft(preset)}
              aria-label={preset}
              className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-200 hover:border-blue-400 dark:hover:border-blue-500 transition-colors cursor-pointer"
            >
              <ProjectIcon icon={preset} projectId={project.id} size={18} />
            </button>
          </Tooltip>
        ))}
        <button
          type="button"
          onClick={() => setDraft('')}
          className="h-8 px-3 flex items-center rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 transition-colors cursor-pointer"
        >
          Reset
        </button>
      </div>

      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500 leading-snug">
        An emoji, a lucide icon name (browse them above, or see lucide.dev/icons - "folder-dot" and "FolderDot" both work), or an image path/URL ending in .png/.svg/.ico/.jpg. A relative path is resolved from the project root.
      </p>
    </SettingSection>
  )
}
