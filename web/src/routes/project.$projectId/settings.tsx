import { createFileRoute, Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { useProjectStore } from '../../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../../api'
import { AgentTerminal } from '../../components/AgentTerminal'
import { X, Layers, Monitor, Sparkles, FileText, AlertCircle, Save } from 'lucide-react'
import { useDialogStore } from '../../stores/dialogStore'
import {
  type SettingsSection,
  DefaultDockerfilesSection,
  ConfigForm,
} from '../../components/SettingsComponents'

export const Route = createFileRoute('/project/$projectId/settings')({
  component: ProjectSettingsPage,
})

type SettingsScope = 'project' | 'user'

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/project/$projectId/settings' })
  const { projects, systemStatus } = useProjectStore()
  const navigate = useNavigate()
  const [scope, setScope] = useState<SettingsScope>('project')
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [baseConfig, setBaseConfig] = useState<string | null>(null)
  const [inheritedConfig, setInheritedConfig] = useState<ConfigResponse | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSection>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testAgent, setTestAgent] = useState<AgentResponse | null>(null)
  const [testing, setTesting] = useState(false)

  const development = systemStatus?.development ?? false
  const selectedProject = projects.find(p => p.id === projectId)

  const hasUnsavedChanges = useMemo(() => {
    if (!config || !baseConfig) return false
    return JSON.stringify(config) !== baseConfig
  }, [config, baseConfig])

  useBlocker({
    shouldBlockFn: () => {
      if (hasUnsavedChanges) {
        return !window.confirm('You have unsaved changes. Discard them?')
      }
      return false
    },
    enableBeforeUnload: true,
  })

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
      setError(null)
      try {
        if (scope === 'project') {
          const editCfg = await api.default.getConfig(projectId, 'project')
          setConfig(editCfg)
          setBaseConfig(JSON.stringify(editCfg))
          const userCfg = await api.default.getConfig(projectId, 'user')
          setInheritedConfig(userCfg)
        } else {
          const editCfg = await api.default.getConfig(projectId, 'user')
          setConfig(editCfg)
          setBaseConfig(JSON.stringify(editCfg))
          setInheritedConfig(null)
        }
      } catch (err) {
        setError(formatError(err))
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
  }, [projectId, scope])

  async function handleSave() {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(projectId, config, scope)
      setBaseConfig(JSON.stringify(config))
      useDialogStore.getState().show({
        title: 'Settings Saved',
        message: `Configuration saved to ${scope} successfully!`,
        type: 'info'
      })
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Save Failed',
        message: `Failed to save configuration: ${formatError(err)}`,
        type: 'error'
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(agentType: string) {
    setTesting(true)
    try {
      const resp = await api.default.spawnAgent(projectId, {
        prompt: '',
        agent_type: agentType,
        id: `test-${agentType}-${Math.random().toString(36).slice(2, 6)}`,
        ephemeral: true,
      })
      setTestAgent(resp)
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Test Failed',
        message: `Failed to spawn test agent: ${formatError(err)}`,
        type: 'error'
      })
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading configuration...</div>
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>
  if (!config) return <div className="p-8 text-gray-500">No configuration found.</div>

  const scopeDescription = scope === 'project'
    ? 'Settings stored in .hydra/config.toml within the project root.'
    : 'Settings stored in ~/.config/hydra/config.toml for all projects.'

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
                  onClick={() => setScope('project')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${scope === 'project'
                    ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm cursor-default'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                >
                  Project: {selectedProject?.name || 'Current'}
                </button>
                <button
                  onClick={() => setScope('user')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${scope === 'user'
                    ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm cursor-default'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                >
                  User (Global)
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {scopeDescription}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <Link to="/project/$projectId" params={{ projectId }} className="text-sm text-blue-500 hover:text-blue-700 font-medium shrink-0">
              ← Back to Agents
            </Link>
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg active:scale-95 cursor-pointer ${hasUnsavedChanges
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
                          features: { ...config.features, terminal_bash: e.target.checked }
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
                      api.default.killAgent(projectId, testAgent.id).catch(() => { })
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
                  This is an ephemeral agent. It will be automatically killed when you close this window.
                </p>
                <AgentTerminal
                  agentId={testAgent.id}
                  projectId={projectId}
                  isEphemeral={testAgent.ephemeral}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
