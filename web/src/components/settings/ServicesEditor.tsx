import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { X, Plus, TriangleAlert, Server, RotateCw, CheckCircle2, LoaderCircle, PauseCircle } from 'lucide-react'
import { api } from '../../stores/apiClient'
import type { ServiceScript, ServiceStatus } from '../../api'
import { InfoTooltip } from '../InfoTooltip'
import { Tooltip } from '../Tooltip'
import { ShellEditor } from '../ShellEditor'
import { EnabledToggle } from './shared'

// ── ServicesEditor ────────────────────────────────────────────────────────────
// Edits the per-project [[services]] - long-running commands the daemon
// supervises while the project is open (e.g. a host-side emulator pool). Shows
// each service's live status and offers a restart that picks up saved config.

// serviceStateBadge maps a live service state to a coloured label + icon.
function ServiceStateBadge({ status }: { status: ServiceStatus | undefined }) {
  if (!status) {
    return <span className="text-2xs text-gray-400 dark:text-gray-500 italic">not started</span>
  }
  const map: Record<string, { label: string; cls: string; icon: ReactNode }> = {
    up: { label: 'Running', cls: 'text-emerald-600 dark:text-emerald-400', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    restarting: { label: 'Restarting', cls: 'text-amber-600 dark:text-amber-400', icon: <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> },
    failed: { label: 'Failed', cls: 'text-red-600 dark:text-red-400', icon: <TriangleAlert className="w-3.5 h-3.5" /> },
    down: { label: 'Stopped', cls: 'text-gray-500 dark:text-gray-400', icon: <X className="w-3.5 h-3.5" /> },
    paused: { label: 'Paused', cls: 'text-slate-500 dark:text-slate-400', icon: <PauseCircle className="w-3.5 h-3.5" /> },
  }
  const m = map[status.state] ?? map.down
  return (
    <Tooltip content={status.message || undefined}>
      <span className={`inline-flex items-center gap-1 text-2xs font-semibold ${m.cls}`}>
        {m.icon}
        {m.label}
        {status.restarts > 0 && <span className="font-normal opacity-70">· {status.restarts}/{status.max_restarts} restarts</span>}
      </span>
    </Tooltip>
  )
}

export function ServicesEditor({
  services,
  onChange,
  projectId,
}: {
  services: ServiceScript[]
  onChange: (services: ServiceScript[]) => void
  projectId: string | null
}) {
  const [statuses, setStatuses] = useState<ServiceStatus[]>([])
  const [restarting, setRestarting] = useState(false)

  // Poll live status while the editor is mounted and a project is selected.
  useEffect(() => {
    if (!projectId) return
    let active = true
    const tick = async () => {
      try {
        const resp = await api.default.getServices(projectId)
        if (active) setStatuses(resp.services)
      } catch {
        // best-effort: leave the last snapshot in place
      }
    }
    void tick()
    const id = setInterval(tick, 3000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [projectId])

  const statusByName = new Map(statuses.map((s) => [s.name, s]))
  // Services are gated on activity: they run only while the project has an agent.
  // When every live service is paused, the project is idle - surface why.
  const anyPaused = statuses.some((s) => s.state === 'paused')
  const allPaused = statuses.length > 0 && statuses.every((s) => s.state === 'paused')

  function update(index: number, patch: Partial<ServiceScript>) {
    onChange(services.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }
  function remove(index: number) {
    onChange(services.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...services, { name: '', script: '' }])
  }
  async function restartAll() {
    if (!projectId || restarting) return
    setRestarting(true)
    try {
      const resp = await api.default.restartServices(projectId)
      setStatuses(resp.services)
    } catch {
      // surfaced via the next poll / status badges
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
          <Server className="w-4 h-4 text-sky-600 dark:text-sky-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Services</h2>
        <InfoTooltip title="Project Services">
          <p>Long-running commands the daemon supervises while this project is open - e.g. a host-side pool of Android emulators shared by every head.</p>
          <p className="mt-1.5">Each service starts when the project opens, restarts with backoff if it exits unexpectedly (up to <strong>max restarts</strong>), and is process-group-killed on shutdown, project removal, or a config save.</p>
          <p className="mt-1.5">The script runs via <code className="text-blue-300">bash -c</code> from the project root, with <code className="text-blue-300">HYDRA_PROJECT_ROOT</code> and <code className="text-blue-300">HYDRA_SERVICE_NAME</code> set.</p>
        </InfoTooltip>
        <div className="flex-1" />
        <Tooltip content="Stop and restart this project's services (picks up saved config)">
          <button
            onClick={restartAll}
            disabled={!projectId || restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
          >
            <RotateCw className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`} />
            {restarting ? 'Restarting...' : 'Restart Services'}
          </button>
        </Tooltip>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Supervised long-running commands, stored as <span className="font-mono">[services.&lt;name&gt;]</span> tables in config.toml. Saving applies changes immediately.
      </p>

      {anyPaused && (
        <div className="flex items-start gap-2 mb-4 text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
          <PauseCircle className="w-4 h-4 mt-px shrink-0 text-slate-500 dark:text-slate-400" />
          <span>
            {allPaused ? 'Services are paused' : 'Some services are paused'} - this project has no active agents.
            They start automatically when you spawn an agent, and stop again about 60&nbsp;seconds after the last
            agent is removed, so an idle project doesn&rsquo;t keep a resource pool open.
          </span>
        </div>
      )}

      <div className="space-y-4">
        {services.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No services configured.</p>
        )}
        {services.map((svc, index) => {
          const host = svc.host === true
          const strict = svc.strict !== false
          const enabled = svc.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">- not supervised</span>
                    )}
                  </div>
                  <div className={`space-y-3 transition-opacity ${enabled ? '' : 'opacity-50'}`}>
                  <div className="flex items-end gap-4 flex-wrap">
                    <div className="space-y-1 flex-1 min-w-[12rem]">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Name</label>
                      <input
                        type="text"
                        value={svc.name}
                        onChange={(e) => update(index, { name: e.target.value })}
                        placeholder="e.g. emu-pool"
                        spellCheck={false}
                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
                        Max restarts
                        <InfoTooltip title="Max Restarts">
                          <p>How many times to relaunch the command after an unexpected exit before giving up. Leave empty for the default (3); set 0 to never restart.</p>
                        </InfoTooltip>
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={svc.max_restarts ?? ''}
                        onChange={(e) => update(index, { max_restarts: e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0) })}
                        placeholder="3"
                        className="w-24 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                      />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer h-[38px]">
                      <input
                        type="checkbox"
                        checked={host}
                        onChange={(e) => update(index, { host: e.target.checked ? true : undefined })}
                        className="w-4 h-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1">
                        Run on host (no sandbox)
                        <InfoTooltip title="Host Execution">
                          <p>Runs the command directly on the host with <strong>no sandbox</strong> - full access to your machine, network and credentials.</p>
                          <p className="mt-1.5">Required for services that need host devices the sandbox hides, e.g. <code className="text-blue-300">/dev/kvm</code> for emulators.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer h-[38px]">
                      <input
                        type="checkbox"
                        checked={strict}
                        onChange={(e) => update(index, { strict: e.target.checked ? undefined : false })}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1">
                        Strict mode
                        <InfoTooltip title="Strict Mode">
                          <p>Runs the command under <code className="font-mono">set -eo pipefail</code> so a failed startup step surfaces as a crash (and triggers the restart policy) instead of a healthy-looking process.</p>
                          <p className="mt-1.5"><code className="font-mono">nounset</code> (<code className="font-mono">-u</code>) is not applied. Uncheck to run the command exactly as written.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                    <div className="h-[38px] flex items-center ml-auto">
                      {enabled
                        ? <ServiceStateBadge status={statusByName.get(svc.name)} />
                        : <span className="inline-flex items-center gap-1 text-2xs font-semibold text-gray-400 dark:text-gray-500"><X className="w-3.5 h-3.5" />Disabled</span>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Script</label>
                    <ShellEditor
                      value={svc.script}
                      onChange={(val) => update(index, { script: val })}
                      placeholder="# e.g. scripts/emu-pool.sh up 3 --foreground"
                      rows={4}
                    />
                  </div>
                  {host && (
                    <div className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                      <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>Runs unsandboxed on the host with full access to your credentials. Only use for trusted commands.</span>
                    </div>
                  )}
                  {statusByName.get(svc.name)?.state === 'failed' && statusByName.get(svc.name)?.message && (
                    <div className="flex items-start gap-1.5 text-2xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-2.5 py-1.5">
                      <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span className="font-mono break-all">{statusByName.get(svc.name)?.message}</span>
                    </div>
                  )}
                  </div>
                </div>
                {/* shrink-0 rides on the Tooltip wrapper: it is what the row's
                    flex layout now sees in place of the button. */}
                <Tooltip content="Remove service" className="shrink-0">
                  <button
                    onClick={() => remove(index)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    aria-label="Remove service"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          )
        })}
        <button
          onClick={add}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Service
        </button>
      </div>
    </div>
  )
}
