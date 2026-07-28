import {
  CircleCheck,
  CircleDot,
  Clock,
  GitMerge,
  MessageCircleQuestion,
  RotateCcw,
  TriangleAlert,
  Trash2,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { type ToastContent, type ToastAccent, type ToastProjectContext } from '../stores/toastStore'
import { AgentTransitionRow } from '../components/AgentTransitionRow'
import { agentStatusTone } from './agentDisplay'
import { TILE_TONE, TILE_BAR, tileToneForBadge, type TileTone } from './tileTone'

// The tile glyph says WHAT HAPPENED. It is deliberately never a Bot: the Bot is
// the agent-name marker beside the title (see AgentNameLink), and a card that
// showed the same mark in both places would be telling you "an agent" twice and
// "what it did" never. So each lifecycle event gets its own glyph, and its tint
// comes from the same tone as the status pill underneath it (agentStatusTone),
// so the tile and the pill can't disagree.
//
// Statuses with no entry fall through to the neutral CircleDot rather than
// inventing a mark - a status that reaches here unmapped is a bug, and a vague
// dot is the honest way to render one.
const STATUS_TILE: Record<string, ComponentType<{ className?: string }>> = {
  needs_input: MessageCircleQuestion,
  errored: TriangleAlert,
  finished: CircleCheck,
  merging: GitMerge,
  merged: GitMerge,
  restarting: RotateCcw,
  killed: Trash2,
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
  // which exist only as pills on these toasts) AND as the tile glyph + tint.
  // Omit for a text-only row.
  status?: string
  // Copy before the pill. Defaults to 'transitioned to'; pass '' to lead with the
  // pill ("[merging] into `main`..."). `backtick` spans become inline branch pills.
  before?: string
  // Copy after the pill, e.g. the merge target ("into `main`").
  after?: string
  // Tile override for an event that isn't a status: 'merge-queued' is the armed
  // "merge when green" clock, which has no pill of its own.
  icon?: 'merge-queued'
  // Set when the agent runs in a DIFFERENT project - drives the neutral project
  // banner (shown only while that other project is not the one in view).
  projectName?: string | null
  projectIcon?: string | null
}

// agentTransitionToast builds the show() options for one of these toasts: the
// agent name + status-pill body, the event's tile glyph in the status tone, and
// - for an agent in another project - the neutral project banner. Spread it into
// show() alongside any plain fields:
//   show({ ...agentTransitionToast(spec), duration: 0 })
export function agentTransitionToast(spec: AgentTransitionSpec): {
  message: ToastContent
  richMessage: true
  icon: ReactNode
  accent: ToastAccent
  projectContext?: ToastProjectContext
} {
  const queued = spec.icon === 'merge-queued'
  // The armed-merge clock borrows the emerald identity of the merge pill/button
  // it was fired from; everything else takes the tone of its own status pill.
  const tone: TileTone = queued ? 'emerald' : tileToneForBadge(agentStatusTone(spec.status))
  const Icon = queued ? Clock : (spec.status ? STATUS_TILE[spec.status] : undefined) ?? CircleDot
  return {
    message: <AgentTransitionRow {...spec} />,
    // A layout, not a sentence: it brings its own two rows and type scale, and
    // tops out with the tile rather than centring against it.
    richMessage: true,
    icon: <Icon className="w-[18px] h-[18px]" />,
    accent: { wrap: TILE_TONE[tone], bar: TILE_BAR[tone] },
    projectContext: spec.projectName
      ? { projectId: spec.projectId, projectName: spec.projectName, icon: spec.projectIcon }
      : undefined,
  }
}
