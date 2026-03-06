import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import type { ConfigResponse, AgentConfig, AgentResponse } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

type ConfigScope = 'project' | 'user'
type SettingsSection = 'all' | 'claude' | 'gemini'

const DOCKERFILE_TEMPLATES: Record<string, { label: string; content: string }> = {
  none: { label: 'None', content: '' },
  golang: {
    label: 'Go (Golang)',
    content: '# Install Go 1.22\nRUN curl -fsSL https://go.dev/dl/go1.22.0.linux-amd64.tar.gz | tar -C /usr/local -xz\nENV PATH=$PATH:/usr/local/go/bin'
  },
  rust: {
    label: 'Rust',
    content: '# Install Rust\nRUN curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | s h -s -- -y\nENV PATH=$PATH:$HOME/.cargo/bin'
  },
  python: {
    label: 'Python Data Science',
    content: '# Install Python libraries\nRUN apt-get update && apt-get install -y python3-pip\nRUN pip3 install numpy pandas matplotlib scipy scikit-learn --break-system-packages'
  },
  nodejs: {
    label: 'Node.js Extra',
    content: '# Install additional Node.js tools\nRUN npm install -g pnpm yarn'
  }
}

function SettingsPage() {
  const { selectedProjectId, projects } = useProjectStore()
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [scope, setScope] = useState<ConfigScope>('project')
  const [activeSection, setActiveSection] = useState<SettingsSection>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testAgent, setTestAgent] = useState<AgentResponse | null>(null)
  const [testing, setTesting] = useState(false)

  const selectedProject = projects.find(p => p.id === selectedProjectId)

  useEffect(() => {
    async function fetchConfig() {
      setLoading(true)
      try {
        const cfg = await api.default.getConfig(selectedProjectId ?? undefined)
        setConfig(cfg)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }
    fetchConfig()
  }, [selectedProjectId])

  async function handleSave() {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(config, selectedProjectId ?? undefined, scope)
      alert(`Configuration saved to ${scope} successfully!`)
    } catch (err) {
      alert(`Failed to save configuration: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(agentType: string) {
    setTesting(true)
    try {
      const resp = await api.default.spawnAgent({
        prompt: '',
        agent_type: agentType,
        id: `test-${agentType}-${Math.random().toString(36).slice(2, 6)}`,
        ephemeral: true,
      }, selectedProjectId ?? undefined)
      setTestAgent(resp)
    } catch (err) {
      alert(`Failed to spawn test agent: ${err}`)
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading configuration...</div>
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>
  if (!config) return <div className="p-8 text-gray-500">No configuration found.</div>

  return (
    <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
            <div className="flex items-center gap-4 mt-2">
              <div className="flex p-1 bg-gray-200 dark:bg-gray-800 rounded-lg shrink-0">
                <button
                  onClick={() => setScope('project')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${scope === 'project'
                      ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                >
                  Project: {selectedProject?.name || 'Current'}
                </button>
                <button
                  onClick={() => setScope('user')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${scope === 'user'
                      ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                >
                  User (Global)
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {scope === 'project'
                  ? 'Settings stored in .hydra/config.toml within the project root.'
                  : 'Settings stored in ~/.config/hydra/config.toml for all projects.'}
              </p>
            </div>
          </div>
          <Link to="/" className="text-sm text-blue-500 hover:text-blue-700 font-medium shrink-0">
            ← Back to Agents
          </Link>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
          {/* Section Selector (Tabs) */}
          <div className="flex border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50 px-4">
            <button
              onClick={() => setActiveSection('all')}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'all'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              All Agents
            </button>
            <button
              onClick={() => setActiveSection('claude')}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'claude'
                  ? 'border-purple-500 text-purple-600 dark:text-purple-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              Claude
            </button>
            <button
              onClick={() => setActiveSection('gemini')}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'gemini'
                  ? 'border-teal-500 text-teal-600 dark:text-teal-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              Gemini
            </button>
          </div>

          <div className="p-6">
            {activeSection === 'all' && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <svg className="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                      </svg>
                    </div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Global Defaults</h2>
                  </div>
                  <button
                    onClick={() => handleTest('bash')}
                    disabled={testing}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    {testing ? 'Spawning...' : 'Test Terminal'}
                  </button>
                </div>
                <ConfigForm
                  value={config.defaults}
                  onChange={(defaults) => setConfig({ ...config, defaults })}
                  inherited={null}
                  agentType="default"
                />
              </div>
            )}

            {activeSection === 'claude' && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                      <svg className="w-4 h-4 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Claude Overrides</h2>
                  </div>
                  <button
                    onClick={() => handleTest('claude')}
                    disabled={testing}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    {testing ? 'Spawning...' : 'Test Claude Console'}
                  </button>
                </div>
                <ConfigForm
                  value={config.agents['claude'] || {}}
                  onChange={(val) => setConfig({ ...config, agents: { ...config.agents, claude: val } })}
                  inherited={config.defaults}
                  agentType="claude"
                />
              </div>
            )}

            {activeSection === 'gemini' && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                      <svg className="w-4 h-4 text-teal-600 dark:text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                      </svg>
                    </div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Gemini Overrides</h2>
                  </div>
                  <button
                    onClick={() => handleTest('gemini')}
                    disabled={testing}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    {testing ? 'Spawning...' : 'Test Gemini Console'}
                  </button>
                </div>
                <ConfigForm
                  value={config.agents['gemini'] || {}}
                  onChange={(val) => setConfig({ ...config, agents: { ...config.agents, gemini: val } })}
                  inherited={config.defaults}
                  agentType="gemini"
                />
              </div>
            )}
          </div>
        </div>

        {/* Action Bar */}
        <div className="flex items-center justify-end gap-3 pt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/25 active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            {saving ? 'Saving...' : `Save ${scope === 'project' ? 'Project' : 'Global'} Configuration`}
          </button>
        </div>

        {/* Test Terminal Modal */}
        {testAgent && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Test Console — {testAgent.agent_type}
                </h3>
                <button
                  onClick={() => setTestAgent(null)}
                  className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 transition-colors cursor-pointer"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-6 overflow-auto flex-1">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                  This is an ephemeral agent.
                  It will be automatically killed when you close this window.
                </p>
                <AgentTerminal
                  agentId={testAgent.id}
                  projectId={selectedProjectId}
                  containerStatus={testAgent.container_status}
                  isEphemeral={testAgent.ephemeral}
                />              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ConfigForm({
  value,
  onChange,
  inherited,
  agentType,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType: string
}) {
  const [template, setTemplate] = useState('none')

  function handleTemplateChange(name: string) {
    setTemplate(name)
    if (name !== 'none') {
      const content = DOCKERFILE_TEMPLATES[name].content
      const current = value.dockerfile_contents || ''
      onChange({ ...value, dockerfile_contents: current ? current + '\n' + content : content })
    }
  }

  const baseImage = `hydra-agent-${agentType === 'default' ? '<type>' : agentType}`

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Dockerfile Path
          </label>
          <input
            type="text"
            value={value.dockerfile || ''}
            onChange={(e) => onChange({ ...value, dockerfile: e.target.value || null })}
            placeholder={inherited?.dockerfile || './Dockerfile'}
            className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono shadow-inner"
          />
          <p className="text-[10px] text-gray-400 dark:text-gray-500 italic">Overrides Dockerfile Contents below if set.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Build Context
          </label>
          <input
            type="text"
            value={value.context || ''}
            onChange={(e) => onChange({ ...value, context: e.target.value || null })}
            placeholder={inherited?.context || '.'}
            className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono shadow-inner"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Dockerfile Contents (Extends Base)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400 dark:text-gray-500">Add Template:</span>
            <select
              value={template}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="text-[10px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 focus:outline-none cursor-pointer"
            >
              {Object.entries(DOCKERFILE_TEMPLATES).map(([id, t]) => (
                <option key={id} value={id}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="relative group">
          <div className="absolute left-3 top-2 text-blue-500 dark:text-blue-400 font-mono text-sm pointer-events-none opacity-60">
            FROM {baseImage}
          </div>
          <textarea
            value={value.dockerfile_contents || ''}
            onChange={(e) => onChange({ ...value, dockerfile_contents: e.target.value || null })}
            placeholder={inherited?.dockerfile_contents || '# Add your custom Dockerfile instructions here\nRUN apt-get install -y ...'}
            rows={6}
            className="w-full text-sm pt-8 px-3 pb-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono shadow-inner leading-relaxed"
          />
          <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <div className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-400 border border-gray-200 dark:border-gray-700 font-mono">
              Dockerfile Extension
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
          System Pre-Prompt
        </label>
        <textarea
          value={value.pre_prompt || ''}
          onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
          placeholder={inherited?.pre_prompt || 'You are a helpful assistant...'}
          rows={4}
          className="w-full text-sm px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all leading-relaxed shadow-inner"
        />
      </div>
    </div>
  )
}
