import { useEffect, type ReactNode } from 'react'
import type { AgentResponse, ConfigResponse, ProjectInfo } from '../../api'
import { X, Terminal, AlertCircle, Save } from 'lucide-react'
import { isTypingTarget } from '../../lib/shortcuts'
import { AgentTerminal } from '../AgentTerminal'
import { AgentTypeIcon, type AgentTypeIconName } from '../AgentTypeIcon'
import { AGENT_ACCENT } from '../../lib/agentTypeMeta'
import { SettingSection, type SettingsSection } from './shared'
import { ThemeSection } from './ThemeSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'
import { ConfigForm } from './ConfigForm'
import { ArtifactsEditor } from './ArtifactsEditor'
import { TestsEditor } from './TestsEditor'
import { ServicesEditor } from './ServicesEditor'

// The agent-type selector (replaces the old tab bar) - brand icon + label per
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
        {saving ? 'Saving...' : 'Save'}
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
  iconSection,
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
  // The scope (Project / Global) selector - rendered between Theme and Agent.
  // Supplied by the project settings page; the global page passes nothing.
  scopeSelector?: ReactNode
  // The project-icon editor - a project-scoped concern, rendered next to the
  // scope selector. Supplied by the project settings page; global passes nothing.
  iconSection?: ReactNode
}) {
  // Escape closes the test console, matching the X button. We defer to the
  // embedded terminal: when focus is in the xterm (or any field) Esc belongs to
  // it, so we only close when the keystroke isn't aimed at a typing surface.
  useEffect(() => {
    if (!testAgent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTypingTarget(e.target)) onCloseTestAgent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [testAgent, onCloseTestAgent])

  return (
    <>
      <ThemeSection />
      <TerminalSection />
      <NotificationsSection />
      {scopeSelector}
      {iconSection}
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
            {testing ? 'Spawning...' : 'Test'}
          </button>
        }
      >
        <AgentSelector value={activeSection} onChange={setActiveSection} />
      </SettingSection>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
        {activeSection === 'all' && (
          <ConfigForm value={config.defaults} onChange={(defaults) => setConfig({ ...config, defaults })} inherited={inheritedConfig?.defaults ?? null} agentType="default" selectedProject={selectedProject} mcpServers={config.mcp_servers ?? undefined} defaultPrePrompt={config.default_pre_prompt} />
        )}
        {activeSection === 'claude' && (
          <ConfigForm value={config.agents['claude'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, claude: val } })} inherited={config.defaults} agentType="claude" selectedProject={selectedProject} mcpServers={config.mcp_servers ?? undefined} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'gemini' && (
          <ConfigForm value={config.agents['gemini'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, gemini: val } })} inherited={config.defaults} agentType="gemini" selectedProject={selectedProject} mcpServers={config.mcp_servers ?? undefined} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'copilot' && (
          <ConfigForm value={config.agents['copilot'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, copilot: val } })} inherited={config.defaults} agentType="copilot" selectedProject={selectedProject} mcpServers={config.mcp_servers ?? undefined} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
        {activeSection === 'codex' && (
          <ConfigForm value={config.agents['codex'] || {}} onChange={(val) => setConfig({ ...config, agents: { ...config.agents, codex: val } })} inherited={config.defaults} agentType="codex" selectedProject={selectedProject} mcpServers={config.mcp_servers ?? undefined} allAgentsPrePrompt={config.defaults.pre_prompt ?? null} />
        )}
      </div>

      <div className="mt-6">
        <ArtifactsEditor
          artifacts={config.artifacts ?? []}
          onChange={(artifacts) => setConfig({ ...config, artifacts })}
          concurrency={config.artifact_concurrency}
          onConcurrencyChange={(n) => setConfig({ ...config, artifact_concurrency: n })}
          prefetch={config.artifact_prefetch}
          onPrefetchChange={(v) => setConfig({ ...config, artifact_prefetch: v })}
        />
      </div>

      <div className="mt-6">
        <TestsEditor
          tests={config.tests ?? []}
          onChange={(tests) => setConfig({ ...config, tests })}
          concurrency={config.test_concurrency}
          onConcurrencyChange={(n) => setConfig({ ...config, test_concurrency: n })}
          prefetch={config.test_prefetch}
          onPrefetchChange={(v) => setConfig({ ...config, test_prefetch: v })}
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
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Test Console - {testAgent.agent_type}</h3>
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
