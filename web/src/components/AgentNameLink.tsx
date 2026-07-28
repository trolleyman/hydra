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

  // Violet, not grey. The tile beside it is now a solid block of the event's
  // colour, so a grey Bot read as a disabled control next to it; violet is the
  // one hue the tile vocabulary doesn't spend on an agent lifecycle event
  // (green/emerald merge, red kill+error, amber warn, blue restart), so the
  // marker can own it without ever colliding with the tile it sits next to.
  const iconCls = `${title ? 'w-3.5 h-3.5' : 'w-3 h-3'} shrink-0 text-violet-500 dark:text-violet-400`
  // Sans, both sizes. The serif that means "an agent is speaking" in chat prose
  // was tried here on the agent title and dropped: at 15px semibold in a card
  // this size Merriweather reads heavy and sits oddly against the sans it is
  // surrounded by - the status pill, the subtitle, the branch pills and the
  // action buttons are all sans, so the title was the only serif thing on the
  // card and read as a mistake rather than a signal.
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
      {/* A title wraps to a second line rather than clipping: it is the headline
          of the card, agent titles are arbitrary-length human phrases, and at a
          fixed card width most of them would otherwise end in an ellipsis. The
          subtitle stays single-line - there the name is attribution, and a
          two-line one would out-weigh the title above it.
          `.optical-center` (index.css) is what stops the title reading high
          against the Bot: items-center centres the label's LINE BOX, which
          reserves descender room these titles mostly don't use, so the ink sat
          1.00px above the glyph's centre. The class takes that to 0.03px -
          measured with a zero-height inline-block probe on the baseline, not
          eyeballed. Safe against the clipping: the class pads the box and takes
          the same back out as negative margin, so a `g`/`y` still has room
          inside the overflow:hidden.
          It also shrinks the row, which is why the status line below carries a
          compensating margin (see AgentTransitionRow). The subtitle span is
          inline (`truncate`, not `line-clamp`), where the trim has nothing to
          act on - it is left on for consistency, and costs nothing there. */}
      <span className={`optical-center ${title ? 'line-clamp-2' : 'truncate'}`}>{agentName}</span>
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
