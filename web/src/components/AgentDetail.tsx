import { useState, useEffect } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse } from '../api'
import { AgentTerminal } from './AgentTerminal'
import { DiffViewer } from '../DiffViewer'
import { formatStartedAgo } from './AgentComponents'
import { LoaderCircle, Merge, Trash2, Tag, RotateCcw, RefreshCcw, FolderSync } from 'lucide-react'

export function AgentDetail({
  agent,
  projectId,
  onKilled,
  onRestarted,
  onRefresh,
}: {
  agent: AgentResponse
  projectId: string | null
  onKilled: (id: string) => void
  onRestarted: (agent: AgentResponse) => void
  onRefresh?: () => void
}) {
  const [killing, setKilling] = useState(false)
  const [merging, setMerging] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (agent.created_at == null) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [agent.created_at])

  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
      : agent.agent_type === 'gemini'
      ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

  async function handleKill() {
    if (!window.confirm(`Are you sure you want to kill agent "${agent.id}"?\n\nThis will permanently stop the container, remove the git worktree, and delete the branch.`)) {
      return
    }
    setKilling(true)
    try {
      await api.default.killAgent(agent.id, projectId ?? undefined)
      onKilled(agent.id)
    } catch (err) {
      alert(`Failed to kill agent: ${err}`)
    } finally {
      setKilling(false)
    }
  }

  async function handleMerge() {
    if (!window.confirm(`Are you sure you want to merge agent "${agent.id}"?\n\nThis will merge the agent's branch into the base branch, then stop the container and clean up.`)) {
      return
    }
    setMerging(true)
    try {
      await api.default.mergeAgent(agent.id, projectId ?? undefined)
      onKilled(agent.id)
    } catch (err: any) {
      const errorData = await err.json?.().catch(() => null) || err
      if (errorData.error === 'merge_conflict') {
        alert(`CONFLICT: Merge failed due to git conflicts. Please resolve them manually or update from base.`)
      } else {
        alert(`Failed to merge agent: ${errorData.details || errorData.error || err}`)
      }
    } finally {
      setMerging(false)
    }
  }

  async function handleUpdateFromBase() {
    if (!window.confirm(`Update "${agent.branch_name}" from "${agent.base_branch}"?\n\nThis will attempt to merge "${agent.base_branch}" into your agent branch.`)) {
      return
    }
    setUpdating(true)
    try {
      await api.default.updateAgentFromBase(agent.id, projectId ?? undefined)
      if (onRefresh) onRefresh()
    } catch (err: any) {
      const errorData = await err.json?.().catch(() => null) || err
      if (errorData.error === 'merge_conflict') {
        alert(`CONFLICT: Update failed due to git conflicts. You may need to resolve them manually in the worktree.`)
      } else {
        alert(`Failed to update from base: ${errorData.details || errorData.error || err}`)
      }
    } finally {
      setUpdating(false)
    }
  }

  async function handleRestart() {
    if (!window.confirm(`Are you sure you want to restart agent "${agent.id}"?\n\nThis will discard all progress (container, worktree, branch) and restart with the same prompt.`)) {
      return
    }
    setRestarting(true)
    try {
      const newAgent = await api.default.restartAgent(agent.id, projectId ?? undefined)
      onRestarted(newAgent)
    } catch (err) {
      alert(`Failed to restart agent: ${err}`)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="w-full">
        {/* Header */}
        <div className="mb-6">
          {/* Title row */}
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{agent.id}</h1>
            <button
              onClick={handleMerge}
              disabled={merging || killing || restarting || updating}
              className="ml-2 w-6 h-6 flex items-center justify-center rounded-md border border-green-200 text-green-600 hover:bg-green-50 dark:border-green-900/30 dark:text-green-400 dark:hover:bg-green-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Merge agent"
            >
              {merging ? (
                <LoaderCircle className="w-3 h-3 animate-spin" />
              ) : (
                <Merge className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={handleUpdateFromBase}
              disabled={merging || killing || restarting || updating}
              className="w-6 h-6 flex items-center justify-center rounded-md border border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Update from base branch"
            >
              {updating ? (
                <LoaderCircle className="w-3 h-3 animate-spin" />
              ) : (
                <FolderSync className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={handleRestart}
              disabled={merging || killing || restarting || updating}
              className="w-6 h-6 flex items-center justify-center rounded-md border border-blue-200 text-blue-600 hover:bg-blue-50 dark:border-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Restart agent"
            >
              {restarting ? (
                <LoaderCircle className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={handleKill}
              disabled={merging || killing || restarting}
              className="w-6 h-6 flex items-center justify-center rounded-md border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/30 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Kill agent"
            >
              {killing ? (
                <LoaderCircle className="w-3 h-3 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Metadata row */}
          <div className="flex items-center gap-3">
            <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              {agent.agent_type}
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            {agent.branch_name && (
              <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                {agent.branch_name}
              </span>
            )}
            <span className="text-gray-300 dark:text-gray-600">|</span>
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                created {formatStartedAgo(agent.created_at)}
              </span>
            )}
          </div>
        </div>

        {/* Prompt */}
        {agent.prompt && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wide font-medium">Prompt</p>
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{agent.prompt}</p>
          </div>
        )}

        {/* Terminal */}
        <AgentTerminal
          agentId={agent.id}
          projectId={projectId}
          isEphemeral={agent.ephemeral}
          onRefresh={onRefresh}
        />

        {/* Diff viewer */}
        <DiffViewer agent={agent} projectId={projectId} />
      </div>
    </div>
  )
}
