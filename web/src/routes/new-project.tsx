import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { FolderPicker } from '../components/FolderPicker'
import { useProjectStore } from '../stores/projectStore'

export const Route = createFileRoute('/new-project')({
  component: NewProjectPage,
})

function NewProjectPage() {
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { createProject, setLastProjectId } = useProjectStore()
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!path.trim()) {
      setError('Please enter a project path')
      return
    }
    setError('')
    setLoading(true)
    try {
      const project = await createProject(path.trim())
      setLastProjectId(project.id)
      router.navigate({ to: '/$projectId', params: { projectId: project.id } })
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-md">
        <div className="mb-6">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center mb-4">
            <span className="text-white font-bold text-lg">H</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">New Project</h1>
          <p className="text-gray-500 text-sm mt-1">
            Select a Git repository folder to manage with Hydra.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Project folder
            </label>
            <FolderPicker
              value={path}
              onChange={setPath}
              placeholder="/path/to/your/project"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Adding project…' : 'Add Project'}
          </button>
        </form>
      </div>
    </div>
  )
}
