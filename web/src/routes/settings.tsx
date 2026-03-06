import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import type { ConfigResponse, AgentConfig, AgentResponse } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const { selectedProjectId, projects } = useProjectStore()
  const [config, setConfig] = useState<ConfigResponse | null>(null)
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

  async function handleSave(scope: 'project' | 'user') {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(config, selectedProjectId ?? undefined, scope)
      alert('Configuration saved successfully!')
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
        prompt: 'bash',
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
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Configure global and project-specific defaults for Hydra agents.
            </p>
          </div>
          <Link to="/" className="text-sm text-blue-500 hover:text-blue-700 font-medium">
            ← Back to Agents
          </Link>
        </div>

        <div className="space-y-8">
          {/* Defaults Section */}
          <section className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Global Defaults</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Settings applied to all agent types unless overridden.</p>
            </div>
            <div className="p-6 space-y-4">
              <ConfigForm
                value={config.defaults}
                onChange={(defaults) => setConfig({ ...config, defaults })}
              />
            </div>
          </section>

          {/* Per-Agent Section */}
          {['claude', 'gemini'].map((agentType) => (
            <section key={agentType} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-tight">
                    {agentType} Overrides
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Specific settings for {agentType} agents.</p>
                </div>
                <button
                  onClick={() => handleTest(agentType)}
                  disabled={testing}
                  className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {testing ? 'Spawning...' : `Test ${agentType} Console`}
                </button>
              </div>
              <div className="p-6 space-y-4">
                <ConfigForm
                  value={config.agents[agentType] || {}}
                  onChange={(agentCfg) => setConfig({
                    ...config,
                    agents: { ...config.agents, [agentType]: agentCfg }
                  })}
                />
              </div>
            </section>
          ))}

          {/* Action Bar */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={() => handleSave('user')}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 cursor-pointer"
            >
              Save to User Config (Global)
            </button>
            <button
              onClick={() => handleSave('project')}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm shadow-blue-500/20 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Saving...' : `Save to ${selectedProject?.name || 'Project'} Config`}
            </button>
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
                  This is an ephemeral agent running with <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">bash</code>. 
                  It will be automatically killed when you close this window.
                </p>
                <AgentTerminal
                  agentId={testAgent.id}
                  projectId={selectedProjectId}
                  containerStatus={testAgent.container_status}
                />
              </div>
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
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          Dockerfile Path
        </label>
        <input
          type="text"
          value={value.dockerfile || ''}
          onChange={(e) => onChange({ ...value, dockerfile: e.target.value || null })}
          placeholder="./Dockerfile"
          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono"
        />
        <p className="text-[10px] text-gray-400 dark:text-gray-500">Relative to config file location.</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          Build Context
        </label>
        <input
          type="text"
          value={value.context || ''}
          onChange={(e) => onChange({ ...value, context: e.target.value || null })}
          placeholder="."
          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono"
        />
        <p className="text-[10px] text-gray-400 dark:text-gray-500">Build directory, relative to config file.</p>
      </div>
      <div className="md:col-span-2 space-y-1.5">
        <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          System Pre-Prompt
        </label>
        <textarea
          value={value.pre_prompt || ''}
          onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
          placeholder="You are a helpful assistant..."
          rows={5}
          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all leading-relaxed"
        />
        <p className="text-[10px] text-gray-400 dark:text-gray-500">Prepended to all agent prompts.</p>
      </div>
    </div>
  )
}
