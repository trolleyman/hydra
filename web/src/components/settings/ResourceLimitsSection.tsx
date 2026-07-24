import type { ReactNode } from 'react'
import type { ResourceLimits } from '../../api/models/ResourceLimits'
import { StorageKeys } from '../../lib/storage'
import { SettingSection } from './shared'
import { InfoTooltip } from '../InfoTooltip'

const inputClass =
  'w-40 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all'

// SCOPE_FILE names the file a save at each scope writes to, shown in the section
// description so it is obvious where a value lands.
const SCOPE_FILE: Record<'project' | 'local' | 'user', string> = {
  project: '.hydra/config.toml (shared with your team)',
  local: '.hydra/config.local.toml (personal, never committed)',
  user: '~/.config/hydra/config.toml (your default for every project)',
}

// ResourceLimitsSection edits the raw [resources] cgroup limits for ONE config
// layer (the scope tab the page is on). The limits apply to every scoped workload
// of the project (agent, preview, service, artifact) via its transient systemd
// scope, so one runaway workload yields to the daemon instead of starving the
// box. Every field is optional: leave it empty and it inherits the layer below
// (project -> user -> built-in defaults). Collapsed by default since most people
// never touch it.
export function ResourceLimitsSection({
  resources,
  onChange,
  scope,
}: {
  resources: ResourceLimits | null | undefined
  onChange: (r: ResourceLimits | null) => void
  scope: 'project' | 'local' | 'user'
}) {
  const r = resources ?? {}

  // set writes one field at this layer; null clears it (back to inherit). When
  // the whole table ends up empty, emit null so no [resources] block is written.
  function set<K extends keyof ResourceLimits>(key: K, val: ResourceLimits[K] | null) {
    const next = { ...r, [key]: val } as ResourceLimits
    const cleaned: ResourceLimits = {}
    ;(Object.keys(next) as (keyof ResourceLimits)[]).forEach((k) => {
      const v = next[k]
      if (v === null || v === undefined) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[k] = v
    })
    onChange(Object.keys(cleaned).length ? cleaned : null)
  }

  return (
    <SettingSection
      title="Resource limits"
      description={`cgroup limits applied to every scoped workload of this project (agent, preview, service, artifact). Fields left empty inherit the layer below, then the built-in defaults. Saving writes to ${SCOPE_FILE[scope]}.`}
      collapsible
      defaultCollapsed
      storageKey={StorageKeys.settingsResourcesCollapsed}
    >
      <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
        <div className="flex flex-col gap-3 px-3.5 py-3 text-sm">
          <Field
            label="CPU weight"
            value={r.cpu_weight}
            placeholder="default (50)"
            onChange={(v) => set('cpu_weight', v)}
            tip={
              <>
                <p>Relative CPU share under contention (systemd CPUWeight, 1-10000). It is a soft limit - it only bites when the box is busy, so idle capacity is still fully usable.</p>
                <p className="mt-1.5">Leave empty for the built-in default (50), which sits below the daemon's 100 so a runaway workload yields to interactive work.</p>
              </>
            }
          />
          <Field
            label="IO weight"
            value={r.io_weight}
            placeholder="default (50)"
            onChange={(v) => set('io_weight', v)}
            tip={
              <>
                <p>Relative block-IO share under contention (systemd IOWeight, 1-10000). Soft, like CPU weight; needs a weight-capable IO scheduler.</p>
                <p className="mt-1.5">Leave empty for the built-in default (50).</p>
              </>
            }
          />
          <Field
            label="CPU quota"
            value={r.cpu_quota}
            placeholder="no cap"
            suffix="% of one core"
            onChange={(v) => set('cpu_quota', v)}
            tip={
              <>
                <p>Hard CPU cap in percent of one core (systemd CPUQuota; 200 = 2 cores). Unlike the weight, this applies even when the box is idle.</p>
                <p className="mt-1.5">Leave empty for no cap. Hard caps are opt-in - a quota that is too low can starve a legitimate build. May be ignored if the cpu controller is not delegated to the user systemd manager.</p>
              </>
            }
          />
          <Field
            label="Memory max"
            value={r.memory_max}
            placeholder="no cap"
            suffix="MB"
            onChange={(v) => set('memory_max', v)}
            tip={
              <>
                <p>Hard memory ceiling in MB (systemd MemoryMax). The cgroup is OOM-killed if it exceeds this.</p>
                <p className="mt-1.5">Leave empty for no cap. Opt-in - too low a ceiling can OOM-kill a workload mid-run. May be ignored if the memory controller is not delegated to the user systemd manager.</p>
              </>
            }
          />
          <Field
            label="Tasks max"
            value={r.tasks_max}
            placeholder="no cap"
            onChange={(v) => set('tasks_max', v)}
            tip={
              <>
                <p>Hard cap on the number of processes and threads (systemd TasksMax). Guards against a fork bomb or PID exhaustion.</p>
                <p className="mt-1.5">Leave empty for no cap. May be ignored if the pids controller is not delegated to the user systemd manager.</p>
              </>
            }
          />
        </div>
      </div>
    </SettingSection>
  )
}

// Field is one numeric limit input: label + info tooltip + a number field that
// maps an empty string to null (inherit) and clamps a typed value at 0.
function Field({
  label,
  value,
  placeholder,
  suffix,
  onChange,
  tip,
}: {
  label: string
  value: number | null | undefined
  placeholder: string
  suffix?: string
  onChange: (v: number | null) => void
  tip: ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-32 shrink-0 pt-2 text-gray-500 dark:text-gray-400 flex items-center gap-1">
        {label}
        <InfoTooltip title={label}>{tip}</InfoTooltip>
      </span>
      <span className="min-w-0 flex-1 flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0))}
          placeholder={placeholder}
          className={inputClass}
        />
        {suffix && <span className="text-xs text-gray-400 dark:text-gray-500">{suffix}</span>}
      </span>
    </div>
  )
}
