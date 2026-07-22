import { createFileRoute, useBlocker, useParams, useCanGoBack, useRouter } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { refreshReviewConfig, useProjectStore } from '../../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../../api'
import { Save, Loader2 } from 'lucide-react'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import {
  type SettingsSection,
  SettingsContent,
} from '../../components/SettingsComponents'
import { PageTopBar } from '../../components/PageTopBar'
import { ProjectIconSection } from '../../components/settings/ProjectIconSection'
import { RemoveProjectSection } from '../../components/settings/RemoveProjectSection'
import { BrowserSections } from '../../components/settings/BrowserSections'
import { ScopeTabs } from '../../components/settings/shared'

export const Route = createFileRoute('/project/$projectId/settings')({
  component: ProjectSettingsPage,
})

type SettingsScope = 'project' | 'local' | 'user'
type SettingsTab = SettingsScope | 'browser'

const TAB_DESCRIPTIONS: Record<SettingsTab, string> = {
  project:
    'This project only - stored in .hydra/config.toml in the project root and shared with everyone working on it. Layered on top of the user config: path and host lists combine and pre-prompts append; other values override.',
  local:
    'This project, just you - stored in the untracked .hydra/config.local.toml and layered on top of the project config (lists combine, pre-prompts append, other values override). For personal overrides you do not want to commit.',
  user: 'Every project on this machine - stored in ~/.config/hydra/config.toml.',
  browser: 'This browser only - stored locally, applied immediately, never written to a config file.',
}

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/project/$projectId/settings' })
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { projects } = useProjectStore()
  // The visible tab. `scope` lags behind it as the last *config* tab, so the
  // fetched config (and any unsaved draft) survives a detour via Browser.
  const [tab, setTab] = useState<SettingsTab>('project')
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
        const editCfg = await api.default.getConfig(projectId, scope)
        setConfig(editCfg)
        setBaseConfig(JSON.stringify(editCfg))
        // The "Inherited:" hints show the layer directly underneath the one
        // being edited: user for the project tab, project for the local tab.
        // The user tab is the bottom config layer, so nothing is shown.
        if (scope === 'project') {
          setInheritedConfig(await api.default.getConfig(projectId, 'user'))
        } else if (scope === 'local') {
          setInheritedConfig(await api.default.getConfig(projectId, 'project'))
        } else {
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
      // A save can change the effective [review] table; re-resolve the cached
      // config so the Review section's "effective" hints track what was saved
      // (mounts read the cache now instead of refetching).
      void refreshReviewConfig(projectId)
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

  // Switching between the two config tabs refetches and discards the draft, so
  // guard that the same way navigation is guarded. The Browser tab touches no
  // config state, so moving to or from it needs no guard.
  function switchTab(t: SettingsTab) {
    if (t === tab) return
    if (t !== 'browser' && t !== scope) {
      if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Discard them?')) return
      setScope(t)
    }
    setTab(t)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Single "Settings" header bar with a small save button (always shown,
          never grayed - except on the Browser tab, whose preferences apply
          instantly). */}
      <PageTopBar
        title="Settings"
        onBack={canGoBack ? () => router.history.back() : undefined}
        right={
          tab !== 'browser' ? (
            <button
              onClick={handleSave}
              aria-label="Save settings"
              title="Save settings"
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            </button>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
        <div className="max-w-4xl mx-auto">
          {/* Scope tabs: which settings store the page edits. Kept outside the
              loading swap so the strip doesn't flicker away on tab switch. */}
          <ScopeTabs
            tabs={[
              { id: 'project' as SettingsTab, label: 'Project' },
              { id: 'local' as SettingsTab, label: 'Local' },
              { id: 'user' as SettingsTab, label: 'User' },
              { id: 'browser' as SettingsTab, label: 'Browser' },
            ]}
            active={tab}
            onSelect={switchTab}
            description={TAB_DESCRIPTIONS[tab]}
          />
          {tab === 'browser' ? (
            <BrowserSections />
          ) : loading ? (
            <div className="py-8 text-gray-500">Loading configuration...</div>
          ) : error ? (
            <div className="py-8 text-red-500">Error: {error}</div>
          ) : !config ? (
            <div className="py-8 text-gray-500">No configuration found.</div>
          ) : (
            <>
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
                scope={scope}
                iconSection={scope === 'project' && selectedProject ? <ProjectIconSection project={selectedProject} /> : undefined}
              />
              {scope === 'project' && selectedProject && <RemoveProjectSection project={selectedProject} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
