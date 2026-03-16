import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../stores/apiClient'
import { formatError } from '../api/format_error'
import { useProjectStore } from '../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../api'
import { AlertCircle, Save } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'
import {
  type SettingsSection,
  SettingsContent,
} from '../components/SettingsComponents'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const { selectedProjectId, projects, systemStatus } = useProjectStore()
  const navigate = useNavigate()
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [baseConfig, setBaseConfig] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSection>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testAgent, setTestAgent] = useState<AgentResponse | null>(null)
  const [testing, setTesting] = useState(false)

  const development = systemStatus?.development ?? false
  const selectedProject = projects.find(p => p.id === selectedProjectId)
  // User config API requires a project ID in the path even though config is global.
  // Fall back to first available project if none is selected.
  const effectiveProjectId = selectedProjectId ?? projects[0]?.id ?? ''

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
      if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  useEffect(() => {
    if (!effectiveProjectId) return
    async function fetchConfig() {
      setLoading(true)
      try {
        const editCfg = await api.default.getConfig(effectiveProjectId, 'user')
        setConfig(editCfg)
        setBaseConfig(JSON.stringify(editCfg))
      } catch (err) {
        setError(formatError(err))
      } finally {
        setLoading(false)
      }
    }

    fetchConfig()
  }, [effectiveProjectId])

  async function handleSave() {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(effectiveProjectId, config, 'user')
      setBaseConfig(JSON.stringify(config))
      useDialogStore.getState().show({ title: 'Settings Saved', message: 'Configuration saved to user successfully!', type: 'info' })
    } catch (err) {
      useDialogStore.getState().show({ title: 'Save Failed', message: `Failed to save configuration: ${formatError(err)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(agentType: string) {
    setTesting(true)
    try {
      const resp = await api.default.spawnAgent(effectiveProjectId, {
        prompt: '', agent_type: agentType,
        id: `test-${agentType}-${Math.random().toString(36).slice(2, 6)}`, ephemeral: true,
      })
      setTestAgent(resp)
    } catch (err) {
      useDialogStore.getState().show({ title: 'Test Failed', message: `Failed to spawn test agent: ${formatError(err)}`, type: 'error' })
    } finally {
      setTesting(false)
    }
  }

  function handleCloseTestAgent() {
    if (testAgent?.ephemeral) {
      api.default.killAgent(effectiveProjectId, testAgent.id).catch(() => {})
    }
    setTestAgent(null)
  }

  if (!effectiveProjectId) return <div className="p-8 text-gray-500">Add a project to view user settings.</div>
  if (loading) return <div className="p-8 text-gray-500">Loading configuration...</div>
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>
  if (!config) return <div className="p-8 text-gray-500">No configuration found.</div>

  return (
    <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-start justify-between mb-8">
          <div className="flex-1">
            <div className="flex items-center gap-4 mb-2">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">User Settings</h1>
              {hasUnsavedChanges && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 text-xs font-bold border border-orange-200 dark:border-orange-800 animate-pulse">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Unsaved Changes
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Settings stored in ~/.config/hydra/config.toml for all projects.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            {selectedProjectId ? (
              <button onClick={() => navigate({ to: '/project/$projectId', params: { projectId: selectedProjectId } })}
                className="text-sm text-blue-500 hover:text-blue-700 font-medium shrink-0 cursor-pointer">
                ← Back to Agents
              </button>
            ) : (
              <button onClick={() => navigate({ to: '/' })}
                className="text-sm text-blue-500 hover:text-blue-700 font-medium shrink-0 cursor-pointer">
                ← Back
              </button>
            )}
            <button onClick={handleSave} disabled={saving || !hasUnsavedChanges}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg active:scale-95 cursor-pointer ${hasUnsavedChanges ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-500/25' : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 shadow-none cursor-not-allowed opacity-60'}`}
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        <SettingsContent
          config={config}
          setConfig={setConfig}
          inheritedConfig={null}
          activeSection={activeSection}
          setActiveSection={setActiveSection}
          development={development}
          selectedProject={selectedProject}
          testAgent={testAgent}
          testing={testing}
          onTest={handleTest}
          onCloseTestAgent={handleCloseTestAgent}
          projectId={selectedProjectId ?? null}
        />
      </div>
    </div>
  )
}
