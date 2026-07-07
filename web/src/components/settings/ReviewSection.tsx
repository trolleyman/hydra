import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { api } from '../../stores/apiClient'
import type { ReviewConfigResponse } from '../../api/models/ReviewConfigResponse'
import { SettingSection } from './shared'
import { ProviderIcon } from '../ReviewControls'

// ReviewSection surfaces the effective, resolved [review] config for a project
// plus the live forge-CLI auth status (NON_LOCAL_INTEGRATION.md 3.2). It is
// read-only: editing is done in .hydra/config.toml (shared) or config.local.toml
// (personal), so the section explains where to change each value rather than
// writing it. A refresh button re-checks auth ("test connection").
export function ReviewSection({ projectId }: { projectId: string | undefined }) {
  const [cfg, setCfg] = useState<ReviewConfigResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      setCfg(await api.default.getReviewConfig(projectId))
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return (
    <SettingSection
      title="Review / Merge requests"
      description="How Hydra publishes heads as forge MRs/PRs. These are the effective, resolved values - edit them in .hydra/config.toml (shared with your team) or .hydra/config.local.toml (personal). Never put a token in either; auth is handled by gh/glab on the host."
      action={
        <button
          onClick={() => void load()}
          disabled={loading}
          title="Re-check forge auth"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shrink-0"
        >
          {loading ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Test connection
        </button>
      }
    >
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {/* First load: show a placeholder instead of an empty block that then
          pops in once the fetch resolves. */}
      {projectId && !cfg && !error && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3.5 py-3 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircle className="w-4 h-4 animate-spin" />
          Loading review settings...
        </div>
      )}
      {cfg && (
        <div className="flex flex-col gap-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 px-3.5 py-3">
          <Row label="Provider">
            {cfg.provider ? (
              <span className="inline-flex items-center gap-1.5">
                <ProviderIcon provider={cfg.provider} className="w-4 h-4" />
                {cfg.provider}
                <span className="text-xs text-gray-400">({cfg.provider_setting === 'auto' ? 'auto-detected' : 'set'})</span>
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">could not auto-detect - set [review] provider = "github" or "gitlab"</span>
            )}
          </Row>
          <Row label="Remote">
            <span className="font-mono">{cfg.remote}</span>
            {cfg.remote_url && <span className="text-xs text-gray-400 ml-2 font-mono">{cfg.remote_url}</span>}
          </Row>
          {cfg.browse_url && (
            <Row label="Repository">
              <a href={cfg.browse_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                {cfg.browse_url}
                <ExternalLink className="w-3 h-3" />
              </a>
            </Row>
          )}
          <Row label="Target branch">
            <span className="font-mono">{cfg.target_branch}</span>
          </Row>
          <Row label="Auth">
            <span className="inline-flex items-center gap-1.5">
              {cfg.auth}
              {cfg.auth === 'cli' &&
                (cfg.authenticated ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CircleCheck className="w-4 h-4" /> {cfg.auth_status || 'authenticated'}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <CircleX className="w-4 h-4" /> {cfg.auth_status || 'not authenticated - run gh/glab auth login'}
                  </span>
                ))}
            </span>
          </Row>
          <Row label="Primary action">
            {cfg.default_action === 'create_mr' ? 'Create MR' : 'Merge (local)'}
          </Row>
          <Row label="Branch template">
            <span className="font-mono">{cfg.push_branch_template || '{id}'}</span>
          </Row>
          <Row label="Defaults">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {cfg.draft ? 'draft' : 'ready'} · {cfg.squash ? 'squash' : 'merge commit'} ·{' '}
              {cfg.delete_remote_branch ? 'delete branch on merge' : 'keep branch'} ·{' '}
              {cfg.require_local_tests ? 'gate on local tests' : 'no local gate'}
              {cfg.publish_when_green ? ' · publish-when-green armed by default' : ''}
            </span>
          </Row>
          {cfg.protected_branches && cfg.protected_branches.length > 0 && (
            <Row label="Protected">
              <span className="font-mono text-xs">{cfg.protected_branches.join(', ')}</span>
            </Row>
          )}
        </div>
      )}
    </SettingSection>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
