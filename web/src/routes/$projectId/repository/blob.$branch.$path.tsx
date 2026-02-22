import { useState, useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Sidebar } from '../../../components/Sidebar'
import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import { api } from '../../../stores/apiClient'
import type { DirectoryInfo, FileMeta } from '../../../api'

export const Route = createFileRoute('/$projectId/repository/blob/$branch/$path')({
  component: RepoBlobPage,
})

type ViewMode = 'directory' | 'file' | 'loading' | 'error'

function RepoBlobPage() {
  const { projectId, branch, path } = Route.useParams()
  const [mode, setMode] = useState<ViewMode>('loading')
  const [dirInfo, setDirInfo] = useState<DirectoryInfo | null>(null)
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [error, setError] = useState('')
  const { setLastProjectId } = useProjectStore()
  const { agents, fetchAgents } = useAgentStore()
  const projectAgents = agents[projectId] ?? []

  useEffect(() => {
    setLastProjectId(projectId)
    fetchAgents(projectId)
    setMode('loading')
    setError('')

    // Try as directory first, then file
    api.default.getRepositoryDirectory(projectId, path, branch)
      .then((info) => {
        setDirInfo(info)
        setMode('directory')
      })
      .catch(() => {
        // Try as file
        api.default.getRepositoryFileMeta(projectId, path, branch)
          .then((meta) => {
            setFileMeta(meta)
            if (!meta.isBinary) {
              return api.default.getRepositoryFile(projectId, path, branch)
                .then((content) => {
                  setFileContent(content as string)
                  setMode('file')
                })
            }
            setMode('file')
          })
          .catch((e: unknown) => {
            setError(String(e))
            setMode('error')
          })
      })
  }, [projectId, branch, path])

  // Build breadcrumb parts
  const parts = path.split('/').filter(Boolean)
  const breadcrumbs = parts.map((part, i) => ({
    name: part,
    path: parts.slice(0, i + 1).join('/'),
  }))

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar projectId={projectId} agents={projectAgents} />
      <main className="flex-1 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm mb-4 flex-wrap">
          <Link
            to="/$projectId/repository"
            params={{ projectId }}
            className="text-blue-600 hover:underline font-mono"
          >
            /
          </Link>
          {breadcrumbs.map((b, i) => (
            <span key={b.path} className="flex items-center gap-1">
              <span className="text-gray-400">/</span>
              {i === breadcrumbs.length - 1 ? (
                <span className="font-mono text-gray-900">{b.name}</span>
              ) : (
                <Link
                  to="/$projectId/repository/blob/$branch/$path"
                  params={{ projectId, branch, path: b.path }}
                  className="text-blue-600 hover:underline font-mono"
                >
                  {b.name}
                </Link>
              )}
            </span>
          ))}
        </div>

        {mode === 'loading' && (
          <div className="text-gray-400 text-sm">Loading…</div>
        )}

        {mode === 'error' && (
          <div className="px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
        )}

        {mode === 'directory' && dirInfo && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="divide-y divide-gray-100">
              {path && (
                <div className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
                  <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                  <Link
                    to="/$projectId/repository/blob/$branch/$path"
                    params={{ projectId, branch, path: parts.slice(0, -1).join('/') || '' }}
                    className="text-sm text-gray-700 hover:text-blue-600 font-mono"
                  >
                    ..
                  </Link>
                </div>
              )}
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
                    params={{
                      projectId,
                      branch,
                      path: path ? `${path}/${entry.name}` : entry.name,
                    }}
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

        {mode === 'file' && fileMeta && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <span className="font-mono">{fileMeta.name}</span>
                <span className="text-gray-400">{formatSize(fileMeta.size)}</span>
                {fileMeta.mimeType && (
                  <span className="text-gray-400">{fileMeta.mimeType}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/projects/${projectId}/repository/file/${path}?branch=${branch}`}
                  download={fileMeta.name}
                  className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 cursor-pointer"
                >
                  Download
                </a>
                <button
                  onClick={() => navigator.clipboard.writeText(fileContent)}
                  className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 cursor-pointer"
                >
                  Copy
                </button>
              </div>
            </div>
            {fileMeta.isBinary ? (
              <div className="px-4 py-8 text-center text-gray-400 text-sm">
                Binary file - use Download to view
              </div>
            ) : (
              <pre className="p-4 text-sm font-mono text-gray-800 overflow-x-auto whitespace-pre leading-relaxed">
                {fileContent}
              </pre>
            )}
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
