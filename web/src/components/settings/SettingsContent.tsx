import { useEffect, type ReactNode } from 'react'
import type { AgentResponse, ConfigResponse, ProjectInfo } from '../../api'
import { X, Terminal } from 'lucide-react'
import { isTypingTarget } from '../../lib/shortcuts'
import { AgentTerminal } from '../AgentTerminal'
import { AgentTypeIcon, type AgentTypeIconName } from '../AgentTypeIcon'
import { Tooltip } from '../Tooltip'
import { AGENT_ACCENT } from '../../lib/agentTypeMeta'
import { SettingSection, type SettingsSection } from './shared'
import { ReviewSection } from './ReviewSection'
import { ResourceLimitsSection } from './ResourceLimitsSection'
import { ConfigForm } from './ConfigForm'
import { ArtifactsEditor } from './ArtifactsEditor'
import { PreviewsEditor } from './PreviewsEditor'
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

// ── SettingsContent ────────────────────────────────────────────────────────────
// Shared section body + test modal used by both settings pages. `scope` decides
// which sections are shown:
//   - "project": project-only concerns - icon, review, agent overrides for this
//     project, and the [artifacts]/[previews]/[tests]/[services] commands (those are
//     replaced wholesale by a project that defines its own, and are read from
//     the compared ref, so they are inherently project things).
//   - "local": the untracked per-user .hydra/config.local.toml overlay - agent
//     settings only; the array-section editors stay on the project tab (a local
//     file can still override entries by hand via tests_merge etc.).
//   - "user": the user config (~/.config/hydra/config.toml) agent defaults that
//     every project inherits.
// The browser-local preferences live on their own tab (BrowserSections), not here.
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
  scope,
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
  // Which config layer is being edited; see the component doc above.
  scope: 'project' | 'local' | 'user'
  // The project-icon editor - a project-scoped concern. Supplied by the project
  // settings page; the global page passes nothing.
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

  // User/local-scope files can still carry [artifacts]/[previews]/[tests]/[services]
  // (user-level ones apply to projects that define none of their own; local ones
  // replace or - with the *_merge opt-ins - patch the project's). The editors are
  // project-scope only, so surface a pointer instead of silently hiding them; the
  // values ride along in `config` untouched, so saving preserves them.
  const offScopeCommandCount =
    (config.artifacts?.length ?? 0) + (config.previews?.length ?? 0) + (config.tests?.length ?? 0) +
    (config.services?.length ?? 0)

  return (
    <>
      {scope === 'project' && iconSection}
      {/* Review is repo-specific, so it is offered under Project + Local only - a
          global (all-projects) provider/remote/target would be meaningless. */}
      {scope !== 'user' && selectedProject && (
        <ReviewSection
          review={config.review}
          onChange={(review) => setConfig({ ...config, review: review ?? undefined })}
          projectId={selectedProject.id}
          scope={scope}
        />
      )}
      {/* Resource limits apply to every scoped workload of a project and layer
          like other config, so they are offered at all scopes (a user-scope
          value is the default for every project). */}
      <ResourceLimitsSection
        resources={config.resources}
        onChange={(resources) => setConfig({ ...config, resources: resources ?? undefined })}
        scope={scope}
      />
      <SettingSection
        title="Agent"
        description="Which agent these settings apply to. “All agents” is the shared default; pick a specific agent to override it just for that one."
        action={
          /* shrink-0 rides on the Tooltip wrapper: it is what the section
             header's flex row now sees in place of the button. */
          <Tooltip content="Spawn a throwaway agent to try this configuration" className="shrink-0">
            <button
              onClick={() => onTest(activeSection === 'all' ? 'bash' : activeSection)}
              disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Terminal className="w-3.5 h-3.5" />
              {testing ? 'Spawning...' : 'Test'}
            </button>
          </Tooltip>
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

      {scope === 'project' && (
        <>
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
            <PreviewsEditor
              previews={config.previews ?? []}
              onChange={(previews) => setConfig({ ...config, previews })}
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
              notifyFailures={config.notify_test_failures}
              onNotifyFailuresChange={(v) => setConfig({ ...config, notify_test_failures: v })}
            />
          </div>

          <div className="mt-6">
            <ServicesEditor
              services={config.services ?? []}
              onChange={(services) => setConfig({ ...config, services })}
              projectId={projectId}
            />
          </div>
        </>
      )}

      {scope !== 'project' && offScopeCommandCount > 0 && (
        <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
          This {scope} config also defines {offScopeCommandCount} artifact/preview/test/service command
          {offScopeCommandCount === 1 ? '' : 's'}. Those sections are edited on the Project tab or by
          hand in {scope === 'user' ? '~/.config/hydra/config.toml' : '.hydra/config.local.toml'};
          saving here leaves them untouched.
        </p>
      )}

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
