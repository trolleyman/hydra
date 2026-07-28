import { X, Plus, MonitorPlay, AlertTriangle } from 'lucide-react'
import type { PreviewScript } from '../../api'
import { InfoTooltip } from '../InfoTooltip'
import { Tooltip } from '../Tooltip'
import { ShellEditor } from '../ShellEditor'
import { EnabledToggle } from './shared'

// ── PreviewsEditor ───────────────────────────────────────────────────────────
// Edits the per-project [previews.<name>] scripts that boot a live, clickable
// preview of the app at a checkout. Mirrors ArtifactsEditor - the two used to be
// one editor with a media/server type dropdown, which buried a whole feature
// inside a field of another one. A config still spelling a preview as an
// artifact with type = "server" arrives here already upgraded (the backend does
// it on read), so saving migrates the file.
export function PreviewsEditor({
  previews,
  onChange,
}: {
  previews: PreviewScript[]
  onChange: (previews: PreviewScript[]) => void
}) {
  function update(index: number, patch: Partial<PreviewScript>) {
    onChange(previews.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }
  function remove(index: number) {
    onChange(previews.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...previews, { name: '', script: '' }])
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
          <MonitorPlay className="w-4 h-4 text-sky-600 dark:text-sky-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Previews</h2>
        <InfoTooltip title="Previews">
          <p>Per-project scripts that boot a live, clickable preview of your app at a checkout. Each appears in the Previews row on the agent page, so a head's UI changes can be tried in the real running app rather than only read as a diff.</p>
          <p className="mt-1.5">Hydra proxies a dedicated port to it: the server is spawned when its link is first opened, kept warm while requests flow, and torn down once idle - the next visit respawns it.</p>
          <p className="mt-1.5">The script runs via <code className="text-blue-300">bash -c</code> in the checkout directory with these variables set:</p>
          <ul className="mt-1 space-y-0.5 list-none">
            <li><code className="text-blue-300">HYDRA_PREVIEW_ADDR</code> - the host:port to bind (bind this, not a hardcoded <code className="text-blue-300">127.0.0.1</code>)</li>
            <li><code className="text-blue-300">HYDRA_PREVIEW_PORT</code> - just the port</li>
            <li><code className="text-blue-300">HYDRA_PREVIEW_SOURCE</code> - the checkout directory</li>
          </ul>
          <p className="mt-1.5">It must stay in the foreground. Print <code className="text-blue-300">::hydra:server:ready::</code> to declare readiness early, or <code className="text-blue-300">::hydra:progress:: text</code> to set the headline shown while it builds.</p>
        </InfoTooltip>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Live servers shown on the agent page, stored as <span className="font-mono">[previews.&lt;name&gt;]</span> tables in config.toml.
      </p>

      <div className="space-y-4">
        {previews.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No previews configured.</p>
        )}
        {previews.map((p, index) => {
          const unsafe = p.unsafe_host === true
          const strict = p.strict !== false
          const enabled = p.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">- hidden on the agent page</span>
                    )}
                  </div>
                  <div className={`space-y-3 transition-opacity ${enabled ? '' : 'opacity-50'}`}>
                    <div className="flex items-end gap-4 flex-wrap">
                      <div className="space-y-1 flex-1 min-w-[12rem]">
                        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Name</label>
                        <input
                          type="text"
                          value={p.name}
                          onChange={(e) => update(index, { name: e.target.value })}
                          placeholder="e.g. demo"
                          spellCheck={false}
                          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
                          Idle timeout (s)
                          <InfoTooltip title="Idle timeout">
                            <p>Tear the server down after this long with zero in-flight proxied requests. Open WebSocket / long-poll connections count as in-flight, so a live app tab keeps its preview running.</p>
                            <p className="mt-1.5">Leave empty for the default (300). The preview link transparently respawns it on the next visit.</p>
                          </InfoTooltip>
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={p.idle_timeout_sec ?? ''}
                          onChange={(e) => update(index, { idle_timeout_sec: e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0) })}
                          placeholder="default (300)"
                          className="w-32 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
                          Ready timeout (s)
                          <InfoTooltip title="Ready timeout">
                            <p>Max seconds from spawn to ready, builds included. Readiness is the first successful dial of the server's port, or an explicit <code className="text-blue-300">::hydra:server:ready::</code> line on stdout.</p>
                            <p className="mt-1.5">Leave empty for the default (900).</p>
                          </InfoTooltip>
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={p.ready_timeout_sec ?? ''}
                          onChange={(e) => update(index, { ready_timeout_sec: e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0) })}
                          placeholder="default (900)"
                          className="w-32 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                        />
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer h-[38px]">
                        <input
                          type="checkbox"
                          checked={unsafe}
                          onChange={(e) => update(index, { unsafe_host: e.target.checked ? true : undefined })}
                          className="w-4 h-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1">
                          Run on host (no sandbox)
                          <InfoTooltip title="Unsafe Host Execution">
                            <p>Runs the command directly on the host with <strong>no sandbox</strong> - full access to your machine, network, and credentials.</p>
                            <p className="mt-1.5">A preview runs the <em>previewed ref's</em> code as a long-lived resident process, so this is a bigger ask than for an artifact. Only enable it for a self-contained, audited command you trust against every branch you will ever preview.</p>
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
                            <p>Runs the command under <code className="font-mono">set -eo pipefail</code> so a failing build step aborts the spawn and surfaces as a preview error.</p>
                            <p className="mt-1.5">Without it, a broken build whose last command happens to succeed boots a server against a half-built tree. Uncheck to run the command exactly as written.</p>
                          </InfoTooltip>
                        </span>
                      </label>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Script</label>
                      <ShellEditor
                        value={p.script}
                        onChange={(val) => update(index, { script: val })}
                        placeholder={'npm install\nnpm run build\nnpm run serve -- --host "$HYDRA_PREVIEW_ADDR"'}
                        rows={6}
                      />
                    </div>
                    {unsafe && (
                      <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                        <span>Runs unsandboxed on the host with full access to your credentials, and stays resident. Only use for audited, self-contained commands.</span>
                      </div>
                    )}
                  </div>
                </div>
                {/* shrink-0 rides on the Tooltip wrapper: it is what the row's
                    flex layout now sees in place of the button. */}
                <Tooltip content="Remove preview" className="shrink-0">
                  <button
                    onClick={() => remove(index)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    aria-label="Remove preview"
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
          Add Preview
        </button>
      </div>
    </div>
  )
}
