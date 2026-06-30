import { useRef, type ReactNode } from 'react'
import type { AgentConfig, NetworkConfig, ProjectInfo, SandboxConfig } from '../../api'
import { X, Plus, Globe, FolderOpen, EyeOff, Eye, Layers, Terminal, Maximize2 } from 'lucide-react'
import { InfoTooltip } from '../InfoTooltip'
import { ShellEditor } from '../ShellEditor'
import { HighlightedTextarea, renderMarkdown } from '../../lib/markdown'
import { ResizeHandle } from '../../lib/ResizeHandle'

// ── PathListEditor ──────────────────────────────────────────────────────────────
// Edits a list of filesystem paths (writable / masked / restore-RO / allowed hosts).
function PathListEditor({
  paths,
  onChange,
  placeholder,
  addLabel,
}: {
  paths: string[]
  onChange: (paths: string[] | null) => void
  placeholder?: string
  addLabel?: string
}) {
  return (
    <div className="space-y-2 pt-0.5">
      {paths.map((p, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            value={p}
            onChange={(e) => {
              const next = [...paths]
              next[index] = e.target.value
              onChange(next)
            }}
            placeholder={placeholder}
            spellCheck={false}
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <button
            onClick={() => {
              const next = paths.filter((_, i) => i !== index)
              onChange(next.length > 0 ? next : null)
            }}
            className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...paths, ''])}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
        {addLabel ?? 'Add Path'}
      </button>
    </div>
  )
}

// SandboxPathSection renders a labelled path-list editor with an icon + tooltip.
function SandboxPathSection({
  icon,
  label,
  tooltipTitle,
  tooltip,
  paths,
  inheritedPaths,
  onChange,
  placeholder,
  addLabel,
}: {
  icon: ReactNode
  label: string
  tooltipTitle: string
  tooltip: ReactNode
  paths: string[]
  inheritedPaths?: string[]
  onChange: (paths: string[] | null) => void
  placeholder?: string
  addLabel?: string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
          {label}
        </label>
        <InfoTooltip title={tooltipTitle}>{tooltip}</InfoTooltip>
      </div>
      {inheritedPaths && inheritedPaths.length > 0 && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500 italic ml-0.5">
          Inherited: <span className="font-mono">{inheritedPaths.join(', ')}</span>
        </p>
      )}
      <PathListEditor paths={paths} onChange={onChange} placeholder={placeholder} addLabel={addLabel} />
    </div>
  )
}

