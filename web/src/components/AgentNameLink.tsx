import { useContext } from 'react'
import { Bot } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { ToastDismissContext } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { Tooltip } from './Tooltip'

// One way to name an agent on a notification surface: the Bot glyph, then the
// agent's title, linking through to it.
//
// The Bot is the AGENT-NAME marker and nothing else. The tile glyph on the same
// card says what happened (merged / needs input / killed - see agentToast), so
// if the Bot also appeared up there the card would show the same mark twice and
// neither would mean anything. Keeping the two jobs on two glyphs is why the
// approval card's agent line reads as "which agent" at a glance.
//
// `size` picks the role the name plays on the card, not just a font size:
//   - 'title'    - the name IS the headline (an agent status-transition toast).
//   - 'subtitle' - the headline is the event and the name is attribution under
//                  it (the security-gate approval card).
// Both are the same anatomy at two scales, so the two toast shapes read as one
// family.
export function AgentNameLink({
  agentName,
  agentId,
  projectId,
  size = 'title',
}: {
  agentName: string
  // Both are needed to route; either missing (an agent whose home we don't know)
  // renders the name as plain, non-interactive text.
  agentId?: string
  projectId?: string
  size?: 'title' | 'subtitle'
}) {
  const dismiss = useContext(ToastDismissContext)
  const title = size === 'title'

  // The name carries the weight; the glyph is a marker, so it sits a step back
  // in both sizes rather than matching the text colour.
  const iconCls = `${title ? 'w-3.5 h-3.5' : 'w-3 h-3'} shrink-0 text-gray-400 dark:text-gray-500`
  const rowCls = `flex max-w-full items-center ${title ? 'gap-1.5' : 'gap-1'} ${
    title
      ? 'text-sm font-semibold text-gray-900 dark:text-gray-100'
      : 'text-[11px] text-gray-500 dark:text-gray-400'
  }`
  // hover:underline on the row, not the name span: the row is a flex box whose
  // only text child is the name, so the rule lands on the name and skips the
  // glyph (an <svg> takes no text-decoration).
  const hoverCls = `transition-colors cursor-pointer hover:underline ${
    title ? 'hover:text-blue-600 dark:hover:text-blue-400' : 'hover:text-gray-800 dark:hover:text-gray-200'
  }`

  const body = (
    <>
      <Bot className={iconCls} />
      <span className="truncate">{agentName}</span>
    </>
  )

  if (!agentId || !projectId) {
    return <span className={rowCls}>{body}</span>
  }

  const openAgent = () => {
    // Match a cross-project View: select the project (a no-op for the current
    // one) before the link routes, then tear the toast down. `dismiss` is a
    // no-op outside a toast, so this is safe on any surface.
    useProjectStore.getState().setSelectedProjectId(projectId)
    dismiss()
  }

  return (
    // min-w-0 on the tooltip's inline-flex wrapper keeps the name truncating
    // instead of pushing the card wide.
    <Tooltip content="Open this agent" className="min-w-0 max-w-full">
      <Link
        to="/project/$projectId/agent/$agentId"
        params={{ projectId, agentId }}
        onClick={openAgent}
        className={`${rowCls} ${hoverCls}`}
      >
        {body}
      </Link>
    </Tooltip>
  )
}
