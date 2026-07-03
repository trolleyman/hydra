import React from 'react'
import { Folder } from 'lucide-react'

// The strip pinned across a toast card's top edge when the agent it concerns
// runs in a project OTHER than the one in view: a folder icon + the project
// name, nothing more. Two tones:
//
//   'warning' — amber, for security-gate approvals: acting on the card changes
//     another project's policy, so the location must read as a caution.
//   'neutral' — gray, for plain status updates (needs input / finished /
//     waiting): the location is just context, so it's styled as a quiet
//     metadata eyebrow rather than an alert.
//
// Both share the same geometry so the two toast families read as one design.
const TONES = {
  warning: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200/70 dark:border-amber-500/20 text-amber-700 dark:text-amber-300',
  neutral: 'bg-gray-50 dark:bg-gray-900/40 border-gray-200/70 dark:border-gray-700/60 text-gray-500 dark:text-gray-400',
} as const

export const CrossProjectBanner: React.FC<{ project: string; tone: keyof typeof TONES }> = ({ project, tone }) => (
  <div className={`flex items-center gap-2 px-4 py-1.5 border-b font-mono text-[11px] ${TONES[tone]}`}>
    <Folder className="w-3 h-3 shrink-0" />
    <span className="truncate">{project}</span>
  </div>
)
