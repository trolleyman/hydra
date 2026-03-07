import { createFileRoute, Link, useBlocker } from '@tanstack/react-router'
import { useEffect, useState, useRef, useMemo, useLayoutEffect } from 'react'
import hljs from 'highlight.js'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import type { ConfigResponse, AgentConfig, AgentResponse } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'
import { X, Layers, Monitor, Sparkles, FileText, Plus, Trash2, AlertCircle, Save } from 'lucide-react'
import { InfoTooltip } from '../components/InfoTooltip'
import type { ProjectInfo } from '../api'

import { useDialogStore } from '../stores/dialogStore'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

type ConfigScope = 'project' | 'user'
type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'defaults' | 'features'

const DOCKERFILE_TEMPLATES: Record<string, { label: string; content: string; shared_mounts?: string[] }> = {
  none: { label: 'None', content: '' },
  golang: {
    label: 'Go (Golang)',
    content: '# Install Go 1.22\nRUN curl -fsSL https://go.dev/dl/go1.22.0.linux-amd64.tar.gz | tar -C /usr/local -xz\nENV PATH=$PATH:/usr/local/go/bin\n\n# Pre-install dependencies\nCOPY go.mod go.sum ./\nRUN go mod download',
    shared_mounts: ['~/.cache/go-build', '~/go/pkg/mod']
  },
  rust: {
    label: 'Rust',
    content: '# Install Rust\nRUN curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\nENV PATH=$PATH:$HOME/.cargo/bin'
  },
  python: {
    label: 'Python Data Science',
    content: '# Install Python libraries with apt cache mounts\nRUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt,sharing=locked \\\n    apt-get update && apt-get install -y python3-pip\nRUN pip3 install numpy pandas matplotlib scipy scikit-learn --break-system-packages'
  },
  nodejs: {
    label: 'Node.js',
    content: '# Pre-install dependencies\nCOPY package.json bun.lockb* package-lock.json* yarn.lock* ./\nRUN if [ -f bun.lockb ]; then npm install -g bun && bun install; \\\n    elif [ -f package-lock.json ]; then npm install; \\\n    elif [ -f yarn.lock ]; then npm install -g yarn && yarn install; \\\n    else npm install; fi'
  }
}

