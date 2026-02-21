import { useState, useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Sidebar } from '../../../components/Sidebar'
import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import { api } from '../../../stores/apiClient'
import type { DirectoryInfo } from '../../../api'

export const Route = createFileRoute('/$projectId/repository/')({
  component: RepositoryPage,
})

function RepositoryPage() {
  const { projectId } = Route.useParams()
  const [dirInfo, setDirInfo] = useState<DirectoryInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { setLastProjectId } = useProjectStore()
  const { agents, fetchAgents } = useAgentStore()
  const projectAgents = agents[projectId] ?? []

  useEffect(() => {
    setLastProjectId(projectId)
    fetchAgents(projectId)
    setLoading(true)
    api.default.getRepositoryDirectory(projectId, '')
      .then(setDirInfo)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar projectId={projectId} agents={projectAgents} />
      <main className="flex-1 overflow-y-auto p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Repository</h1>

        {loading && (
          <div className="text-gray-400 text-sm">Loading…</div>
        )}

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
        )}

        {dirInfo && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 text-sm text-gray-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="font-mono">/</span>
            </div>
            <div className="divide-y divide-gray-100">
              {dirInfo.entries.map((entry) => (
                <div key={entry.name} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
                  {entry.type === 'directory' ? (
                    <svg className="w-4 h-4 text-blue-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  )}
                  <Link
                    to="/$projectId/repository/blob/$branch/$path"
                    params={{ projectId, branch: 'HEAD', path: entry.name }}
                    className="text-sm text-gray-700 hover:text-blue-600 font-mono flex-1"
                  >
                    {entry.name}
                  </Link>
                  {entry.size !== null && entry.size !== undefined && (
                    <span className="text-xs text-gray-400">{formatSize(entry.size)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {dirInfo?.readme && (
          <div className="mt-6 bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-sm font-medium text-gray-500 mb-4">README</h2>
            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{dirInfo.readme}</pre>
          </div>
        )}
      </main>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
