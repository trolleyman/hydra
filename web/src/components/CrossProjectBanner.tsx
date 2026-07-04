import React from 'react'
import { Folder } from 'lucide-react'
import { ProjectIcon } from '../lib/projectIcon'

// The strip pinned across a toast card's top edge when the agent it concerns
// runs in a project OTHER than the one in view: a project icon + the project
// name, nothing more. Two tones:
//
//   'warning' - amber, for security-gate approvals: acting on the card changes
//     another project's policy, so the location must read as a caution.
//   'neutral' - gray, for plain status updates (needs input / finished /
//     waiting): the location is just context, so it's styled as a quiet
//     metadata eyebrow rather than an alert.
//
// Both share the same geometry so the two toast families read as one design.
const TONES = {
  warning: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200/70 dark:border-amber-500/20 text-amber-700 dark:text-amber-300',
  neutral: 'bg-gray-50 dark:bg-gray-900/40 border-gray-200/70 dark:border-gray-700/60 text-gray-500 dark:text-gray-400',
} as const

export const CrossProjectBanner: React.FC<{
  project: string
  tone: keyof typeof TONES
  // When set, the header renders the project's custom icon - the same glyph the
  // project switcher shows - instead of the plain folder. `icon` is the project's
  // icon string; `projectId` is needed to resolve a bare-path image icon.
  projectId?: string
  icon?: string | null
}> = ({ project, tone, projectId, icon }) => (
  <div className={`flex items-center gap-2 px-4 py-1.5 border-b font-mono text-[11px] ${TONES[tone]}`}>
    {projectId ? (
      <ProjectIcon icon={icon} projectId={projectId} size={12} className="shrink-0" />
    ) : (
      <Folder className="w-3 h-3 shrink-0" />
    )}
    <span className="truncate">{project}</span>
  </div>
)
