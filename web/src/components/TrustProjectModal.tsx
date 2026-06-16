import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { ProjectInfo } from '../api'
import { formatError } from '../api/format_error'

// TrustProjectModal asks the user to review and trust a project's
// .hydra/config.toml before Hydra acts on it. That file is read straight from
// the repository and can run arbitrary code (pre_spawn_script, unsafe_host
// artifact commands) and weaken the sandbox, so an unreviewed project is gated:
// no agents can be spawned and host artifact commands are forced back into the
// sandbox until the user accepts. Shown whenever the selected project is
// untrusted. Trust is per-project (a one-time decision), so later edits to the
// config don't re-prompt.
export function TrustProjectModal({
  project,
  onTrusted,
  onCancel,
}: {
  project: ProjectInfo
  onTrusted: (updated: ProjectInfo) => void
  onCancel: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [exists, setExists] = useState(false)
  const [loading, setLoading] = useState(true)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.default
      .getProjectConfigToml(project.id)
      .then((res) => {
        if (cancelled) return
        setContent(res.content)
        setExists(res.exists)
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.id])

  async function handleTrust() {
    if (trusting) return
    setTrusting(true)
    setError(null)
    try {
      const updated = await api.default.trustProject(project.id)
      onTrusted(updated)
    } catch (err) {
      setError(formatError(err))
      setTrusting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-dialog-title"
      >
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <ShieldAlert className="w-6 h-6 text-amber-500 shrink-0" />
          <h3 id="trust-dialog-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Trust this project?
          </h3>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            <span className="font-medium text-gray-900 dark:text-gray-100">{project.name}</span>{' '}
            <span className="font-mono text-xs text-gray-400 dark:text-gray-500 break-all">{project.path}</span>
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mt-3">
            Hydra reads this project's <code className="font-mono text-xs">.hydra/config.toml</code> from the
            repository. It can run arbitrary code on spawn (<code className="font-mono text-xs">pre_spawn_script</code>),
            run host commands unconfined (<code className="font-mono text-xs">unsafe_host</code> artifacts), and widen the
            sandbox. Only trust it if you recognize this project and its config.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
            Until you trust it, agents can't be spawned and artifact commands stay sandboxed. You trust the project
            once; later edits to the config won't ask again.
          </p>

          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              .hydra/config.toml
            </div>
            {loading ? (
              <div className="text-xs text-gray-400 dark:text-gray-500 py-6 text-center">Loading config…</div>
            ) : !exists ? (
              <div className="text-xs text-gray-400 dark:text-gray-500 italic border border-dashed border-gray-200 dark:border-gray-700 rounded-lg px-3 py-4 text-center">
                No <span className="font-mono not-italic">.hydra/config.toml</span> in this project — nothing
                repo-controlled to run.
              </div>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 max-h-72 overflow-y-auto text-gray-800 dark:text-gray-200">
                {content}
              </pre>
            )}
          </div>

          {error && <p className="text-xs text-red-500 mt-3 leading-snug">{error}</p>}
        </div>

        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-3 border-t border-gray-100 dark:border-gray-700">
          <button
            onClick={onCancel}
            disabled={trusting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            Don't trust
          </button>
          <button
            onClick={handleTrust}
            disabled={loading || trusting}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {trusting ? 'Trusting…' : 'Trust project'}
          </button>
        </div>
      </div>
    </div>
  )
}
