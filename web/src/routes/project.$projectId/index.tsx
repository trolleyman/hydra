import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'
import { useDialogStore } from '../../stores/dialogStore'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { isTypingTarget } from '../../lib/shortcuts'
import { SpawnForm } from '../../components/SpawnForm'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/project/$projectId/')({
  component: ProjectHomePage,
})

function ProjectHomePage() {
  const { projectId } = useParams({ from: '/project/$projectId/' })
  const { addAgent } = useAgentStore()
  const navigate = useNavigate()

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: agent.id } })
  }

  // With no agent open, Alt+↑/↓ jumps into the list: Alt+↓ selects the first
  // agent, Alt+↑ the last. This mirrors AgentDetail's Alt+arrow navigation
  // (which wraps through the list once an agent is selected) so the same keys
  // work from the project home page. Stays inert while typing or behind a
  // dialog / help overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (useDialogStore.getState().isOpen || useShortcutsStore.getState().open) return
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const list = useAgentStore.getState().agents
      if (list.length === 0) return
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? list[0] : list[list.length - 1]
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: next.id } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, projectId])

  return <SpawnForm projectId={projectId} onSpawned={handleSpawned} />
}
