import { useRef, useState, type ReactNode } from 'react'
import type { AgentConfig, McpServer, NetworkConfig, PolicyConfig, ProjectInfo, SandboxConfig } from '../../api'
import { X, Plus, Globe, FolderOpen, EyeOff, Eye, Layers, Terminal, Maximize2, Puzzle } from 'lucide-react'
import { InfoTooltip } from '../InfoTooltip'
import { ShellEditor } from '../ShellEditor'
import { HighlightedTextarea, renderMarkdown } from '../../lib/markdown'
import { ResizeHandle } from '../../lib/ResizeHandle'

// The four egress postures, mirroring sandbox.NetworkMode on the backend.
type NetworkMode = 'off' | 'unrestricted' | 'advisory' | 'hard'

const NETWORK_MODE_LABELS: Record<NetworkMode, string> = {
  hard: 'Hard — inescapable filtering',
  advisory: 'Advisory — proxy filtering',
  unrestricted: 'Unrestricted — no filtering',
  off: 'Off — no network',
}

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
  mcpServers,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType?: string
  selectedProject?: ProjectInfo
  defaultPrePrompt?: string
  allAgentsPrePrompt?: string | null
  mcpServers?: McpServer[]
}) {
  const prePromptBoxRef = useRef<HTMLDivElement>(null)
  const [mcpInput, setMcpInput] = useState('')
  const sandbox: SandboxConfig = value.sandbox ?? {}
  const network: NetworkConfig = sandbox.network ?? {}
  // Effective egress mode for display. Explicit `mode` wins; otherwise derive it
  // from the legacy enabled/filter_enabled booleans, defaulting to "hard" (the
  // backend default). Selecting a mode writes it explicitly and clears the legacy
  // booleans so the emitted config is unambiguous.
  const mode: NetworkMode =
    (network.mode as NetworkMode | null | undefined) ??
    (network.enabled === false ? 'off' : network.filter_enabled === false ? 'unrestricted' : 'hard')
  const showHosts = mode === 'advisory' || mode === 'hard'

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

  // Set the egress mode explicitly and clear the legacy booleans so `mode` is the
  // single source of truth in the emitted config.
  function setMode(next: NetworkMode) {
    updateNetwork({ mode: next as NetworkConfig['mode'], enabled: null, filter_enabled: null })
  }

  // ── MCP server allow-list (policy.mcp_allowed) ──
  const policy: PolicyConfig = value.policy ?? {}
  const mcpAllowed = policy.mcp_allowed ?? []
  // The picker's rows: every discovered server, plus any allow-listed name that
  // is no longer discovered (so it can be un-checked rather than silently kept).
  const discovered = mcpServers ?? []
  const extraAllowed = mcpAllowed.filter((n) => !discovered.some((s) => s.name === n))

  function updatePolicy(patch: Partial<PolicyConfig>) {
    const next: PolicyConfig = { ...policy, ...patch }
    const empty =
      next.gate_enabled == null &&
      next.mcp_auto_allow_read == null &&
      !next.mcp_allowed?.length &&
      !next.mcp_tools_allowed?.length &&
      !next.webfetch_allow_hosts?.length
    onChange({ ...value, policy: empty ? null : next })
  }

  function toggleMcp(name: string, on: boolean) {
    const set = new Set(mcpAllowed)
    if (on) set.add(name)
    else set.delete(name)
    updatePolicy({ mcp_allowed: [...set] })
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
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
              <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
                Network Egress
              </label>
              <InfoTooltip title="Network Egress">
                <p><strong>Hard</strong> (default): outbound access limited to the allow-list, enforced by an <strong>inescapable</strong> network-namespace boundary (pasta + nft) where the host supports it — otherwise it degrades to advisory (the running head shows which is active).</p>
                <p className="mt-1.5"><strong>Advisory</strong>: the same allow-list, but enforced only via the per-head egress proxy — every honest client is filtered, though a determined process can bypass it.</p>
                <p className="mt-1.5"><strong>Unrestricted</strong>: network on, every host reachable. <strong>Off</strong>: no network at all.</p>
                <p className="mt-1.5 text-gray-400 italic">Filtered modes start from a built-in default allow-list (AI-provider APIs, package registries, git hosts). Your allowed hosts are added on top; blocked hosts override both.</p>
              </InfoTooltip>
            </div>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as NetworkMode)}
              className="text-[11px] font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            >
              {(['hard', 'advisory', 'unrestricted', 'off'] as NetworkMode[]).map((m) => (
                <option key={m} value={m}>{NETWORK_MODE_LABELS[m]}</option>
              ))}
            </select>
          </div>
          {mode === 'hard' && (
            <div className="flex items-center justify-between ml-0.5">
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] font-semibold text-gray-400 dark:text-gray-500">Strict (fail closed)</label>
                <InfoTooltip title="Strict hard egress">
                  <p>When the inescapable boundary can't be built on this host (pasta/nft unavailable — e.g. macOS), <strong>fail closed</strong> and give the agent no network, instead of degrading to advisory proxy filtering.</p>
                </InfoTooltip>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={network.strict === true}
                  onChange={(e) => updateNetwork({ strict: e.target.checked ? true : null })}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>
          )}
          {showHosts && (
            <div className="space-y-3 ml-0.5">
              <div className="space-y-1">
                <p className="text-[11px] text-gray-400 dark:text-gray-500">Allowed hosts <span className="text-gray-400 dark:text-gray-600">(added to the built-in defaults)</span></p>
                <PathListEditor
                  paths={network.allowed_hosts ?? []}
                  onChange={(allowed_hosts) => updateNetwork({ allowed_hosts })}
                  placeholder="e.g. api.internal.example.com"
                  addLabel="Add Host"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-gray-400 dark:text-gray-500">Blocked hosts <span className="text-gray-400 dark:text-gray-600">(override allowed + defaults)</span></p>
                <PathListEditor
                  paths={network.blocked_hosts ?? []}
                  onChange={(blocked_hosts) => updateNetwork({ blocked_hosts })}
                  placeholder="e.g. *.tracker.io"
                  addLabel="Block Host"
                />
              </div>
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

      {/* MCP servers allow-list (policy.mcp_allowed) */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">MCP Servers</h3>
          <InfoTooltip title="MCP Servers">
            <p>Model Context Protocol servers give the agent extra tools. Only the servers you allow here can be used — <strong>deny-by-default</strong>: any others are stripped from the config before the agent launches, so they never even run.</p>
            <p className="mt-1.5">The list is discovered from your <code className="text-blue-300">~/.claude.json</code> and this project's <code className="text-blue-300">.mcp.json</code>.</p>
            <p className="mt-1.5 text-gray-400 italic">MCP servers are loaded at launch, so a change applies on the agent's <strong>next launch or resume</strong>, not to a running session.</p>
          </InfoTooltip>
        </div>
        {discovered.length === 0 && extraAllowed.length === 0 ? (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 italic">No MCP servers found in <span className="font-mono">~/.claude.json</span> or <span className="font-mono">.mcp.json</span>. Add one by name below to pre-authorise it.</p>
        ) : (
          <div className="space-y-1">
            {discovered.map((s) => (
              <label key={s.name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500/30"
                  checked={mcpAllowed.includes(s.name)}
                  onChange={(e) => toggleMcp(s.name, e.target.checked)}
                />
                <span className="text-sm font-mono text-gray-700 dark:text-gray-200">{s.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded px-1 py-px">{s.source}</span>
              </label>
            ))}
            {extraAllowed.map((name) => (
              <label key={name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500/30"
                  checked
                  onChange={() => toggleMcp(name, false)}
                />
                <span className="text-sm font-mono text-gray-700 dark:text-gray-200">{name}</span>
                <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900 rounded px-1 py-px">not found</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={mcpInput}
            onChange={(e) => setMcpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mcpInput.trim()) {
                e.preventDefault()
                toggleMcp(mcpInput.trim(), true)
                setMcpInput('')
              }
            }}
            placeholder="Allow a server by name…"
            className="flex-1 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => {
              if (mcpInput.trim()) {
                toggleMcp(mcpInput.trim(), true)
                setMcpInput('')
              }
            }}
            className="inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Plus className="w-3.5 h-3.5" /> Allow
          </button>
        </div>

        {/* Per-tool grants + read/write auto-allow */}
        <div className="pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-1.5 pt-1">
            <label className="text-[11px] font-semibold text-gray-400 dark:text-gray-500">Allowed individual tools</label>
            <InfoTooltip title="Per-tool grants">
              <p>Allow specific tools of a server that is <em>not</em> fully allow-listed, as <code className="text-blue-300">server__tool</code> (e.g. <code className="text-blue-300">linear__create_issue</code>). The server is kept so those tools work; its other tools are parked for your approval when first used.</p>
            </InfoTooltip>
          </div>
          <PathListEditor
            paths={policy.mcp_tools_allowed ?? []}
            onChange={(mcp_tools_allowed) => updatePolicy({ mcp_tools_allowed })}
            placeholder="e.g. linear__create_issue"
            addLabel="Add Tool"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-semibold text-gray-400 dark:text-gray-500">Auto-allow read-only tools</label>
              <InfoTooltip title="Auto-allow read-only tools">
                <p>Automatically allow MCP tools that look read-only (by name — <code className="text-blue-300">get_*</code>, <code className="text-blue-300">list_*</code>, <code className="text-blue-300">search_*</code>…), parking only writes and unrecognised tools for approval.</p>
                <p className="mt-1.5 text-gray-400 italic">This is a best-effort heuristic, not a guarantee — a server can mislabel a destructive tool. Off by default.</p>
              </InfoTooltip>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={policy.mcp_auto_allow_read === true}
                onChange={(e) => updatePolicy({ mcp_auto_allow_read: e.target.checked ? true : null })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
