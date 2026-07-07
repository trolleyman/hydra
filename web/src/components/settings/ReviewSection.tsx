import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { api } from '../../stores/apiClient'
import type { ReviewConfigResponse } from '../../api/models/ReviewConfigResponse'
import type { ReviewConfigUpdate } from '../../api/models/ReviewConfigUpdate'
import { formatError } from '../../api/format_error'
import { useProjectStore } from '../../stores/projectStore'
import { SettingSection } from './shared'
import { ProviderIcon } from '../ReviewControls'

// The editable subset of the review config, mirrored into local form state. The
// derived fields (resolved provider, remote_url, browse_url, auth status) are
// shown read-only and never sent.
interface ReviewForm {
  provider: string
  remote: string
  target_branch: string
  default_action: string
  push_branch_template: string
  draft: boolean
  squash: boolean
  delete_remote_branch: boolean
  require_local_tests: boolean
  publish_when_green: boolean
}

function toForm(c: ReviewConfigResponse): ReviewForm {
  return {
    provider: c.provider_setting || 'auto',
    remote: c.remote || 'origin',
    target_branch: c.target_branch || 'main',
    default_action: c.default_action || 'merge',
    push_branch_template: c.push_branch_template || '{id}',
    draft: c.draft ?? true,
    squash: c.squash ?? true,
    delete_remote_branch: c.delete_remote_branch ?? true,
    require_local_tests: c.require_local_tests ?? true,
    publish_when_green: c.publish_when_green ?? false,
  }
}

// changedFields returns only the form fields that differ from the baseline, so a
// Save writes just the user's edits to config.local.toml and leaves everything
// else inheriting config.toml / the built-in defaults.
function changedFields(form: ReviewForm, base: ReviewForm): ReviewConfigUpdate {
  const out: ReviewConfigUpdate = {}
  if (form.provider !== base.provider) out.provider = form.provider
  if (form.remote !== base.remote) out.remote = form.remote
  if (form.target_branch !== base.target_branch) out.target_branch = form.target_branch
  if (form.default_action !== base.default_action) out.default_action = form.default_action
  if (form.push_branch_template !== base.push_branch_template) out.push_branch_template = form.push_branch_template
  if (form.draft !== base.draft) out.draft = form.draft
  if (form.squash !== base.squash) out.squash = form.squash
  if (form.delete_remote_branch !== base.delete_remote_branch) out.delete_remote_branch = form.delete_remote_branch
  if (form.require_local_tests !== base.require_local_tests) out.require_local_tests = form.require_local_tests
  if (form.publish_when_green !== base.publish_when_green) out.publish_when_green = form.publish_when_green
  return out
}

const inputClass =
  'px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm'

