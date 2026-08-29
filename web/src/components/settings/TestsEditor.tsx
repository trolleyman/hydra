import { X, Plus, FlaskConical, TriangleAlert } from 'lucide-react'
import type { TestScript } from '../../api'
import { InfoTooltip } from '../InfoTooltip'
import { Tooltip } from '../Tooltip'
import { ShellEditor } from '../ShellEditor'
import { AutomaticRunsSelect, EnabledToggle } from './shared'

// ── TestsEditor ──────────────────────────────────────────────────────────────────
// Edits the per-project [[tests]] runners whose pass/fail verdict soft-gates a
// head's merge button. Mirrors ArtifactsEditor: same per-script row shape (the
// fields are identical) plus the project-level concurrency cap and the background
// re-run (prefetch) toggle. Not agent-specific, so it lives outside the per-agent
// tabs.
export function TestsEditor({
  tests,
  onChange,
  concurrency,
  onConcurrencyChange,
  prefetch,
  notifyFailures,
  onNotifyFailuresChange,
  onPrefetchChange,
}: {
  tests: TestScript[]
  onChange: (tests: TestScript[]) => void
  // Project-level parallelism for test-runner generation (test_concurrency).
  // undefined/null means "use the built-in default" (1).
  concurrency?: number | null
  onConcurrencyChange: (n: number | undefined) => void
  // Whether the daemon re-runs a head's suites in the background when its verdict
  // goes stale (test_prefetch). undefined/null means "use the default" (enabled).
  prefetch?: boolean | null
  // Whether a failing run wakes the head ([notify] test_failures). undefined/null
  // means "use the default" (enabled).
  notifyFailures?: boolean | null
  onNotifyFailuresChange: (v: boolean) => void
  onPrefetchChange: (v: boolean) => void
}) {
  function update(index: number, patch: Partial<TestScript>) {
    const next = tests.map((t, i) => (i === index ? { ...t, ...patch } : t))
    onChange(next)
  }
  function remove(index: number) {
    onChange(tests.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...tests, { name: '', script: '' }])
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
          <FlaskConical className="w-4 h-4 text-sky-600 dark:text-sky-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Tests</h2>
        <InfoTooltip title="Tests">
          <p>Per-project commands that run a test suite against a head's branch. Hydra parses the report each writes and surfaces a pass/fail verdict that soft-gates the merge button.</p>
          <p className="mt-1.5">The script runs via <code className="text-blue-300">bash -c</code> in the checkout directory with these variables set:</p>
          <ul className="mt-1 space-y-0.5 list-none">
            <li><code className="text-blue-300">HYDRA_TEST_OUTPUT</code> - directory to write the report into</li>
            <li><code className="text-blue-300">HYDRA_TEST_SOURCE</code> - the checkout directory</li>
            <li><code className="text-blue-300">HYDRA_TEST_REF</code> - the resolved git ref</li>
          </ul>
          <p className="mt-1.5">Write a <strong>JUnit-XML</strong> or <strong>Hydra-JSON</strong> report into <code className="text-blue-300">$HYDRA_TEST_OUTPUT</code> for per-case detail in the panel. With no report, the command's exit code alone becomes a degenerate red/green verdict.</p>
        </InfoTooltip>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Test-runner commands whose verdict gates merge, stored as <span className="font-mono">[tests.&lt;name&gt;]</span> tables in config.toml.
      </p>

      <div className="ml-10 mb-5 flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
            Max parallel runs
            <InfoTooltip title="Test concurrency">
              <p>How many test-runner generations may run at once, across both foreground (a panel you're viewing / a merge gate) and background (proactive re-runs) work.</p>
              <p className="mt-1.5">Test suites are typically heavier than artifact renders, so this defaults low. Foreground requests are always served before queued background work, and a running suite is never interrupted.</p>
              <p className="mt-1.5">Leave empty for the built-in default (1), or set <code className="text-blue-300">0</code> for unlimited (no cap).</p>
            </InfoTooltip>
          </label>
          <input
            type="number"
            min={0}
            value={concurrency ?? ''}
            onChange={(e) => onConcurrencyChange(e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0))}
            placeholder="default (1)"
            className="w-44 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
        </div>
        {concurrency === 0 && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400 h-[38px] flex items-center">Unlimited - no cap on parallel runs</span>
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
            Re-run stale verdicts in the background
            <InfoTooltip title="Background re-runs">
              <p>When on, the daemon re-runs a head's suites in the background whenever its branch-tip verdict is missing or stale (a cached result computed for an older commit), so the verdict is fresh the instant you open the tests panel or arm auto-merge.</p>
              <p className="mt-1.5">Turn it off for a project whose suites are too heavy to run speculatively - tests are then run only when you open the panel or at merge time. Foreground runs and the max-parallel cap above still apply either way.</p>
              <p className="mt-1.5">Default: on.</p>
            </InfoTooltip>
          </span>
        </label>
      </div>

      <div className="ml-10 mb-5">
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={notifyFailures !== false}
            onChange={(e) => onNotifyFailuresChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-2 focus:ring-blue-500/20"
          />
          <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
            Tell the agent when tests fail
            <InfoTooltip title="Failing-test notifications">
              <p>When a runner settles failing, Hydra sends the head one line naming it. The agent fetches the output itself with its <code>get_test_logs</code> tool, so a failure costs one short message rather than a transcript full of log.</p>
              <p className="mt-1.5">It only fires while the head is <strong>idle</strong>, so it can never interrupt a turn or start a fix-fail-fix loop, and the same failure is only reported once per commit - a re-run of a red suite is silent.</p>
              <p className="mt-1.5">Turn it off for a project whose suites are red for reasons the agent cannot fix. Default: on.</p>
            </InfoTooltip>
          </span>
        </label>
      </div>

      <div className="space-y-4">
        {tests.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No test runners configured.</p>
        )}
        {tests.map((t, index) => {
          const unsafe = t.unsafe_host === true
          const cleanIgnored = t.clean_ignored === true
          const strict = t.strict !== false
          const enabled = t.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">- skipped by the test gate</span>
                    )}
                  </div>
                  <div className={`space-y-3 transition-opacity ${enabled ? '' : 'opacity-50'}`}>
                  <div className="flex items-end gap-4 flex-wrap">
                    <div className="space-y-1 flex-1 min-w-[12rem]">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Name</label>
                      <input
                        type="text"
                        value={t.name}
                        onChange={(e) => update(index, { name: e.target.value })}
                        placeholder="e.g. go"
                        spellCheck={false}
                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 dark:text-gray-500 flex items-center gap-1">
                        Results
                        <InfoTooltip title="Result parsing">
                          <p><strong>report file</strong> (default): after the command exits, Hydra parses the JUnit-XML / Hydra-JSON files it wrote into <code className="text-blue-300">$HYDRA_TEST_OUTPUT</code>.</p>
                          <p className="mt-1.5"><strong>stdout stream</strong>: Hydra parses <code className="text-blue-300">::hydra:test:*::</code> markers live from the command's stdout - counts tick in the panel and sidebar as tests run, and the accumulated cases are the report (no file needed). One line per case:</p>
                          <p className="mt-1 font-mono text-2xs">::hydra:test:pass:: src/x.test.ts › adds<br />::hydra:test:fail:: src/x.test.ts:48:24 › grace window | expected kid-2<br />::hydra:test:warn:: src/y.ts:12:5 › no-console | Unexpected console<br />::hydra:test:skip:: pkg › TestResume | needs daemon<br />::hydra:test:total:: 4556</p>
                        </InfoTooltip>
                      </label>
                      <select
                        value={t.type === 'stdout' ? 'stdout' : 'junit'}
                        onChange={(e) => update(index, { type: e.target.value === 'stdout' ? 'stdout' : undefined })}
                        className="w-36 text-sm px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
                      >
                        <option value="junit">report file</option>
                        <option value="stdout">stdout stream</option>
                      </select>
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
                        value={t.timeout_sec ?? ''}
                        onChange={(e) => update(index, { timeout_sec: e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10) || 0) })}
                        placeholder="default"
                        className="w-28 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                      />
                    </div>
                    <AutomaticRunsSelect value={t.auto_run} kind="tests" onChange={(auto_run) => update(index, { auto_run })} />
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
                          <p className="mt-1.5">The command executes the <em>tested ref's</em> code (its test files, its <code className="font-mono">bun install</code>/<code className="font-mono">go test</code>), so only enable this if every ref you will ever test is trusted.</p>
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
                          <p>Test runs reuse a small pool of checkouts, switching commits with <code className="font-mono">git checkout</code> - this resets tracked files but keeps git-ignored caches (e.g. <code className="font-mono">node_modules</code>) warm between runs.</p>
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
                          <p>Runs the command under <code className="font-mono">set -eo pipefail</code> so a failing setup step - or a failure mid-pipeline - aborts and propagates.</p>
                          <p className="mt-1.5">A test runner that exits non-zero <em>because tests failed</em> is still a valid red verdict, not a strict abort - the verdict comes from the parsed report. Uncheck to run the command exactly as written.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Script</label>
                    <ShellEditor
                      value={t.script}
                      onChange={(val) => update(index, { script: val })}
                      placeholder='# e.g. go test ./... or bun x vitest run --reporter=junit --outputFile="$HYDRA_TEST_OUTPUT/web.xml"'
                      rows={6}
                    />
                  </div>
                  {unsafe && (
                    <div className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                      <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>Runs unsandboxed on the host with full access to your credentials. Only enable for trusted refs.</span>
                    </div>
                  )}
                  </div>
                </div>
                {/* shrink-0 rides on the Tooltip wrapper: it is what the row's
                    flex layout now sees in place of the button. */}
                <Tooltip content="Remove test runner" className="shrink-0">
                  <button
                    onClick={() => remove(index)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    aria-label="Remove test runner"
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
          Add Test Runner
        </button>
      </div>
    </div>
  )
}