function SettingsPage() {
  const { selectedProjectId, projects, systemStatus } = useProjectStore()
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [baseConfig, setBaseConfig] = useState<string | null>(null)
  const [inheritedConfig, setInheritedConfig] = useState<ConfigResponse | null>(null)
  const [scope, setScope] = useState<ConfigScope>('project')
  const [activeSection, setActiveSection] = useState<SettingsSection>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testAgent, setTestAgent] = useState<AgentResponse | null>(null)
  const [testing, setTesting] = useState(false)

  const development = systemStatus?.development ?? false
  const selectedProject = projects.find(p => p.id === selectedProjectId)

  const hasUnsavedChanges = useMemo(() => {
    if (!config || !baseConfig) return false
    return JSON.stringify(config) !== baseConfig
  }, [config, baseConfig])

  // Block navigation if there are unsaved changes
  useBlocker({
    shouldBlockFn: () => {
      if (hasUnsavedChanges) {
        return !window.confirm('You have unsaved changes. Discard them?')
      }
      return false
    },
    enableBeforeUnload: true,
  })

  // Warn on browser reload/close
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  useEffect(() => {
    async function fetchConfig() {
      setLoading(true)
      try {
        const editCfg = await api.default.getConfig(selectedProjectId ?? undefined, scope)
        setConfig(editCfg)
        setBaseConfig(JSON.stringify(editCfg))
        if (scope === 'project') {
          const userCfg = await api.default.getConfig(selectedProjectId ?? undefined, 'user')
          setInheritedConfig(userCfg)
        } else {
          setInheritedConfig(null)
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }

    if (hasUnsavedChanges) {
      if (window.confirm('You have unsaved changes. Discard them?')) {
        fetchConfig()
      }
    } else {
      fetchConfig()
    }
  }, [selectedProjectId, scope])

  async function handleSave() {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(config, selectedProjectId ?? undefined, scope)
      setBaseConfig(JSON.stringify(config))
      useDialogStore.getState().show({
        title: 'Settings Saved',
        message: `Configuration saved to ${scope} successfully!`,
        type: 'info'
      })
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Save Failed',
        message: `Failed to save configuration: ${err}`,
        type: 'error'
      })
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
      useDialogStore.getState().show({
        title: 'Test Failed',
        message: `Failed to spawn test agent: ${err}`,
        type: 'error'
      })
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
        <div className="flex items-start justify-between mb-8">
          <div className="flex-1">
            <div className="flex items-center gap-4 mb-2">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
              {hasUnsavedChanges && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs font-bold border border-orange-200 dark:border-orange-800 animate-pulse">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Unsaved Changes
                </div>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex p-1 bg-gray-200 dark:bg-gray-800 rounded-lg shrink-0">
                <button
                  onClick={() => {
                    if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Discard them?')) {
                      return
                    }
                    setScope('project')
                  }}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${scope === 'project'
                      ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                >
                  Project: {selectedProject?.name || 'Current'}
                </button>
                <button
                  onClick={() => {
                    if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Discard them?')) {
                      return
                    }
                    setScope('user')
                  }}
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
          <div className="flex flex-col items-end gap-3">
            <Link to="/" className="text-sm text-blue-500 hover:text-blue-700 font-medium shrink-0">
              ← Back to Agents
            </Link>
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg active:scale-95 cursor-pointer ${
                hasUnsavedChanges
                  ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-500/25'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 shadow-none cursor-not-allowed opacity-60'
              }`}
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
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
            <button
              onClick={() => setActiveSection('copilot')}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'copilot'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              Copilot
            </button>
            <button
              onClick={() => setActiveSection('defaults')}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'defaults'
                  ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
            >
              Built-in Defaults
            </button>
            {development && (
              <button
                onClick={() => setActiveSection('features')}
                className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${activeSection === 'features'
                    ? 'border-pink-500 text-pink-600 dark:text-pink-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
              >
                Feature Flags
              </button>
            )}
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
                  inherited={inheritedConfig?.defaults ?? null}
                  agentType="default"
                  scope={scope}
                  selectedProject={selectedProject}
                  defaultPrePrompt={config.default_pre_prompt}
                />
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
                  scope={scope}
                  selectedProject={selectedProject}
                  allAgentsPrePrompt={config.defaults.pre_prompt ?? null}
                />
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
                  scope={scope}
                  selectedProject={selectedProject}
                  allAgentsPrePrompt={config.defaults.pre_prompt ?? null}
                />
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
                  <button
                    onClick={() => handleTest('copilot')}
                    disabled={testing}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    {testing ? 'Spawning...' : 'Test Copilot Console'}
                  </button>
                </div>
                <ConfigForm
                  value={config.agents['copilot'] || {}}
                  onChange={(val) => setConfig({ ...config, agents: { ...config.agents, copilot: val } })}
                  inherited={config.defaults}
                  agentType="copilot"
                  scope={scope}
                  selectedProject={selectedProject}
                  allAgentsPrePrompt={config.defaults.pre_prompt ?? null}
                />
              </div>
            )}

            {activeSection === 'defaults' && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="flex items-center gap-2 mb-6">
                  <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                    <FileText className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Built-in Default Dockerfiles</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">These are the base Dockerfiles embedded in Hydra. They are read-only and serve as the foundation for agent containers.</p>
                  </div>
                </div>
                <DefaultDockerfilesSection dockerfiles={config.default_dockerfiles ?? inheritedConfig?.default_dockerfiles ?? {}} />
              </div>
            )}

            {activeSection === 'features' && development && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="flex items-center gap-2 mb-6">
                  <div className="w-8 h-8 rounded-lg bg-pink-100 dark:bg-pink-900/30 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-pink-600 dark:text-pink-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Feature Flags</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Experimental or internal features. These are stored in the configuration file.</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30">
                    <div>
                      <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Terminal Bash</h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Enable the interactive bash terminal for agents.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={config.features?.terminal_bash ?? false}
                        onChange={(e) => setConfig({
                          ...config,
                          features: {
                            ...config.features,
                            terminal_bash: e.target.checked
                          }
                        })}
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>
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
                  onClick={() => {
                    if (testAgent.ephemeral) {
                      api.default.killAgent(testAgent.id, selectedProjectId ?? undefined).catch(() => { })
                    }
                    setTestAgent(null)
                  }}
                  className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
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
                  isEphemeral={testAgent.ephemeral}
                />              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function highlightDockerfile(code: string): string {
  try {
    return hljs.highlight(code, { language: 'dockerfile', ignoreIllegals: true }).value
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

function HighlightedDockerfileEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (val: string) => void
  placeholder?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.max(300, ta.scrollHeight) + 'px'
  }, [value])

  const highlighted = useMemo(() => highlightDockerfile(value), [value])

  return (
    <div className="relative">
      <pre
        aria-hidden
        className="absolute inset-0 m-0 pointer-events-none font-mono text-sm px-3 pb-3 leading-relaxed whitespace-pre-wrap break-words overflow-hidden bg-transparent hljs"
        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
      />
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="relative w-full min-h-[300px] text-sm px-3 pb-3 bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 font-mono leading-relaxed resize-none focus:outline-none placeholder-gray-300 dark:placeholder-gray-600"
        spellCheck={false}
      />
    </div>
  )
}

const DOCKERFILE_LABELS: Record<string, string> = {
  base: 'Base',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Copilot',
  bash: 'Bash',
}

const DOCKERFILE_ORDER = ['base', 'claude', 'gemini', 'copilot', 'bash']

function DefaultDockerfilesSection({ dockerfiles }: { dockerfiles: Record<string, string> }) {
  const keys = DOCKERFILE_ORDER.filter(k => k in dockerfiles).concat(
    Object.keys(dockerfiles).filter(k => !DOCKERFILE_ORDER.includes(k))
  )

  if (keys.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No default Dockerfiles available.</p>
  }

  return (
    <div className="space-y-6">
      {keys.map(key => (
        <div key={key} className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
              {DOCKERFILE_LABELS[key] ?? key} Dockerfile
            </label>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 font-medium">
              read-only
            </span>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden shadow-inner">
            <div className="max-h-64 overflow-y-auto">
              <pre
                className="px-4 py-3 text-xs font-mono whitespace-pre leading-relaxed hljs bg-transparent"
                dangerouslySetInnerHTML={{ __html: highlightDockerfile(dockerfiles[key]) }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ConfigForm({
  value,
  onChange,
  inherited,
  agentType,
  scope,
  selectedProject,
  defaultPrePrompt,
  allAgentsPrePrompt,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType: string
  scope: ConfigScope
  selectedProject?: ProjectInfo
  defaultPrePrompt?: string
  allAgentsPrePrompt?: string | null
}) {
  const [template, setTemplate] = useState('none')

  function handleTemplateChange(name: string) {
    setTemplate(name)
    if (name !== 'none') {
      const template = DOCKERFILE_TEMPLATES[name]
      const content = template.content
      const current = value.dockerfile_contents || ''

      const newConfig: AgentConfig = { ...value, dockerfile_contents: current ? current + '\n' + content : content }

      if (template.shared_mounts) {
        const currentMounts = value.shared_mounts || []
        // Add only unique mounts
        const newMounts = [...currentMounts]
        for (const m of template.shared_mounts) {
          if (!newMounts.includes(m)) newMounts.push(m)
        }
        newConfig.shared_mounts = newMounts
      }

      onChange(newConfig)
    }
  }

  const baseImage = `hydra-agent-${agentType === 'default' ? '<type>' : agentType}`

  const projectDir = scope === 'project' ? (selectedProject?.path || '/project') : '/home/<user>/project'

  function resolvePathExample(path: string) {
    if (!path) return '...'

    let hostSubDir = 'root'
    let hostPathSuffix = path

    if (path.startsWith('~/')) {
      hostSubDir = 'user'
      hostPathSuffix = path.substring(2)
    } else if (path.startsWith('/')) {
      hostSubDir = 'root'
      hostPathSuffix = path.substring(1)
    } else {
      hostSubDir = 'worktree'
      hostPathSuffix = path
    }

    return `${projectDir}/.hydra/cache/custom/${hostSubDir}/${hostPathSuffix}`
  }

  function resolveContainerPathExample(path: string) {
    if (!path) return '...'
    if (path.startsWith('~/')) {
      return `/home/hydra/${path.substring(2)}`
    }
    if (path.startsWith('/')) {
      return path
    }
    return `/project/${path}`
  }

  function resolveBuildContextExample(path: string) {
    if (!path) return `${projectDir}/.hydra/build/tmp`
    if (path.startsWith('/')) {
      return path
    }
    if (path.startsWith('~')) {
      return `/home/<user>${path.substring(1)}`
    }
    return `${projectDir}/${path}`
  }

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

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Shared Mounts
          </label>
          <InfoTooltip title="Shared Bind Mounts">
            <p>Paths inside the container that are shared between all agents in this project.</p>
            <ul className="list-disc ml-3 space-y-1 mt-1">
              <li><code className="text-blue-300">/abs/path</code>: Absolute path on the host (namespaced).</li>
              <li><code className="text-blue-300">~/path</code>: Relative to home directory (namespaced).</li>
              <li><code className="text-blue-300">rel/path</code>: Relative to project directory.</li>
            </ul>
          </InfoTooltip>
        </div>
        <div className="space-y-2 pt-0.5">
          {(value.shared_mounts || []).map((mount, index) => (
            <div key={index} className="flex flex-col gap-1.5 p-3 rounded-xl border border-gray-100 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-800/30">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={mount}
                  onChange={(e) => {
                    const newMounts = [...(value.shared_mounts || [])]
                    newMounts[index] = e.target.value
                    onChange({ ...value, shared_mounts: newMounts })
                  }}
                  placeholder="e.g. ~/.cache/go-build"
                  className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
                <button
                  onClick={() => {
                    const newMounts = (value.shared_mounts || []).filter((_, i) => i !== index)
                    onChange({ ...value, shared_mounts: newMounts.length > 0 ? newMounts : null })
                  }}
                  className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 px-1">
                <div className="space-y-0.5">
                  <span className="text-[9px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">In Container</span>
                  <p className="text-[10px] font-mono text-blue-600 dark:text-blue-400 truncate" title={resolveContainerPathExample(mount)}>
                    {resolveContainerPathExample(mount)}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[9px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Host Storage</span>
                  <p className="text-[10px] font-mono text-orange-600 dark:text-orange-400 truncate" title={resolvePathExample(mount)}>
                    {resolvePathExample(mount)}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              const newMounts = [...(value.shared_mounts || []), '']
              onChange({ ...value, shared_mounts: newMounts })
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Shared Mount
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Dockerfile (Extends Base)
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
        <div className="relative group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all shadow-inner overflow-hidden">
          <div className="px-3 pt-3 text-blue-500 dark:text-blue-400 font-mono text-sm pointer-events-none opacity-60">
            FROM {baseImage}
          </div>
          <HighlightedDockerfileEditor
            value={value.dockerfile_contents || ''}
            onChange={(val) => onChange({ ...value, dockerfile_contents: val || null })}
            placeholder={inherited?.dockerfile_contents || '# Add your custom Dockerfile instructions here\nRUN apt-get install -y ...'}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Build Context
          </label>
          <InfoTooltip title="Build Context">
            <p>The directory where the Docker build will be executed.</p>
            <ul className="list-disc ml-3 space-y-1 mt-1">
              <li><code className="text-blue-300">/abs/path</code>: Absolute path on the host.</li>
              <li><code className="text-blue-300">~/path</code>: Relative to your home directory.</li>
              <li><code className="text-blue-300">rel/path</code>: Relative to the project directory.</li>
            </ul>
            <p className="mt-2 text-gray-400 italic">Resolved: {resolveBuildContextExample(value.context || '')}</p>
          </InfoTooltip>
        </div>
        <input
          type="text"
          value={value.context || ''}
          onChange={(e) => onChange({ ...value, context: e.target.value || null })}
          placeholder={inherited?.context || '<projectDir>/.hydra/build/tmp'}
          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono shadow-inner"
        />
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
          Dockerignore (Override)
        </label>
        <div className="relative group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all shadow-inner">
          <textarea
            value={value.dockerignore_contents || ''}
            onChange={(e) => onChange({ ...value, dockerignore_contents: e.target.value || null })}
            placeholder={inherited?.dockerignore_contents || '# Add files to ignore during build\n.git\nnode_modules'}
            className="w-full min-h-[200px] text-sm p-3 bg-transparent text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none font-mono leading-relaxed resize-y"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}

