import { Bot, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { type ToastContent, type ToastAccent, type ToastProjectContext } from '../stores/toastStore'
import { AgentTransitionRow } from '../components/AgentTransitionRow'

// The emerald identity of the armed merge pill / queue-merge button, used for the
// "will merge when green" toast in place of the default (type-derived) accent.
const MERGE_QUEUED_ACCENT: ToastAccent = {
  wrap: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  bar: 'bg-emerald-500',
}

// An agent status transition (needs_input / finished / ...) or merge-lifecycle
// event (queued / merging / merged). Everything the standard toast body needs to
// render "<agent> <before> <status pill> <after>" with the agent name linking
// through to it.
export interface AgentTransitionSpec {
  // The agent's title (the clickable label) + where it lives (for the link).
  agentName: string
  agentId: string
  projectId: string
  // Rendered as the standard status pill (also 'merged'/'restarting'/'killed',
  // which exist only as pills on these toasts). Omit for a text-only row.
  status?: string
  // Copy before the pill. Defaults to 'transitioned to'; pass '' to lead with the
  // pill ("[merging] into `main`..."). `backtick` spans become inline branch pills.
  before?: string
  // Copy after the pill, e.g. the merge target ("into `main`").
  after?: string
  // Tile override: 'merge-queued' swaps the bot for the emerald Clock. Default bot.
  icon?: 'merge-queued'
  // Set when the agent runs in a DIFFERENT project - drives the neutral project
  // banner (shown only while that other project is not the one in view).
  projectName?: string | null
  projectIcon?: string | null
}

// agentTransitionToast builds the show() options for one of these toasts: the
// clickable agent + status-pill body, a Bot (or emerald Clock for a queued merge)
// tile, and - for an agent in another project - the neutral project banner. The
// quote-free card replaces the old plain `Agent "name" ...` string; spread it into
// show() alongside any plain fields:
//   show({ ...agentTransitionToast(spec), duration: 0 })
export function agentTransitionToast(spec: AgentTransitionSpec): {
  message: ToastContent
  icon: ReactNode
  accent?: ToastAccent
  projectContext?: ToastProjectContext
} {
  const queued = spec.icon === 'merge-queued'
  return {
    message: <AgentTransitionRow {...spec} />,
    icon: queued ? <Clock className="w-[18px] h-[18px]" /> : <Bot className="w-[18px] h-[18px]" />,
    accent: queued ? MERGE_QUEUED_ACCENT : undefined,
    projectContext: spec.projectName
      ? { projectId: spec.projectId, projectName: spec.projectName, icon: spec.projectIcon }
      : undefined,
  }
}