// ReviewSection edits the project's [review] config. Edits are written to the
// personal .hydra/config.local.toml (the .gitignored, last-wins layer) via
// saveReviewConfig; only changed fields are sent, so unedited values keep
// inheriting config.toml. Derived values (resolved provider, repo URL, live
// forge auth) are shown read-only. "Test connection" re-checks auth.
export function ReviewSection({ projectId }: { projectId: string | undefined }) {
  const [cfg, setCfg] = useState<ReviewConfigResponse | null>(null)
  const [form, setForm] = useState<ReviewForm | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const setReviewConfigInStore = useProjectStore((s) => s.setReviewConfig)

  function apply(c: ReviewConfigResponse) {
    setCfg(c)
    setForm(toForm(c))
    // Keep the shared cache (Create MR dialog prefill) in sync with edits.
    if (projectId) setReviewConfigInStore(projectId, c)
  }

  async function load() {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      apply(await api.default.getReviewConfig(projectId))
    } catch (e) {
      setError(formatError(e))
    }
    setLoading(false)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const base = cfg ? toForm(cfg) : null
  const dirty = !!(form && base && JSON.stringify(form) !== JSON.stringify(base))

  async function save() {
    if (!projectId || !form || !base) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await api.default.saveReviewConfig(projectId, changedFields(form, base))
      apply(updated)
    } catch (e) {
      setSaveError(formatError(e))
    }
    setSaving(false)
  }

  function set<K extends keyof ReviewForm>(key: K, value: ReviewForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f))
  }

  return (
    <SettingSection
      title="Review / Merge requests"
      description="How Hydra publishes heads as forge MRs/PRs. Edits are saved to your personal .hydra/config.local.toml (never committed) and override the team's .hydra/config.toml. Never put a token here; auth is handled by gh/glab on the host."
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
      {/* First load: a placeholder instead of an empty block that pops in once
          the fetch resolves. */}
      {projectId && !cfg && !error && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3.5 py-3 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircle className="w-4 h-4 animate-spin" />
          Loading review settings...
        </div>
      )}
      {cfg && form && (
        <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
          <div className="flex flex-col gap-3 px-3.5 py-3 text-sm">
            <Row label="Provider">
              <div className="flex items-center gap-2 flex-wrap">
                <select value={form.provider} onChange={(e) => set('provider', e.target.value)} className={inputClass}>
                  <option value="auto">auto (detect from remote)</option>
                  <option value="github">github</option>
                  <option value="gitlab">gitlab</option>
                </select>
                {cfg.provider ? (
                  <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <ProviderIcon provider={cfg.provider} className="w-3.5 h-3.5" />
                    resolved: {cfg.provider}
                  </span>
                ) : (
                  <span className="text-xs text-amber-600 dark:text-amber-400">could not auto-detect - pick github or gitlab</span>
                )}
              </div>
            </Row>
            <Row label="Remote">
              <div className="flex items-center gap-2 flex-wrap">
                <input value={form.remote} onChange={(e) => set('remote', e.target.value)} className={`${inputClass} font-mono w-40`} />
                {cfg.remote_url && <span className="text-xs text-gray-400 font-mono truncate">{cfg.remote_url}</span>}
              </div>
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
              <input value={form.target_branch} onChange={(e) => set('target_branch', e.target.value)} className={`${inputClass} font-mono w-48`} />
            </Row>
            <Row label="Primary action">
              <select value={form.default_action} onChange={(e) => set('default_action', e.target.value)} className={inputClass}>
                <option value="merge">Merge (local)</option>
                <option value="create_mr">Create MR</option>
              </select>
            </Row>
            <Row label="Branch template">
              <input value={form.push_branch_template} onChange={(e) => set('push_branch_template', e.target.value)} className={`${inputClass} font-mono w-64`} />
            </Row>
            <Row label="Defaults">
              <div className="flex flex-col gap-1.5">
                <Check label="Open MRs as draft" checked={form.draft} onChange={(v) => set('draft', v)} />
                <Check label="Request squash on merge" checked={form.squash} onChange={(v) => set('squash', v)} />
                <Check label="Delete source branch on merge" checked={form.delete_remote_branch} onChange={(v) => set('delete_remote_branch', v)} />
                <Check label="Gate publish on local tests" checked={form.require_local_tests} onChange={(v) => set('require_local_tests', v)} />
                <Check label="Arm publish-when-green on new heads" checked={form.publish_when_green} onChange={(v) => set('publish_when_green', v)} />
              </div>
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
            {cfg.protected_branches && cfg.protected_branches.length > 0 && (
              <Row label="Protected">
                <span className="font-mono text-xs">{cfg.protected_branches.join(', ')}</span>
                <span className="text-xs text-gray-400 ml-2">(set in config.toml)</span>
              </Row>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-3.5 py-2.5">
            {saveError && <span className="text-xs text-red-600 dark:text-red-400 mr-auto whitespace-pre-wrap break-words">{saveError}</span>}
            {dirty && !saveError && <span className="text-xs text-gray-400 mr-auto">Unsaved changes</span>}
            <button
              onClick={() => cfg && apply(cfg)}
              disabled={!dirty || saving}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-default"
            >
              Reset
            </button>
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving && <LoaderCircle className="w-3.5 h-3.5 animate-spin" />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </SettingSection>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400 pt-1.5">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="cursor-pointer" />
      {label}
    </label>
  )
}
