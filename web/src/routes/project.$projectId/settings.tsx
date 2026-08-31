import { createFileRoute, useParams } from '@tanstack/react-router'
import { useEffect, useState, useMemo } from 'react'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import { refreshReviewConfig, selectProject, useProjectStore } from '../../stores/projectStore'
import type { ConfigResponse, AgentResponse } from '../../api'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import {
  type SettingsSection,
  SettingsContent,
} from '../../components/SettingsComponents'
import { useUnsavedChangesGuard } from '../../lib/unsavedChanges'
import { ProjectIconSection } from '../../components/settings/ProjectIconSection'
import { RemoveProjectSection } from '../../components/settings/RemoveProjectSection'
import { BrowserSections } from '../../components/settings/BrowserSections'
import { ScopeTabs, SettingsSaveAction } from '../../components/settings/shared'
import { AboutSection } from '../../components/settings/AboutSection'
import { FeatureFlagsSections } from '../../components/settings/FeatureFlagsSections'

export const Route = createFileRoute('/project/$projectId/settings')({
  component: ProjectSettingsPage,
})

type SettingsScope = 'project' | 'local' | 'user'
type SettingsTab = SettingsScope | 'browser' | 'features' | 'about'

const TAB_DESCRIPTIONS: Record<SettingsTab, string> = {
  project:
    'This project only - stored in .hydra/config.toml in the project root and shared with everyone working on it. Layered on top of the user config: path and host lists combine and pre-prompts append; other values override.',
  local:
    'This project, just you - stored in the untracked .hydra/config.local.toml and layered on top of the project config (lists combine, pre-prompts append, other values override). For personal overrides you do not want to commit.',
  user: 'Every project on this machine - stored in ~/.config/hydra/config.toml.',
  browser: 'This browser only - stored locally, applied immediately, never written to a config file.',
  features: 'Experimental behavior for this browser only. Flags are stored locally, apply immediately, and default off.',
  about: '',
}

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/project/$projectId/settings' })
  const selectedProject = useProjectStore((s) => selectProject(s, projectId))
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

  const hasUnsavedChanges = useMemo(() => {
    if (!config || !baseConfig) return false
    return JSON.stringify(config) !== baseConfig
  }, [config, baseConfig])

  useUnsavedChangesGuard(hasUnsavedChanges)

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

  // Settings links can target controls that mount only after the config fetch.
  // Browsers try the fragment before that async content exists, so retry once
  // the project tab has rendered and also honour later hash-only navigation.
  useEffect(() => {
    if (loading || tab !== 'project' || scope !== 'project') return
    let frame = 0
    const scrollToFragment = () => {
      if (window.location.hash !== '#test-notifications') return
      frame = window.requestAnimationFrame(() => {
        document.getElementById('test-notifications')?.scrollIntoView({ block: 'start' })
      })
    }
    scrollToFragment()
    window.addEventListener('hashchange', scrollToFragment)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', scrollToFragment)
    }
  }, [loading, tab, scope])

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

  // Switching between config tabs refetches and discards the draft, so guard
  // that the same way navigation is guarded. The Browser, Feature flags and
  // About tabs touch no config state, so moving to or from them needs no guard.
  function switchTab(t: SettingsTab) {
    if (t === tab) return
    if (t !== 'browser' && t !== 'features' && t !== 'about' && t !== scope) {
      if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Discard them?')) return
      setScope(t)
    }
    setTab(t)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Save lives in the global top bar beside its "Settings" crumb - the page
          has no header of its own. Browser preferences apply instantly, and
          About has no editable settings. */}
      {tab !== 'browser' && tab !== 'features' && tab !== 'about' && <SettingsSaveAction dirty={hasUnsavedChanges} saving={saving} onSave={handleSave} />}
      <div className="flex-1 overflow-auto [scrollbar-gutter:stable] bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
        <div className="max-w-4xl mx-auto">
          {/* Scope tabs: which settings store the page edits. Kept outside the
              loading swap so the strip doesn't flicker away on tab switch. */}
          <ScopeTabs
            tabs={[
              { id: 'project' as SettingsTab, label: 'Project' },
              { id: 'local' as SettingsTab, label: 'Local' },
              { id: 'user' as SettingsTab, label: 'User' },
              { id: 'browser' as SettingsTab, label: 'Browser' },
              { id: 'features' as SettingsTab, label: 'Feature flags' },
              { id: 'about' as SettingsTab, label: 'About' },
            ]}
            active={tab}
            onSelect={switchTab}
            description={TAB_DESCRIPTIONS[tab]}
          />
          {tab === 'about' ? (
            <AboutSection />
          ) : tab === 'features' ? (
            <FeatureFlagsSections />
          ) : tab === 'browser' ? (
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