// ── ConfigForm ──────────────────────────────────────────────────────────────────
export function ConfigForm({
  value,
  onChange,
  inherited,
  agentType,
  defaultPrePrompt,
  allAgentsPrePrompt,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType?: string
  selectedProject?: ProjectInfo
  defaultPrePrompt?: string
  allAgentsPrePrompt?: string | null
}) {
  const prePromptBoxRef = useRef<HTMLDivElement>(null)
  const sandbox: SandboxConfig = value.sandbox ?? {}
  const network: NetworkConfig = sandbox.network ?? {}
  const networkEnabled = network.enabled !== false // default on
  // Mirrors the backend's inference: filtering is on when explicitly enabled, or
  // (when the toggle is unset) whenever an allow-list is present.
  const filterEnabled = network.filter_enabled ?? (network.allowed_hosts?.length ?? 0) > 0

  function updateSandbox(patch: Partial<SandboxConfig>) {
    const next: SandboxConfig = { ...sandbox, ...patch }
    const empty =
      !next.writable_paths?.length &&
      !next.masked_paths?.length &&
      !next.restore_ro?.length &&
      !next.cow_paths?.length &&
      !next.pre_spawn_script &&
      !next.network
    onChange({ ...value, sandbox: empty ? null : next })
  }

  function updateNetwork(patch: Partial<NetworkConfig>) {
    updateSandbox({ network: { ...network, ...patch } })
  }

  const inheritedSandbox = inherited?.sandbox ?? null

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
          System Pre-Prompt
        </label>
        {defaultPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;default pre-prompt&gt;</span>
            <InfoTooltip title="Default Pre-Prompt">
              <p className="mb-1.5">This built-in pre-prompt is always prepended before any configured pre-prompts:</p>
              <div className="text-[10px] whitespace-pre-wrap leading-relaxed text-gray-200 bg-gray-800 rounded p-1.5 max-h-48 overflow-y-auto">{renderMarkdown(defaultPrePrompt)}</div>
              <p className="mt-1.5 text-gray-400 italic">{'<branch>'} and {'<base-branch>'} are substituted at spawn time.</p>
            </InfoTooltip>
          </div>
        )}
        {allAgentsPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;all agents pre-prompt&gt;</span>
            <InfoTooltip title="All Agents Pre-Prompt">
              {allAgentsPrePrompt ? (
                <>
                  <p className="mb-1.5">The "All Agents" pre-prompt is prepended before this agent's pre-prompt:</p>
                  <div className="text-[10px] whitespace-pre-wrap leading-relaxed text-gray-200 bg-gray-800 rounded p-1.5 max-h-32 overflow-y-auto">{renderMarkdown(allAgentsPrePrompt)}</div>
                </>
              ) : (
                <p>No "All Agents" pre-prompt is configured. Set one in the <strong>All Agents</strong> tab to have it prepended here.</p>
              )}
              <p className="mt-1.5 text-gray-400 italic">Pre-prompts are merged in order: default → all agents → agent-specific.</p>
            </InfoTooltip>
          </div>
        )}
        <div>
          {/* The box carries the border/background/focus ring; the inner
              HighlightedTextarea is transparent and live-highlights markdown.
              The box height is what the grip drags (the textarea fills it). */}
          <div
            ref={prePromptBoxRef}
            className="relative h-28 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-inner overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all"
          >
            <HighlightedTextarea
              value={value.pre_prompt || ''}
              onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
              placeholder={inherited?.pre_prompt || 'You are a helpful assistant...'}
              wrapperClassName="w-full h-full"
              textClassName="px-3 py-2 text-sm leading-relaxed placeholder-gray-300 dark:placeholder-gray-600"
            />
          </div>
          <ResizeHandle targetRef={prePromptBoxRef} minHeight={80} />
        </div>
      </div>

      {/* Fullscreen rendering — Claude only. Off by default so the web terminal keeps
          its native scrollbar + select-to-copy and Claude skips the alt-screen opt-in. */}
      {agentType === 'claude' && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Maximize2 className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Fullscreen Rendering
            </label>
            <InfoTooltip title="Fullscreen Rendering">
              <p>Claude Code's fullscreen renderer is flicker-free with flat memory in long conversations, but it draws on the terminal's <strong>alternate screen buffer</strong> and captures the mouse.</p>
              <p className="mt-1.5">Off (the default), Hydra forces the classic renderer so this web terminal keeps its <strong>native scrollbar and select-to-copy</strong>, and Claude won't show the one-time opt-in prompt that can collide with the resume nudge.</p>
              <p className="mt-1.5">On, Hydra enables fullscreen explicitly (it overrides any saved <code className="text-blue-300">tui</code> setting). Mouse/scroll/copy then run inside Claude.</p>
              <p className="mt-1.5 text-gray-400 italic">Only applies to Claude.</p>
            </InfoTooltip>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={value.fullscreen === true}
              onChange={(e) => onChange({ ...value, fullscreen: e.target.checked ? true : null })}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20 p-4 space-y-5">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Sandbox Policy</h3>
          <InfoTooltip title="OS Sandbox">
            <p>Agents run on the host inside an OS sandbox (bubblewrap on Linux, sandbox-exec on macOS). These settings are <strong>added on top of</strong> the baked-in defaults.</p>
            <p className="mt-1.5 text-gray-400 italic">Paths support <code className="text-blue-300">~</code> (home) and <code className="text-blue-300">$VARS</code>.</p>
          </InfoTooltip>
        </div>

        {/* Network */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
              <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
                Network Access
              </label>
              <InfoTooltip title="Network Access">
                <p>When off, the agent runs with no network at all. When on, outbound access is allowed — unrestricted by default, or limited to an allow-list if you enable host filtering below.</p>
              </InfoTooltip>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={networkEnabled}
                onChange={(e) => updateNetwork({ enabled: e.target.checked })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
          {networkEnabled && (
            <div className="space-y-2 ml-0.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] font-semibold text-gray-400 dark:text-gray-500">Filter outbound hosts</label>
                  <InfoTooltip title="Filter outbound hosts">
                    <p>When on, only the hosts you list below are reachable (an empty list blocks all egress) — a deny-by-default allow-list enforced by a per-head egress proxy. When off, every host is reachable.</p>
                    <p className="mt-1.5 text-gray-400 italic">Enforcement is a hard network-namespace boundary where the host supports it (pasta + nft), otherwise advisory proxy filtering. The running head shows which mode is active.</p>
                  </InfoTooltip>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={filterEnabled}
                    onChange={(e) => updateNetwork({ filter_enabled: e.target.checked })}
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                </label>
              </div>
              {filterEnabled ? (
                <div className="space-y-1">
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">
                    Allowed hosts {(network.allowed_hosts?.length ?? 0) === 0 && <span className="italic text-amber-600 dark:text-amber-400">(empty — all egress blocked)</span>}
                  </p>
                  <PathListEditor
                    paths={network.allowed_hosts ?? []}
                    onChange={(allowed_hosts) => updateNetwork({ allowed_hosts })}
                    placeholder="e.g. api.anthropic.com"
                    addLabel="Add Host"
                  />
                </div>
              ) : (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 italic">All hosts reachable.</p>
              )}
            </div>
          )}
        </div>

        <SandboxPathSection
          icon={<Eye className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />}
          label="Writable Paths"
          tooltipTitle="Writable Paths"
          tooltip={<p>Paths the agent may write to (in addition to its worktree and the default developer caches).</p>}
          paths={sandbox.writable_paths ?? []}
          inheritedPaths={inheritedSandbox?.writable_paths ?? undefined}
          onChange={(writable_paths) => updateSandbox({ writable_paths })}
          placeholder="e.g. ~/.gradle"
        />

        <SandboxPathSection
          icon={<EyeOff className="w-3.5 h-3.5 text-red-500 dark:text-red-400" />}
          label="Masked Paths"
          tooltipTitle="Masked Paths"
          tooltip={<p>Paths hidden from the agent entirely (e.g. extra credential locations beyond the defaults like <code className="text-blue-300">~/.ssh</code>, <code className="text-blue-300">~/.aws</code>).</p>}
          paths={sandbox.masked_paths ?? []}
          inheritedPaths={inheritedSandbox?.masked_paths ?? undefined}
          onChange={(masked_paths) => updateSandbox({ masked_paths })}
          placeholder="e.g. ~/.vault-token"
        />

        <SandboxPathSection
          icon={<Eye className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />}
          label="Restore Read-Only"
          tooltipTitle="Restore Read-Only"
          tooltip={<p>Re-expose specific paths read-only after their parent has been masked (e.g. <code className="text-blue-300">~/.config/git</code> when <code className="text-blue-300">~/.config</code> is masked).</p>}
          paths={sandbox.restore_ro ?? []}
          inheritedPaths={inheritedSandbox?.restore_ro ?? undefined}
          onChange={(restore_ro) => updateSandbox({ restore_ro })}
          placeholder="e.g. ~/.config/git"
        />

        <SandboxPathSection
          icon={<Layers className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />}
          label="Copy-on-Write Paths"
          tooltipTitle="Copy-on-Write Paths"
          tooltip={
            <>
              <p>Worktree-relative paths mounted copy-on-write from the project root. The agent sees the real files at the same path under its worktree and may <strong>overwrite</strong> them, but writes are kept in a per-head layer and <strong>never touch the source</strong>.</p>
              <p className="mt-1.5">Ideal for large gitignored build inputs/outputs (e.g. <code className="text-blue-300">pipeline/out</code>) that are too big to copy. Nothing is copied up front — reads come straight from the source; only files the agent modifies cost space.</p>
              <p className="mt-1.5 text-gray-400 italic">Linux uses overlayfs, macOS an APFS clone. Bash shells get read-only access to the same paths.</p>
              <p className="mt-1.5 text-gray-400 italic">Overlay needs an overlay-capable bwrap; some distros (e.g. Ubuntu) ship it without. Point the daemon at one with <code className="text-blue-300">HYDRA_BWRAP=/path/to/bwrap</code> — otherwise COW falls back to read-only.</p>
            </>
          }
          paths={sandbox.cow_paths ?? []}
          inheritedPaths={inheritedSandbox?.cow_paths ?? undefined}
          onChange={(cow_paths) => updateSandbox({ cow_paths })}
          placeholder="e.g. pipeline/out"
        />

        {/* Pre-spawn script */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Pre-Spawn Script
            </label>
            <InfoTooltip title="Pre-Spawn Script">
              <p>A shell script run <strong>inside the sandbox</strong> before <strong>every agent launch</strong> — both spawn and resume — in its worktree with the same environment and confinement. Because it runs on every launch it must be <strong>idempotent</strong>. It does <strong>not</strong> run for the web bash shells.</p>
              <p className="mt-1.5">Runs under the script's <code className="text-blue-300">#!</code> shebang if present (e.g. <code className="text-blue-300">#!/bin/zsh</code>), otherwise <code className="text-blue-300">/bin/bash</code> — so <code className="text-blue-300">set -o pipefail</code> and other bashisms work.</p>
              <p className="mt-1.5">Useful for one-off setup such as <code className="text-blue-300">mise trust</code>. The agent launches after the script falls through; an explicit <code className="text-blue-300">exit 1</code> aborts the launch.</p>
              <p className="mt-1.5">These environment variables describe the head and are available to the script:</p>
              <ul className="mt-1 space-y-0.5 list-none">
                <li><code className="text-blue-300">HYDRA_HEAD_ID</code> — the head's ID</li>
                <li><code className="text-blue-300">HYDRA_AGENT_TYPE</code> — <code className="text-blue-300">claude</code>, <code className="text-blue-300">gemini</code>, <code className="text-blue-300">copilot</code>, <code className="text-blue-300">codex</code> or <code className="text-blue-300">bash</code></li>
                <li><code className="text-blue-300">HYDRA_WORKTREE</code> — worktree path (the working directory)</li>
                <li><code className="text-blue-300">HYDRA_PROJECT_ROOT</code> — the main repository root</li>
                <li><code className="text-blue-300">HYDRA_BRANCH</code> — the head's git branch</li>
                <li><code className="text-blue-300">HYDRA_BASE_BRANCH</code> — the branch it targets</li>
              </ul>
            </InfoTooltip>
          </div>
          {inheritedSandbox?.pre_spawn_script && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 italic ml-0.5">
              Inherited: <span className="font-mono">{inheritedSandbox.pre_spawn_script}</span>
            </p>
          )}
          <ShellEditor
            value={sandbox.pre_spawn_script ?? ''}
            onChange={(val) => updateSandbox({ pre_spawn_script: val || null })}
            placeholder={'# e.g. mise trust'}
            rows={8}
          />
        </div>

        {/* Pre-exit script */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Pre-Exit Script
            </label>
            <InfoTooltip title="Pre-Exit Script">
              <p>A shell script run <strong>inside a sandbox</strong> when a head <strong>ends</strong> (kill, merge, or restart) — after its agent session is killed but <strong>before</strong> the worktree is removed.</p>
              <p className="mt-1.5">It runs in a fresh sandbox with this agent's policy, with the <strong>worktree as the working directory</strong> (still present), so it can read e.g. <code className="text-blue-300">.hydra/emu.env</code>. Use it for per-head teardown the agent didn't do itself — e.g. releasing a claimed emulator slot. Best-effort (failures are logged, never block the kill) and bounded by a 30s timeout.</p>
              <p className="mt-1.5">Being sandboxed it <strong>cannot</strong> reach host-only resources (the host adb server, <code className="text-blue-300">/dev/kvm</code>); those belong to a host-side service pool.</p>
              <p className="mt-1.5">It receives the same <code className="text-blue-300">HYDRA_*</code> head-context variables as the agent, plus:</p>
              <ul className="mt-1 space-y-0.5 list-none">
                <li><code className="text-blue-300">HYDRA_END_STATE</code> — <code className="text-blue-300">killed</code>, <code className="text-blue-300">merged</code>, or empty</li>
              </ul>
            </InfoTooltip>
          </div>
          {inheritedSandbox?.pre_exit_script && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 italic ml-0.5">
              Inherited: <span className="font-mono">{inheritedSandbox.pre_exit_script}</span>
            </p>
          )}
          <ShellEditor
            value={sandbox.pre_exit_script ?? ''}
            onChange={(val) => updateSandbox({ pre_exit_script: val || null })}
            placeholder={'# e.g. source "$HYDRA_WORKTREE/.hydra/emu.env" && release-slot'}
            rows={6}
          />
        </div>
      </div>
    </div>
  )
}
