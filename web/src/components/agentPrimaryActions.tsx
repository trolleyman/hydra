import type { ReactNode } from 'react'
import { Clock, GitPullRequestArrow, LoaderCircle, Mail, Pencil, RotateCcw, Trash2, Upload } from 'lucide-react'
import type { AgentResponse } from '../api'
import type { AgentCommand } from '../lib/agentCommands'
import { providerLabel } from '../lib/forgeDisplay'
import { ProviderIcon } from './ReviewControls'

export interface AgentPrimaryActionAppearance {
  command: AgentCommand
  label: string
  tooltip?: string
  count?: number
  icon: ReactNode
  disabled?: boolean
  danger?: boolean
}

// The single source of truth for the six agent-page actions' visible identity.
// Both the top-bar controls and the sidebar context menu consume this list, so a
// dynamic View/Push/Create or queued/in-flight label can never drift between them.
export function agentPrimaryActionAppearances({
  agent,
  provider,
  merging = false,
  publishing = false,
  killing = false,
  restarting = false,
}: {
  agent: AgentResponse
  provider?: string
  merging?: boolean
  publishing?: boolean
  killing?: boolean
  restarting?: boolean
}): AgentPrimaryActionAppearance[] {
  const linked = !!agent.review
  const ahead = agent.review?.ahead ?? 0
  const readOnly = agent.review?.adopted === true && agent.review?.can_push === false
  const resolvedProvider = agent.review?.provider ?? provider
  const noun = resolvedProvider === 'github' ? 'PR' : 'MR'
  const leadWithPush = linked && !readOnly && ahead > 0
  const busy = merging || killing

  const publish: AgentPrimaryActionAppearance = publishing
    ? { command: 'publish', label: 'Publishing...', icon: <LoaderCircle className="w-4 h-4 animate-spin" />, disabled: true }
    : linked
      ? {
          command: 'publish',
          label: leadWithPush ? `Push to ${noun}` : `View ${noun}`,
          count: leadWithPush ? ahead : undefined,
          icon: leadWithPush
            ? <Upload className="w-4 h-4" />
            : <ProviderIcon provider={agent.review?.provider} className="w-4 h-4" />,
          disabled: busy,
        }
      : {
          command: 'publish',
          label: `Create ${noun}`,
          tooltip: `Create ${noun} on ${providerLabel(resolvedProvider)}`,
          icon: <ProviderIcon provider={provider} className="w-4 h-4" />,
          disabled: busy || publishing,
        }

  const merge: AgentPrimaryActionAppearance = merging
    ? { command: 'merge', label: 'Merging...', icon: <LoaderCircle className="w-4 h-4 animate-spin" />, disabled: true }
    : agent.merge_when_green
      ? { command: 'merge', label: 'Merge queued', icon: <Clock className="w-4 h-4" />, disabled: busy }
      : { command: 'merge', label: 'Merge', tooltip: `Merge into ${agent.base_branch || 'base'}`, icon: <GitPullRequestArrow className="w-4 h-4" />, disabled: busy }

  return [
    publish,
    merge,
    { command: 'mark-unread', label: 'Mark as unread', icon: <Mail className="w-4 h-4" /> },
    { command: 'rename', label: 'Rename', icon: <Pencil className="w-4 h-4" /> },
    { command: 'restart', label: 'Restart', tooltip: 'Restart the agent process, keeping its conversation, branch, and worktree', icon: <RotateCcw className="w-4 h-4" />, disabled: merging || killing || restarting },
    { command: 'kill', label: 'Kill', tooltip: 'Stop the agent and delete its worktree', icon: <Trash2 className="w-4 h-4" />, disabled: merging || killing, danger: true },
  ]
}
