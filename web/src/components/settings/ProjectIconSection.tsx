import { useState } from 'react'
import type { ProjectInfo } from '../../api'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { useProjectStore } from '../../stores/projectStore'
import { useToastStore } from '../../stores/toastStore'
import { ProjectIcon } from '../../lib/projectIcon'
import { SettingSection } from './shared'

// A few one-click presets to make the field discoverable. Mix of emoji and
// lucide icon names (resolved by ProjectIcon just like a typed value).
const PRESETS = ['🚀', '🐍', '⚙️', '📦', '🌐', '🔥', 'Rocket', 'Database', 'Terminal', 'Cloud', 'Bot', 'Flame']

// Editor for a project's custom icon, shown on the project settings page. The
// icon lives in the project's .hydra/config.toml (committed with the repo), set
// via its own endpoint - so this saves independently of the main config Save
// button, and updates the project store immediately so the dropdown / switcher
// reflect the change without a reload.
export function ProjectIconSection({ project }: { project: ProjectInfo }) {
  const { projects, setProjects } = useProjectStore()
  const [draft, setDraft] = useState(project.icon ?? '')
  const [saving, setSaving] = useState(false)

  const current = (project.icon ?? '').trim()
  const dirty = draft.trim() !== current

  async function save() {
    if (saving || !dirty) return
    setSaving(true)
    try {
      const updated = await api.default.setProjectIcon(project.id, { icon: draft.trim() })
      setProjects(projects.map((p) => (p.id === project.id ? updated : p)))
      setDraft(updated.icon ?? '')
      useToastStore.getState().show({ message: 'Project icon updated', type: 'success' })
    } catch (err) {
      useToastStore.getState().show({ message: `Failed to set icon: ${formatError(err)}`, type: 'error' })
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
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setDraft(preset)}
            title={preset}
            className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-200 hover:border-blue-400 dark:hover:border-blue-500 transition-colors cursor-pointer"
          >
            <ProjectIcon icon={preset} projectId={project.id} size={18} />
          </button>
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
        An emoji, a lucide-react icon name (e.g. Rocket - see lucide.dev/icons), or an image path/URL ending in .png/.svg/.ico/.jpg. A relative path is resolved from the project root.
      </p>
    </SettingSection>
  )
}
