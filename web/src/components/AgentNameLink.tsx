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
  //
  // The Bot is INLINE in the text, not a sibling flex item. As a flex item it sat
  // in its own column, so every line of a wrapped title was indented past it and
  // the second line left a block of dead space under the glyph. In the text flow
  // the title wraps back to the left edge and only the first line makes room.
  //
  // Sized in `em` and aligned in `cap` so both come from the font rather than a
  // measurement of one: the glyph is exactly as tall as the text's em box, and
  // `calc(0.5cap - 0.5em)` lowers it so its CENTRE lands on the cap-box centre
  // (icon centre wanted at 0.5cap above the baseline; vertical-align raises the
  // box's bottom, which is 0.5em below its centre). That is the same quantity
  // `.optical-center` trims the label to, so the two agree by construction - and
  // it is why this is not a `-mt-px` nudge, which CLAUDE.md rules out.
  const iconCls = `${title ? 'mr-1.5' : 'mr-1'} inline-block h-[1em] w-[1em] align-[calc(0.5cap_-_0.5em)] text-violet-500 dark:text-violet-400`
  // Sans, both sizes. The serif that means "an agent is speaking" in chat prose
  // was tried here on the agent title and dropped: at 15px semibold in a card
  // this size Merriweather reads heavy and sits oddly against the sans it is
  // surrounded by - the status pill, the subtitle, the branch pills and the
  // action buttons are all sans, so the title was the only serif thing on the
  // card and read as a mistake rather than a signal.
  //
  // A title wraps to a second line rather than clipping: it is the headline of
  // the card, agent titles are arbitrary-length human phrases, and at a fixed
  // card width most of them would otherwise end in an ellipsis. The subtitle
  // stays single-line - there the name is attribution, and a two-line one would
  // out-weigh the title above it.
  //
  // `.optical-center` trims the box to the cap-to-baseline ink, which is what
  // aligns this block against the toast's icon tile (see Toaster) and what the
  // status line below compensates a margin for (see AgentTransitionRow). It also
  // pads the box and takes the same back out as negative margin, so the clipped
  // variants keep room for a descender - and for the Bot, which hangs slightly
  // below the baseline.
  const blockCls = `optical-center max-w-full ${title ? 'line-clamp-2' : 'truncate'} ${
    title
      ? 'text-sm font-semibold text-gray-900 dark:text-gray-100'
      : 'text-[11px] text-gray-500 dark:text-gray-400'
  }`
  const hoverCls = `transition-colors cursor-pointer ${
    title ? 'hover:text-blue-600 dark:hover:text-blue-400' : 'hover:text-gray-800 dark:hover:text-gray-200'
  }`

  // The underline is on the NAME, not the whole link: a text-decoration on the
  // link would be drawn across the Bot's inline-block box too, striking through
  // the glyph.
  const body = (
    <>
      <Bot className={iconCls} />
      <span className="group-hover:underline">{agentName}</span>
    </>
  )

  if (!agentId || !projectId) {
    return <span className={blockCls}>{body}</span>
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
        className={`group ${blockCls} ${hoverCls}`}
      >
        {body}
      </Link>
    </Tooltip>
  )
}
