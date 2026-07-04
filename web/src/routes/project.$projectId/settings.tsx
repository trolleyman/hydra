import { createFileRoute, useBlocker, useParams, useCanGoBack, useRouter } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { useProjectStore } from '../../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../../api'
import { Save, Loader2 } from 'lucide-react'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import {
  type SettingsSection,
  SettingsContent,
  SettingSection,
} from '../../components/SettingsComponents'
import { PageTopBar } from '../../components/PageTopBar'
import { ProjectIconSection } from '../../components/settings/ProjectIconSection'
import { RemoveProjectSection } from '../../components/settings/RemoveProjectSection'

export const Route = createFileRoute('/project/$projectId/settings')({
  component: ProjectSettingsPage,
})

type SettingsScope = 'project' | 'user'

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/project/$projectId/settings' })
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { projects } = useProjectStore()
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
      if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = '' }
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

    fetchConfig()
  }, [projectId, scope])

  async function handleSave() {
    if (!config) return
    setSaving(true)
    try {
      await api.default.saveConfig(projectId, config, scope)
      setBaseConfig(JSON.stringify(config))
      useToastStore.getState().show({ message: `Configuration saved to ${scope} successfully!`, type: 'success' })
    } catch (err) {
      useDialogStore.getState().show({ title: 'Save Failed', message: `Failed to save configuration: ${formatError(err)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(agentType: string) {
    setTesting(true)
    try {
      const resp = await api.default.spawnAgent(projectId, {
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
      api.default.killAgent(projectId, testAgent.id).catch(() => {})
    }
    setTestAgent(null)
  }

  if (loading) return <div className="p-8 text-gray-500">Loading configuration...</div>
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>
  if (!config) return <div className="p-8 text-gray-500">No configuration found.</div>

  const scopeDescription = scope === 'project'
    ? 'Settings stored in .hydra/config.toml within the project root.'
    : 'Settings stored in ~/.config/hydra/config.toml for all projects.'

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Single "Settings" header bar with a small save button (always shown,
          never grayed). The show-sidebar toggle joins it when collapsed. */}
      <PageTopBar
        title="Settings"
        always
        onBack={canGoBack ? () => router.history.back() : undefined}
        right={
          <button
            onClick={handleSave}
            aria-label="Save settings"
            title="Save settings"
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          </button>
        }
      />
      <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
        <div className="max-w-4xl mx-auto">
          <SettingsContent
            config={config}
            setConfig={setConfig}
            inheritedConfig={inheritedConfig}
            activeSection={activeSection}
            setActiveSection={setActiveSection}
            selectedProject={selectedProject}
            testAgent={testAgent}
            testing={testing}
            onTest={handleTest}
            onCloseTestAgent={handleCloseTestAgent}
            projectId={projectId}
            iconSection={scope === 'project' && selectedProject ? <ProjectIconSection project={selectedProject} /> : undefined}
            scopeSelector={
              <SettingSection title="Scope" description={scopeDescription}>
                <div className="inline-flex p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
                  {(['project', 'user'] as SettingsScope[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setScope(s)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all cursor-pointer ${scope === s ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                    >
                      {s === 'project' ? 'Project' : 'Global'}
                    </button>
                  ))}
                </div>
              </SettingSection>
            }
          />
          {selectedProject && <RemoveProjectSection project={selectedProject} />}
        </div>
      </div>
    </div>
  )
}
