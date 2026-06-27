import type { ReactNode } from 'react'
import type { AgentConfig, AgentResponse, ArtifactScript, ConfigResponse, NetworkConfig, ProjectInfo, SandboxConfig } from '../api'
import { useEffect, useState } from 'react'
import { X, Plus, Globe, FolderOpen, EyeOff, Eye, Layers, Terminal, Image, AlertTriangle, Server, RotateCw, CheckCircle2, Loader2, Save, AlertCircle } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { ServiceScript, ServiceStatus } from '../api'
import { InfoTooltip } from './InfoTooltip'
import { AgentTerminal } from './AgentTerminal'
import { ShellEditor } from './ShellEditor'
import { useThemeStore, THEME_MODES, THEME_MODE_ICON, THEME_MODE_LABEL } from '../lib/theme'
import { useDefaultTerminalRows, DEFAULT_SPAWN_ROWS, MIN_SPAWN_ROWS, MAX_SPAWN_ROWS } from '../lib/terminalGeometry'
import { AgentTypeIcon, AGENT_ACCENT, type AgentTypeIconName } from './AgentTypeIcon'

// A labelled block at the top of settings: a Title-Case heading, an optional
// one-line description, then the control(s). Used for Theme / Scope / Agent.
export function SettingSection({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {action}
      </div>
      {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

// Theme (light / dark / system). A client-only preference via the shared store —
// no explanation text, just the segmented control under a "Theme" heading.
function ThemeSection() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  return (
    <SettingSection title="Theme">
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
        {THEME_MODES.map((m) => {
          const Icon = THEME_MODE_ICON[m]
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {THEME_MODE_LABEL[m]}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}

// Terminal — a client-only user preference (localStorage, global; not project-
// scoped, so it reads/writes the same value on either settings page, like Theme)
// for the height new heads start at. Width always follows the browser's last
// terminal width; height follows the last height too, falling back to this
// default when the browser has no terminal history yet. Empty input = built-in
// default.
function TerminalSection() {
  const [rows, setRows] = useDefaultTerminalRows()
  return (
    <SettingSection
      title="Terminal"
      description={`Height (rows) new heads start at when this browser has no last terminal height yet. Width always follows your last terminal width. Default ${DEFAULT_SPAWN_ROWS}.`}
    >
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={MIN_SPAWN_ROWS}
          max={MAX_SPAWN_ROWS}
          value={rows ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === '') { setRows(null); return }
            const n = parseInt(v, 10)
            if (!Number.isFinite(n)) return
            setRows(Math.min(MAX_SPAWN_ROWS, Math.max(MIN_SPAWN_ROWS, n)))
          }}
          placeholder={String(DEFAULT_SPAWN_ROWS)}
          aria-label="Default terminal height in rows"
          className="w-28 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">rows</span>
      </div>
    </SettingSection>
  )
}

// The agent-type selector (replaces the old tab bar) — brand icon + label per
// agent. 'all' edits the shared defaults; the rest edit that agent's overrides.
const AGENT_OPTIONS: { id: SettingsSection; label: string; icon: AgentTypeIconName; color: string }[] = [
  { id: 'all', label: 'All agents', icon: 'all', color: AGENT_ACCENT.all },
  { id: 'claude', label: 'Claude', icon: 'claude', color: AGENT_ACCENT.claude },
  { id: 'gemini', label: 'Gemini', icon: 'gemini', color: AGENT_ACCENT.gemini },
  { id: 'copilot', label: 'Copilot', icon: 'copilot', color: AGENT_ACCENT.copilot },
  { id: 'codex', label: 'Codex', icon: 'codex', color: AGENT_ACCENT.codex },
]

function AgentSelector({ value, onChange }: { value: SettingsSection; onChange: (s: SettingsSection) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {AGENT_OPTIONS.map((o) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors cursor-pointer ${
              active
                ? `bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 shadow-sm ${o.color}`
                : 'bg-gray-50 dark:bg-gray-900/40 border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <AgentTypeIcon name={o.icon} className={`w-4 h-4 ${active ? o.color : ''}`} />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'codex' | 'defaults'

// ── EnabledToggle ─────────────────────────────────────────────────────────────
// A small on/off switch used to enable or disable a single artifact or service
// without deleting it. Green + "Enabled" when on; muted + "Disabled" when off.
function EnabledToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer select-none">
      <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
      <div className="w-9 h-5 bg-gray-300 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400/40 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
      <span className={`ml-2 text-xs font-semibold ${enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`}>
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
    </label>
  )
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
  const sandbox: SandboxConfig = value.sandbox ?? {}
  const network: NetworkConfig = sandbox.network ?? {}
  const networkEnabled = network.enabled !== false // default on

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
              <pre className="text-[10px] font-mono whitespace-pre-wrap text-gray-200 bg-gray-800 rounded p-1.5 max-h-48 overflow-y-auto">{defaultPrePrompt}</pre>
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
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-gray-200 bg-gray-800 rounded p-1.5 max-h-32 overflow-y-auto">{allAgentsPrePrompt}</pre>
                </>
              ) : (
                <p>No "All Agents" pre-prompt is configured. Set one in the <strong>All Agents</strong> tab to have it prepended here.</p>
              )}
              <p className="mt-1.5 text-gray-400 italic">Pre-prompts are merged in order: default → all agents → agent-specific.</p>
            </InfoTooltip>
          </div>
        )}
        <textarea
          value={value.pre_prompt || ''}
          onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
          placeholder={inherited?.pre_prompt || 'You are a helpful assistant...'}
          rows={4}
          className="w-full text-sm px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 leading-relaxed shadow-inner resize-y"
        />
      </div>

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
                <p>When off, the agent runs with no network at all. When on, all hosts are reachable.</p>
                <p className="mt-1.5 text-gray-400 italic">Per-host filtering via "allowed hosts" is reserved but not yet enforced.</p>
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
            <div className="space-y-1">
              <p className="text-[11px] text-gray-400 dark:text-gray-500 ml-0.5">
                Allowed hosts <span className="italic">(reserved — not yet enforced)</span>
              </p>
              <PathListEditor
                paths={network.allowed_hosts ?? []}
                onChange={(allowed_hosts) => updateNetwork({ allowed_hosts })}
                placeholder="e.g. api.anthropic.com"
                addLabel="Add Host"
              />
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

// ── ArtifactsEditor ──────────────────────────────────────────────────────────────
// Edits the per-project [[artifacts]] scripts that render visual artifacts (e.g.
// screenshots) for the diff viewer. Not agent-specific, so it lives outside the
// per-agent tabs.
export function ArtifactsEditor({
  artifacts,
  onChange,
}: {
  artifacts: ArtifactScript[]
  onChange: (artifacts: ArtifactScript[]) => void
}) {
  function update(index: number, patch: Partial<ArtifactScript>) {
    const next = artifacts.map((a, i) => (i === index ? { ...a, ...patch } : a))
    onChange(next)
  }
  function remove(index: number) {
    onChange(artifacts.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...artifacts, { name: '', command: '' }])
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <Image className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Diff Artifacts</h2>
        <InfoTooltip title="Diff Artifacts">
          <p>Per-project commands that render visual artifacts (e.g. screenshots or screen recordings) of a checkout. The diff viewer runs each against both sides of a comparison and shows the outputs that differ.</p>
          <p className="mt-1.5">The command runs via <code className="text-blue-300">bash -c</code> in the checkout directory with these variables set:</p>
          <ul className="mt-1 space-y-0.5 list-none">
            <li><code className="text-blue-300">HYDRA_ARTIFACT_OUTPUT</code> — directory to write images into</li>
            <li><code className="text-blue-300">HYDRA_ARTIFACT_SOURCE</code> — the checkout directory</li>
            <li><code className="text-blue-300">HYDRA_ARTIFACT_REF</code> — the resolved git ref</li>
          </ul>
          <p className="mt-1.5"><code className="text-blue-300">.png .jpg .gif</code> are diffed pixel-by-pixel; <code className="text-blue-300">.webm</code> video is diffed frame-by-frame when <strong>ffmpeg</strong> is installed (else by byte hash); other types (<code className="text-blue-300">.webp .avif .svg .bmp .pdf</code>) are compared by byte hash. Encode video as <strong>lossless</strong> <code className="text-blue-300">.webm</code> (e.g. <code className="text-blue-300">libvpx-vp9 -lossless 1</code>) so identical frames stay identical — a lossy encode changes pixels and reads as changed.</p>
        </InfoTooltip>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Visual artifacts generated for the diff viewer, stored as <span className="font-mono">[[artifacts]]</span> in config.toml.
      </p>

      <div className="space-y-4">
        {artifacts.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No artifact scripts configured.</p>
        )}
        {artifacts.map((a, index) => {
          const unsafe = a.unsafe_host === true
          const cleanIgnored = a.clean_ignored === true
          const enabled = a.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">— skipped in the diff viewer</span>
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
                          <p>Runs the command directly on the host with <strong>no sandbox</strong> — full access to your machine, network, and credentials.</p>
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
                          <p>Artifact runs reuse a small pool of checkouts, switching commits with <code className="font-mono">git checkout</code> — this resets tracked files but keeps git-ignored caches (e.g. <code className="font-mono">node_modules</code>) warm between runs.</p>
                          <p className="mt-1.5">Enable this to also wipe ignored files before each run (<code className="font-mono">git clean -fdx</code> instead of <code className="font-mono">-fd</code>) for a fully clean tree. Slower — only needed if stale ignored output can leak between commits.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Command</label>
                    <ShellEditor
                      value={a.command}
                      onChange={(val) => update(index, { command: val })}
                      placeholder="# e.g. bun run screenshots.ts"
                      rows={6}
                    />
                  </div>
                  {unsafe && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>Runs unsandboxed on the host with full access to your credentials. Only use for audited, self-contained commands.</span>
                    </div>
                  )}
                  </div>
                </div>
                <button
                  onClick={() => remove(index)}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer shrink-0"
                  title="Remove artifact"
                >
                  <X className="w-4 h-4" />
                </button>
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

// ── ServicesEditor ────────────────────────────────────────────────────────────
// Edits the per-project [[services]] — long-running commands the daemon
// supervises while the project is open (e.g. a host-side emulator pool). Shows
// each service's live status and offers a restart that picks up saved config.

// serviceStateBadge maps a live service state to a coloured label + icon.
function ServiceStateBadge({ status }: { status: ServiceStatus | undefined }) {
  if (!status) {
    return <span className="text-[11px] text-gray-400 dark:text-gray-500 italic">not started</span>
  }
  const map: Record<string, { label: string; cls: string; icon: ReactNode }> = {
    up: { label: 'Running', cls: 'text-emerald-600 dark:text-emerald-400', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    restarting: { label: 'Restarting', cls: 'text-amber-600 dark:text-amber-400', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
    failed: { label: 'Failed', cls: 'text-red-600 dark:text-red-400', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
    down: { label: 'Stopped', cls: 'text-gray-500 dark:text-gray-400', icon: <X className="w-3.5 h-3.5" /> },
  }
  const m = map[status.state] ?? map.down
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${m.cls}`} title={status.message || undefined}>
      {m.icon}
      {m.label}
      {status.restarts > 0 && <span className="font-normal opacity-70">· {status.restarts}/{status.max_restarts} restarts</span>}
    </span>
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

  function update(index: number, patch: Partial<ServiceScript>) {
    onChange(services.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }
  function remove(index: number) {
    onChange(services.filter((_, i) => i !== index))
  }
  function add() {
    onChange([...services, { name: '', command: '' }])
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
          <p>Long-running commands the daemon supervises while this project is open — e.g. a host-side pool of Android emulators shared by every head.</p>
          <p className="mt-1.5">Each service starts when the project opens, restarts with backoff if it exits unexpectedly (up to <strong>max restarts</strong>), and is process-group-killed on shutdown, project removal, or a config save.</p>
          <p className="mt-1.5">The command runs via <code className="text-blue-300">bash -c</code> from the project root, with <code className="text-blue-300">HYDRA_PROJECT_ROOT</code> and <code className="text-blue-300">HYDRA_SERVICE_NAME</code> set.</p>
        </InfoTooltip>
        <div className="flex-1" />
        <button
          onClick={restartAll}
          disabled={!projectId || restarting}
          title="Stop and restart this project's services (picks up saved config)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
        >
          <RotateCw className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`} />
          {restarting ? 'Restarting…' : 'Restart Services'}
        </button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 ml-10">
        Supervised long-running commands, stored as <span className="font-mono">[[services]]</span> in config.toml. Saving applies changes immediately.
      </p>

      <div className="space-y-4">
        {services.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 italic">No services configured.</p>
        )}
        {services.map((svc, index) => {
          const host = svc.host === true
          const enabled = svc.enabled !== false
          return (
            <div key={index} className={`rounded-xl border p-4 space-y-3 transition-colors ${enabled ? 'border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20' : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-100/70 dark:bg-gray-900/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-2">
                    <EnabledToggle enabled={enabled} onChange={(v) => update(index, { enabled: v ? undefined : false })} />
                    {!enabled && (
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">— not supervised</span>
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
                          <p>Runs the command directly on the host with <strong>no sandbox</strong> — full access to your machine, network and credentials.</p>
                          <p className="mt-1.5">Required for services that need host devices the sandbox hides, e.g. <code className="text-blue-300">/dev/kvm</code> for emulators.</p>
                        </InfoTooltip>
                      </span>
                    </label>
                    <div className="h-[38px] flex items-center ml-auto">
                      {enabled
                        ? <ServiceStateBadge status={statusByName.get(svc.name)} />
                        : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-400 dark:text-gray-500"><X className="w-3.5 h-3.5" />Disabled</span>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Command</label>
                    <ShellEditor
                      value={svc.command}
                      onChange={(val) => update(index, { command: val })}
                      placeholder="# e.g. scripts/emu-pool.sh up 3 --foreground"
                      rows={4}
                    />
                  </div>
                  {host && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>Runs unsandboxed on the host with full access to your credentials. Only use for trusted commands.</span>
                    </div>
                  )}
                  {statusByName.get(svc.name)?.state === 'failed' && statusByName.get(svc.name)?.message && (
                    <div className="flex items-start gap-1.5 text-[11px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span className="font-mono break-all">{statusByName.get(svc.name)?.message}</span>
                    </div>
                  )}
                  </div>
                </div>
                <button
                  onClick={() => remove(index)}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer shrink-0"
                  title="Remove service"
                >
                  <X className="w-4 h-4" />
                </button>
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

// ── FloatingSaveBar ───────────────────────────────────────────────────────────
// A bar pinned to the bottom of the viewport that appears whenever there are
// unsaved changes, so the user can save from anywhere on a long settings page
// without scrolling back to the top button.
export function FloatingSaveBar({
  visible,
  saving,
  onSave,
}: {
  visible: boolean
  saving: boolean
  onSave: () => void
}) {
  if (!visible) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 pl-4 pr-2 py-2 rounded-2xl bg-white/95 dark:bg-gray-800/95 backdrop-blur shadow-2xl border border-orange-200 dark:border-orange-800 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-1.5 text-orange-600 dark:text-orange-400 text-sm font-semibold">
        <AlertCircle className="w-4 h-4" />
        Unsaved changes
      </div>
      <button
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/25 active:scale-95 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <Save className="w-4 h-4" />
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// ── SettingsContent ────────────────────────────────────────────────────────────
// Shared tab bar + section body + test modal used by both settings pages.
export function SettingsContent({
  config,
  setConfig,
  inheritedConfig,
  activeSection,
  setActiveSection,
  selectedProject,
  testAgent,
  testing,
  onTest,
  onCloseTestAgent,
  projectId,
  scopeSelector,
}: {
  config: ConfigResponse
  setConfig: (c: ConfigResponse) => void
  inheritedConfig: ConfigResponse | null
  activeSection: SettingsSection
  setActiveSection: (s: SettingsSection) => void
  selectedProject: ProjectInfo | undefined
  testAgent: AgentResponse | null
  testing: boolean
  onTest: (agentType: string) => void
  onCloseTestAgent: () => void
  projectId: string | null
  // The scope (Project / Global) selector — rendered between Theme and Agent.
  // Supplied by the project settings page; the global page passes nothing.
  scopeSelector?: ReactNode
}) {

  return (
    <>
      <ThemeSection />
      <TerminalSection />
      {scopeSelector}
      <SettingSection
        title="Agent"
        description="Which agent these settings apply to. “All agents” is the shared default; pick a specific agent to override it just for that one."
        action={
          <button
            onClick={() => onTest(activeSection === 'all' ? 'bash' : activeSection)}
            disabled={testing}
            title="Spawn a throwaway agent to try this configuration"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          >
            <Terminal className="w-3.5 h-3.5" />
            {testing ? 'Spawning…' : 'Test'}
          </button>
        }
      >
        <AgentSelector value={activeSection} onChange={setActiveSection} />
      </SettingSection>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
        {activeSection === 'all' && (
          <ConfigForm value={config.defaults} onChange={(defaults) => setConfig({ ...config, defaults })} inherited={inheritedConfig?.defaults ?? null} agentType="default" selectedProject={selectedProject} defaultPrePrompt={config.default_pre_prompt} />
        )}
        {activeSection === 'claude' && (
          <ConfigForm value={config.agents['claude'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, claude: val } })} inherited={config.defaults} agentType="claude" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'gemini' && (
          <ConfigForm value={config.agents['gemini'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, gemini: val } })} inherited={config.defaults} agentType="gemini" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'copilot' && (
          <ConfigForm value={config.agents['copilot'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, copilot: val } })} inherited={config.defaults} agentType="copilot" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'codex' && (
          <ConfigForm value={config.agents['codex'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, codex: val } })} inherited={config.defaults} agentType="codex" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
      </div>

      <div className="mt-6">
        <ArtifactsEditor
          artifacts={config.artifacts ?? []}
          onChange={(artifacts) => setConfig({ ...config, artifacts })}
        />
      </div>

      <div className="mt-6">
        <ServicesEditor
          services={config.services ?? []}
          onChange={(services) => setConfig({ ...config, services })}
          projectId={projectId}
        />
      </div>

      {testAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Test Console — {testAgent.agent_type}</h3>
              <button onClick={onCloseTestAgent} className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 transition-colors cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-auto flex-1">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">This is an ephemeral agent. It will be automatically killed when you close this window.</p>
              <AgentTerminal agentId={testAgent.id} projectId={projectId} isEphemeral={testAgent.ephemeral} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
