import type { ReactNode } from 'react'
import type { AgentConfig, AgentResponse, ConfigResponse, NetworkConfig, ProjectInfo, SandboxConfig } from '../api'
import { X, Plus, Globe, FolderOpen, EyeOff, Eye, Layers, Monitor, Sparkles, Terminal } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { AgentTerminal } from './AgentTerminal'
import { ShellEditor } from './ShellEditor'

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'defaults'

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
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
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
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
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
              <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
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

        {/* Pre-spawn script */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
            <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
              Pre-Spawn Script
            </label>
            <InfoTooltip title="Pre-Spawn Script">
              <p>A shell script run <strong>inside the sandbox</strong> via <code className="text-blue-300">/bin/bash</code> <strong>once</strong>, when the agent is first spawned, in its worktree with the same environment and confinement. It does <strong>not</strong> run on resume or for the web bash shells.</p>
              <p className="mt-1.5">Useful for one-off setup such as <code className="text-blue-300">mise trust</code>. The agent launches after the script falls through; an explicit <code className="text-blue-300">exit 1</code> aborts the launch. bash means <code className="text-blue-300">set -o pipefail</code> and other bashisms work.</p>
              <p className="mt-1.5">These environment variables describe the head and are available to the script:</p>
              <ul className="mt-1 space-y-0.5 list-none">
                <li><code className="text-blue-300">HYDRA_HEAD_ID</code> — the head's ID</li>
                <li><code className="text-blue-300">HYDRA_AGENT_TYPE</code> — <code className="text-blue-300">claude</code>, <code className="text-blue-300">gemini</code>, <code className="text-blue-300">copilot</code> or <code className="text-blue-300">bash</code></li>
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
            placeholder={'# e.g.\nmise trust'}
            rows={3}
          />
        </div>
      </div>
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
}) {
  const tabs: { id: SettingsSection; label: string; activeClass: string }[] = [
    { id: 'all', label: 'All Agents', activeClass: 'border-blue-500 text-blue-600 dark:text-blue-400' },
    { id: 'claude', label: 'Claude', activeClass: 'border-purple-500 text-purple-600 dark:text-purple-400' },
    { id: 'gemini', label: 'Gemini', activeClass: 'border-teal-500 text-teal-600 dark:text-teal-400' },
    { id: 'copilot', label: 'Copilot', activeClass: 'border-blue-500 text-blue-600 dark:text-blue-400' },
  ]

  return (
    <>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
        <div className="flex border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50 px-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === tab.id ? tab.activeClass : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {activeSection === 'all' && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Global Defaults</h2>
                </div>
                <button onClick={() => onTest('bash')} disabled={testing} className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm">
                  {testing ? 'Spawning...' : 'Test Terminal'}
                </button>
              </div>
              <ConfigForm value={config.defaults} onChange={(defaults) => setConfig({ ...config, defaults })} inherited={inheritedConfig?.defaults ?? null} agentType="default" selectedProject={selectedProject} defaultPrePrompt={config.default_pre_prompt} />
            </div>
          )}

          {activeSection === 'claude' && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Claude Overrides</h2>
                </div>
                <button onClick={() => onTest('claude')} disabled={testing} className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm">
                  {testing ? 'Spawning...' : 'Test Claude Console'}
                </button>
              </div>
              <ConfigForm value={config.agents['claude'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, claude: val } })} inherited={config.defaults} agentType="claude" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
            </div>
          )}

          {activeSection === 'gemini' && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Gemini Overrides</h2>
                </div>
                <button onClick={() => onTest('gemini')} disabled={testing} className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm">
                  {testing ? 'Spawning...' : 'Test Gemini Console'}
                </button>
              </div>
              <ConfigForm value={config.agents['gemini'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, gemini: val } })} inherited={config.defaults} agentType="gemini" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
            </div>
          )}

          {activeSection === 'copilot' && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Copilot Overrides</h2>
                </div>
                <button onClick={() => onTest('copilot')} disabled={testing} className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm">
                  {testing ? 'Spawning...' : 'Test Copilot Console'}
                </button>
              </div>
              <ConfigForm value={config.agents['copilot'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, copilot: val } })} inherited={config.defaults} agentType="copilot" selectedProject={selectedProject} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
            </div>
          )}

        </div>
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
