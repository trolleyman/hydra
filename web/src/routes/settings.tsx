import { createFileRoute, useBlocker, useCanGoBack, useRouter } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../stores/apiClient'
import { formatError } from '../api/format_error'
import { useProjectStore } from '../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../api'
import { Save, Loader2 } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import {
  type SettingsSection,
  SettingsContent,
} from '../components/SettingsComponents'
import { PageTopBar } from '../components/PageTopBar'
import { Tooltip } from '../components/Tooltip'
import { BrowserSections } from '../components/settings/BrowserSections'
import { ScopeTabs } from '../components/settings/shared'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

type GlobalSettingsTab = 'user' | 'browser'

const TAB_DESCRIPTIONS: Record<GlobalSettingsTab, string> = {
  user: 'Every project on this machine - stored in ~/.config/hydra/config.toml. Open a project\'s settings to configure that project itself.',
  browser: 'This browser only - stored locally, applied immediately, never written to a config file.',
}

function SettingsPage() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { selectedProjectId, projects } = useProjectStore()
  // Unlike the project page there is only one config scope here, so switching
  // tabs never refetches: the user-config draft survives a Browser detour.
  const [tab, setTab] = useState<GlobalSettingsTab>('user')
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [baseConfig, setBaseConfig] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSection>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testAgent, setTestAgent] = useState<AgentResponse | null>(null)
  const [testing, setTesting] = useState(false)

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
      useToastStore.getState().show({ message: 'Configuration saved to user successfully!', type: 'success' })
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
            <Tooltip content="Save settings">
              <button
                onClick={handleSave}
                aria-label="Save settings"
                className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              </button>
            </Tooltip>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
        <div className="max-w-4xl mx-auto">
          <ScopeTabs
            tabs={[
              { id: 'user' as GlobalSettingsTab, label: 'User' },
              { id: 'browser' as GlobalSettingsTab, label: 'Browser' },
            ]}
            active={tab}
            onSelect={setTab}
            description={TAB_DESCRIPTIONS[tab]}
          />
          {tab === 'browser' ? (
            <BrowserSections />
          ) : !effectiveProjectId ? (
            <div className="py-8 text-gray-500">Add a project to view user settings.</div>
          ) : loading ? (
            <div className="py-8 text-gray-500">Loading configuration...</div>
          ) : error ? (
            <div className="py-8 text-red-500">Error: {error}</div>
          ) : !config ? (
            <div className="py-8 text-gray-500">No configuration found.</div>
          ) : (
            <SettingsContent
              config={config}
              setConfig={setConfig}
              inheritedConfig={null}
              activeSection={activeSection}
              setActiveSection={setActiveSection}
              selectedProject={selectedProject}
              testAgent={testAgent}
              testing={testing}
              onTest={handleTest}
              onCloseTestAgent={handleCloseTestAgent}
              projectId={selectedProjectId ?? null}
              scope="user"
            />
          )}
        </div>
      </div>
    </div>
  )
}
