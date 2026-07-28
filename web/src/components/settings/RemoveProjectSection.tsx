import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Trash2, LoaderCircle } from 'lucide-react'
import type { ProjectInfo } from '../../api'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import { useProjectStore } from '../../stores/projectStore'
import { pillText } from '../../lib/branchPills'

// RemoveProjectSection is the "danger zone" at the bottom of a project's settings:
// it unregisters the project from Hydra. Removal is deliberately non-destructive
// (see the copy) - it only drops the project from Hydra's list and stops its
// background services; files, git history, agents, worktrees and branches all
// survive, and re-adding the same folder restores them. This replaced the little
// hover "x" that used to sit in the project switcher.
export function RemoveProjectSection({ project }: { project: ProjectInfo }) {
  const navigate = useNavigate()
  const [removing, setRemoving] = useState(false)
  const { projects, selectedProjectId, setProjects, setSelectedProjectId } = useProjectStore()

  async function doRemove() {
    setRemoving(true)
    try {
      await api.default.removeProject(project.id)
      setProjects(projects.filter((p) => p.id !== project.id))
      if (selectedProjectId === project.id) setSelectedProjectId(null)
      useToastStore.getState().show({ message: pillText`Removed "${project.name}" from Hydra.`, type: 'success' })
      navigate({ to: '/' })
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Remove Failed',
        message: `Failed to remove project: ${formatError(err)}`,
        type: 'error',
      })
    } finally {
      setRemoving(false)
    }
  }

  function confirmRemove() {
    useDialogStore.getState().show({
      title: 'Remove project',
      message: `Remove "${project.name}" from Hydra? Your files, git history and existing agents are all kept - re-adding the folder brings them back. Only the project's background services are stopped.`,
      type: 'warning',
      confirmLabel: 'Remove project',
      showCancel: true,
      onConfirm: () => {
        void doRemove()
      },
    })
  }

  return (
    <div className="mt-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-200 dark:border-red-900/50 p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Remove project</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
        Removes <span className="font-medium text-gray-700 dark:text-gray-300">{project.name}</span> from Hydra's
        project list - it disappears from the sidebar and project switcher. This does{' '}
        <span className="font-medium">not</span> delete anything on disk: your project folder, code and git history are
        left untouched, and its agents, worktrees and branches are kept (re-adding the same folder brings them back).
        Running agents are not stopped or killed - only the project's background services
        (<code className="font-mono text-[11px]">[services.&lt;name&gt;]</code> in config.toml) are stopped.
      </p>
      <button
        onClick={confirmRemove}
        disabled={removing}
        className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
      >
        {removing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        {removing ? 'Removing...' : 'Remove project'}
      </button>
    </div>
  )
}
