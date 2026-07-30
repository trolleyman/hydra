import { X, Plus, Image, TriangleAlert } from 'lucide-react'
import type { ArtifactScript } from '../../api'
import { InfoTooltip } from '../InfoTooltip'
import { Tooltip } from '../Tooltip'
import { ShellEditor } from '../ShellEditor'
import { EnabledToggle } from './shared'

// ── ArtifactsEditor ──────────────────────────────────────────────────────────────
// Edits the per-project [[artifacts]] scripts that render visual artifacts (e.g.
// screenshots) for the diff viewer. Not agent-specific, so it lives outside the
// per-agent tabs.
export function ArtifactsEditor({
  artifacts,
  onChange,
  concurrency,
  onConcurrencyChange,
  prefetch,
  onPrefetchChange,
}: {
  artifacts: ArtifactScript[]
  onChange: (artifacts: ArtifactScript[]) => void
  // Project-level parallelism for artifact generation (artifact_concurrency).
  // undefined/null means "use the built-in default".
  concurrency?: number | null
  onConcurrencyChange: (n: number | undefined) => void
  // Whether the daemon pre-generates artifacts in the background for settled
  // heads (artifact_prefetch). undefined/null means "use the default" (enabled).
  prefetch?: boolean | null
  onPrefetchChange: (v: boolean) => void
}) {
  function update(index: number, patch: Partial<ArtifactScript>) {
    const next = artifacts.map((a, i) => (i === index ? { ...a, ...patch } : a))
    onChange(next)
  }
  function remove(index: number) {
    onChange(artifacts.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...artifacts, { name: '', script: '' }])
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <Image className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Diff Artifacts</h2>
        <InfoTooltip title="Diff Artifacts">
          <p>Per-project scripts that render visual artifacts (e.g. screenshots or screen recordings) of a checkout. The diff viewer runs each against both sides of a comparison and shows the outputs that differ.</p>
          <p className="mt-1.5">The script runs via <code className="text-blue-300">bash -c</code> in the checkout directory with these variables set:</p>
          <ul className="mt-1 space-y-0.5 list-none">
            <li><code className="text-blue-300">HYDRA_ARTIFACT_OUTPUT</code> - directory to write images into</li>
            <li><code className="text-blue-300">HYDRA_ARTIFACT_SOURCE</code> - the checkout directory</li>
            <li><code className="text-blue-300">HYDRA_ARTIFACT_REF</code> - the resolved git ref</li>
          </ul>
          <p className="mt-1.5">It is a <strong>script</strong>, not a one-liner - put each step on its own line. A live, clickable preview of the app belongs in <strong>Previews</strong> below, not here.</p>
          <p className="mt-1.5"><code className="text-blue-300">.png .jpg .gif</code> are diffed pixel-by-pixel; <code className="text-blue-300">.webm</code> video is diffed frame-by-frame when <strong>ffmpeg</strong> is installed (else by byte hash); other types (<code className="text-blue-300">.webp .avif .svg .bmp .pdf</code>) are compared by byte hash. Encode video as <strong>lossless</strong> <code className="text-blue-300">.webm</code> (e.g. <code className="text-blue-300">libvpx-vp9 -lossless 1</code>) so identical frames stay identical - a lossy encode changes pixels and reads as changed.</p>
        </InfoTooltip>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Visual artifacts generated for the diff viewer, stored as <span className="font-mono">[artifacts.&lt;name&gt;]</span> tables in config.toml.
      </p>

      <div className="ml-10 mb-5 flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
            Max parallel generations
            <InfoTooltip title="Artifact generation concurrency">
              <p>How many artifact generations may run at once, across both foreground (a diff you're viewing) and background (proactive pre-generation) work.</p>
              <p className="mt-1.5">Generations can be heavy - a full build per ref, and RAM-hungry tooling (e.g. emulators) - so lower this for memory-hungry generators. Foreground views are always served before queued background work, and a running generation is never interrupted.</p>
              <p className="mt-1.5">Leave empty for the built-in default (2), or set <code className="text-blue-300">0</code> for unlimited (no cap).</p>
            </InfoTooltip>
          </label>
          <input
            type="number"
            min={0}
            value={concurrency ?? ''}
            onChange={(e) => onConcurrencyChange(e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0))}
            placeholder="default (2)"
            className="w-44 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
        </div>
        {concurrency === 0 && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400 h-[38px] flex items-center">Unlimited - no cap on parallel generations</span>
        )}
      </div>

      <div className="ml-10 mb-5">
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={prefetch !== false}
            onChange={(e) => onPrefetchChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-2 focus:ring-blue-500/20"
          />
          <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
            Pre-generate artifacts in the background
            <InfoTooltip title="Background pre-generation">
              <p>When on, the daemon renders a head's diff artifacts in the background once its working tree stops changing, so they're ready the instant you open the diff instead of starting the work on click.</p>
              <p className="mt-1.5">Turn it off for a project whose generators are too heavy to run speculatively - artifacts are then generated only when you view a diff. Foreground generation and the max-parallel cap above still apply either way.</p>
              <p className="mt-1.5">Default: on.</p>
            </InfoTooltip>
          </span>
        </label>
      </div>

      <div className="space-y-4">
        {artifacts.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No artifact scripts configured.</p>
        )}
        {artifacts.map((a, index) => {
          const unsafe = a.unsafe_host === true
          const cleanIgnored = a.clean_ignored === true
          const strict = a.strict !== false
          const enabled = a.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">- skipped in the diff viewer</span>
                    )}
                  </div>
                  <div className={`space-y-3 transition-opacity ${enabled ? '' : 'opacity-50'}`}>
                  <div className="flex items-end gap-4 flex-wrap">
                    <div className="space-y-1 flex-1 min-w-[12rem]">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Name</label>
                      <input
                        type="text"
                        value={a.name}
                        onChange={(e) => update(index, { name: e.target.value })}
                        placeholder="e.g. screenshots"
                        spellCheck={false}
                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
                        Timeout (s)
                        <InfoTooltip title="Timeout">
                          <p>Max seconds the command may run. Leave empty (0) for the built-in default.</p>
                        </InfoTooltip>
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={a.timeout_sec ?? ''}
                        onChange={(e) => update(index, { timeout_sec: e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0) })}
                        placeholder="default"
                        className="w-28 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
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
                          <p className="mt-1.5">The command executes the <em>diffed ref's</em> code, so only enable this for a self-contained, audited command you trust against every ref you compare.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer h-[38px]">
                      <input
                        type="checkbox"
                        checked={cleanIgnored}
                        onChange={(e) => update(index, { clean_ignored: e.target.checked ? true : undefined })}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1">
                        Pristine checkout
                        <InfoTooltip title="Pristine Checkout">
                          <p>Artifact runs reuse a small pool of checkouts, switching commits with <code className="font-mono">git checkout</code> - this resets tracked files but keeps git-ignored caches (e.g. <code className="font-mono">node_modules</code>) warm between runs.</p>
                          <p className="mt-1.5">Enable this to also wipe ignored files before each run (<code className="font-mono">git clean -fdx</code> instead of <code className="font-mono">-fd</code>) for a fully clean tree. Slower - only needed if stale ignored output can leak between commits.</p>
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
                          <p>Runs the command under <code className="font-mono">set -eo pipefail</code> so a failing step - or a failure mid-pipeline - aborts and propagates a non-zero exit.</p>
                          <p className="mt-1.5">Without it, a broken render whose last command happens to succeed is cached as a success. <code className="font-mono">nounset</code> (<code className="font-mono">-u</code>) is not applied. Uncheck to run the command exactly as written.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Script</label>
                    <ShellEditor
                      value={a.script}
                      onChange={(val) => update(index, { script: val })}
                      placeholder={'cd web\nnpm install\nnode scripts/take-screenshots.ts'}
                      rows={6}
                    />
                  </div>
                  {unsafe && (
                    <div className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                      <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>Runs unsandboxed on the host with full access to your credentials. Only use for audited, self-contained commands.</span>
                    </div>
                  )}
                  </div>
                </div>
                {/* shrink-0 rides on the Tooltip wrapper: it is what the row's
                    flex layout now sees in place of the button. */}
                <Tooltip content="Remove artifact" className="shrink-0">
                  <button
                    onClick={() => remove(index)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    aria-label="Remove artifact"
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
          Add Artifact
        </button>
      </div>
    </div>
  )
}
