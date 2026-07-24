import { useEffect, type ReactNode } from 'react'
import { CircleCheck, CircleX, LoaderCircle, RotateCcw } from 'lucide-react'
import { ensureReviewConfig, useProjectStore } from '../../stores/projectStore'
import type { ReviewConfig } from '../../api/models/ReviewConfig'
import { StorageKeys } from '../../lib/storage'
import { SettingSection } from './shared'
import { ProviderIcon } from '../ReviewControls'
import { Tooltip } from '../Tooltip'

const inputClass =
  'px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm'

// SCOPE_FILE names the file a save at each scope writes to, shown in the section
// description so it is obvious where a value lands. Review is only offered under
// the project and local scopes (it is repo-specific), so 'user' never shows.
const SCOPE_FILE: Record<'project' | 'local' | 'user', string> = {
  project: '.hydra/config.toml (shared with your team)',
  local: '.hydra/config.local.toml (personal, never committed)',
  user: '~/.config/hydra/config.toml',
}

// ReviewSection edits the raw [review] table for ONE config layer (the scope tab
// the page is on). Every field is optional: leave it inherited and it falls
// through to the layer below (project -> built-in defaults). So provider /
// target / branch template naturally live in the shared Project config, while
// personal tweaks (publish-when-green) go under the Local tab. The section is a
// collapsible card (collapsed by default) since most people rarely touch it.
export function ReviewSection({
  review,
  onChange,
  projectId,
  scope,
}: {
  review: ReviewConfig | null | undefined
  onChange: (r: ReviewConfig | null) => void
  projectId: string | null
  scope: 'project' | 'local' | 'user'
}) {
  // The resolved (effective) config comes from the shared project-store cache,
  // filled once per project by whichever consumer asks first - not refetched on
  // every mount of this section. The settings save handler force-refreshes it,
  // so the "effective" hints below track a saved [review] change.
  const resolved = useProjectStore((s) => (projectId ? s.reviewConfigs[projectId] : undefined)) ?? null
  useEffect(() => {
    if (projectId) void ensureReviewConfig(projectId)
  }, [projectId])

  const r = review ?? {}

  // set writes one field at this layer; null clears it (back to inherit). When
  // the whole table ends up empty, emit null so no [review] block is written.
  function set<K extends keyof ReviewConfig>(key: K, val: ReviewConfig[K] | null) {
    const next = { ...r, [key]: val } as ReviewConfig
    const cleaned: ReviewConfig = {}
    ;(Object.keys(next) as (keyof ReviewConfig)[]).forEach((k) => {
      const v = next[k]
      if (v === null || v === undefined) return
      if (Array.isArray(v) && v.length === 0) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[k] = v
    })
    onChange(Object.keys(cleaned).length ? cleaned : null)
  }

  return (
    <SettingSection
      title="Review / Merge requests"
      description={`How Hydra publishes heads as forge MRs/PRs. Fields left inherited fall through to the layer below. Saving writes to ${SCOPE_FILE[scope]}. Never put a token here; auth is handled by gh/glab on the host.`}
      collapsible
      defaultCollapsed
      storageKey={StorageKeys.settingsReviewCollapsed}
    >
      <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
        <div className="flex flex-col gap-3 px-3.5 py-3 text-sm">
          <Row label="Provider">
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={r.provider ?? ''} onChange={(v) => set('provider', v || null)} options={[['', 'Inherit'], ['auto', 'auto (detect from remote)'], ['github', 'github'], ['gitlab', 'gitlab']]} />
              {resolved?.provider ? (
                <Hint>
                  <ProviderIcon provider={resolved.provider} className="w-3.5 h-3.5" />
                  effective: {resolved.provider}
                </Hint>
              ) : (
                <span className="text-xs text-amber-600 dark:text-amber-400">could not auto-detect - pick github or gitlab</span>
              )}
            </div>
          </Row>
          <Row label="Remote">
            <div className="flex items-center gap-2 flex-wrap">
              <Text value={r.remote ?? ''} placeholder={resolved?.remote || 'origin'} onChange={(v) => set('remote', v || null)} className="w-40" />
              {resolved?.remote_url && <span className="text-xs text-gray-400 font-mono truncate">{resolved.remote_url}</span>}
            </div>
          </Row>
          <Row label="Branch template">
            <Text value={r.push_branch_template ?? ''} placeholder={resolved?.push_branch_template || '{id}'} onChange={(v) => set('push_branch_template', v || null)} className="w-64 font-mono" />
          </Row>
          <Row label="Defaults">
            <div className="flex flex-col gap-1.5">
              <Bool label="Open MRs as draft" value={r.draft} effective={resolved?.draft} onChange={(v) => set('draft', v)} />
              <Bool label="Request squash on merge" value={r.squash} effective={resolved?.squash} onChange={(v) => set('squash', v)} />
              <Bool label="Delete source branch on merge" value={r.delete_remote_branch} effective={resolved?.delete_remote_branch} onChange={(v) => set('delete_remote_branch', v)} />
              <Bool label="Gate publish on local tests" value={r.require_local_tests} effective={resolved?.require_local_tests} onChange={(v) => set('require_local_tests', v)} />
              <Bool label="Arm publish-when-green on new heads" value={r.publish_when_green} effective={resolved?.publish_when_green} onChange={(v) => set('publish_when_green', v)} />
            </div>
          </Row>
          {resolved && (
            <Row label="Auth">
              <span className="inline-flex items-center gap-1.5">
                {resolved.auth}
                {resolved.auth === 'cli' &&
                  (resolved.authenticated ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CircleCheck className="w-4 h-4" /> {resolved.auth_status || 'authenticated'}
                    </span>
                  ) : resolved.authenticated === false ? (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <CircleX className="w-4 h-4" /> {resolved.auth_status || 'not authenticated - run gh/glab auth login'}
                    </span>
                  ) : (
                    // Auth fields absent = the background gh/glab check hasn't
                    // finished; the store polls until it lands.
                    <Tooltip content="Checking gh/glab auth status...">
                      <LoaderCircle className="w-4 h-4 animate-spin text-gray-400 dark:text-gray-500" />
                    </Tooltip>
                  ))}
              </span>
            </Row>
          )}
        </div>
      </div>
    </SettingSection>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400 pt-1.5">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">{children}</span>
}

function Text({ value, placeholder, onChange, className = '' }: { value: string; placeholder?: string; onChange: (v: string) => void; className?: string }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${inputClass} ${className}`} />
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  )
}

// Bool is a nullable-boolean control: a checkbox showing the value in force, with
// a reset (to inherit) affordance once you have overridden it at this layer. When
// inherited it mirrors the effective value in a muted style with an "inherited"
// tag; clicking it sets an explicit override at this layer.
function Bool({ label, value, effective, onChange }: { label: string; value: boolean | null | undefined; effective: boolean | null | undefined; onChange: (v: boolean | null) => void }) {
  const overridden = value != null
  const shown = overridden ? value : !!effective
  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" checked={shown} onChange={(e) => onChange(e.target.checked)} className="cursor-pointer" />
        <span className={overridden ? '' : 'text-gray-500 dark:text-gray-400'}>{label}</span>
      </label>
      {overridden ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          title="Reset to inherited"
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      ) : (
        <span className="text-[11px] text-gray-400 dark:text-gray-500">inherited</span>
      )}
    </div>
  )
}
