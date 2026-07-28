import React from 'react'
import { Check, AlertCircle, TriangleAlert, Info, X } from 'lucide-react'
import { useToastStore, ToastDismissContext, type Toast, type ToastType } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { IconButton } from './IconButton'
import { ApprovalCard } from './ApprovalToast'
import { CrossProjectBanner } from './CrossProjectBanner'
import { withBranchPills } from '../lib/branchPills'
import { highlightCode } from '../lib/markdown'
import { TILE_TONE, TILE_BAR, TILE_GLYPH, type TileTone } from '../lib/tileTone'
import { TOAST_CARD_WIDTH } from '../lib/toastLayout'

// Per-type visual identity: the icon and its tinted rounded square. The tint and
// the countdown bar come from the shared tile table (lib/tileTone), which the
// approval card and the confirmation dialogs also draw from - so every icon tile
// in the app is the same object. Success is a bare tick: the tile is already a
// rounded square, so a tick-in-a-circle inside it read as a badge within a badge.
const TYPE_VISUAL: Record<ToastType, { Icon: React.ComponentType<{ className?: string }>; tone: TileTone }> = {
  success: { Icon: Check, tone: 'green' },
  error: { Icon: AlertCircle, tone: 'red' },
  warning: { Icon: TriangleAlert, tone: 'amber' },
  info: { Icon: Info, tone: 'blue' },
}

// Per-variant button styling for a toast action - matched to the approval card's
// action buttons (rounded-lg, solid accent primary), with the hand cursor.
const actionClass = (variant?: 'primary' | 'danger') => {
  const base = 'inline-flex items-center text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer'
  switch (variant) {
    case 'primary':
      return `${base} bg-blue-600 hover:bg-blue-500 text-white`
    case 'danger':
      return `${base} text-red-600 border border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-500/40 dark:hover:bg-red-500/10`
    default:
      return `${base} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200`
  }
}

// Shared body styling for a toast's code block, used by both the highlighted and
// the plain-text render so the two are pixel-identical apart from token colour.
const codeClass = 'max-h-40 overflow-auto text-[11px] font-mono text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words'

// The two size scales a toast renders at. `compact` is for a glance-and-gone
// acknowledgement (a copy confirmation): same anatomy, but the padding, the icon
// tile and the gaps all step down so a two-word title over a one-line value
// doesn't sit in a card that is mostly whitespace. Everything else keeps the
// roomier default, where the body is text you actually stop to read.
// Both scales are a FIXED width, not a min/max range - see lib/toastLayout for
// why, and why the default shares its width with the approval card.
const SIZE = {
  default: {
    card: `${TOAST_CARD_WIDTH} rounded-2xl`,
    pad: 'p-4',
    row: 'gap-3',
    tile: 'w-9 h-9 rounded-xl',
    message: 'text-sm leading-relaxed',
    codeWrap: 'mt-2 rounded-md',
    code: 'px-2.5 pb-2 leading-relaxed',
    codeTop: { tagged: 'pt-1', plain: 'pt-2' },
    actions: 'mt-3 pl-12',
  },
  compact: {
    card: 'w-[20rem] max-w-[calc(100vw-2rem)] rounded-xl',
    pad: 'p-2.5',
    row: 'gap-2.5',
    tile: 'w-7 h-7 rounded-lg',
    message: 'text-[13px] leading-snug',
    codeWrap: 'mt-1.5 rounded',
    code: 'px-2 pb-1.5 leading-snug',
    codeTop: { tagged: 'pt-1', plain: 'pt-1.5' },
    actions: 'mt-2 pl-9',
  },
} as const

const ToastItem: React.FC<{ toast: Toast; onDismiss: () => void }> = ({ toast, onDismiss }) => {
  // Only auto-expiring toasts (duration > 0) get a countdown bar, and it's hidden
  // once the toast starts leaving so it doesn't redraw during the exit animation.
  const showCountdown = toast.duration > 0 && !toast.exiting
  // The project a plain toast belongs to shows as a neutral header, but only once
  // a DIFFERENT project is in view (e.g. a sync started for project A, read after
  // switching to B). Subscribed so switching projects re-evaluates it live.
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const pc = toast.projectContext
  const showProjectHeader = pc != null && pc.projectId !== selectedProjectId

  // Security-gate approvals render the rich card instead of the plain message row.
  if (toast.approval) {
    return (
      <div className={toast.exiting ? 'animate-toast-out' : 'animate-toast-in'}>
        <ApprovalCard
          data={toast.approval}
          actions={toast.actions ?? []}
          toastId={toast.id}
          onDismiss={onDismiss}
        />
      </div>
    )
  }

  const base = TYPE_VISUAL[toast.type] ?? TYPE_VISUAL.info
  const size = toast.compact ? SIZE.compact : SIZE.default
  // The tile glyph, tile fill and countdown-bar colour all default to the type
  // identity; a toast may override the glyph (`icon`) and the fill+bar pair
  // (`accent`) - an agent toast does both, from its status (see lib/agentToast).
  const iconNode = toast.icon ?? <base.Icon className={toast.compact ? 'w-4 h-4' : 'w-[18px] h-[18px]'} />
  const wrap = toast.accent?.wrap ?? TILE_TONE[base.tone]
  const bar = toast.accent?.bar ?? TILE_BAR[base.tone]
  // A SENTENCE is vertically centred against the tile and wears the toast's prose
  // paragraph; a LAYOUT (the two-line agent-transition row) tops out with the tile
  // and styles itself. Keyed on the explicit flag, not on `typeof message`: a
  // sentence with untrusted text spliced into it arrives as a ReactNode from
  // pillText (lib/branchPills) and still wants the paragraph and the centring.
  // Only a string is scanned for backtick pills - a node has already been through
  // that, on the authored half only.
  const isProse = !toast.richMessage
  const hasActions = toast.actions && toast.actions.length > 0
  // A tagged code block (e.g. a `json` API error body) is syntax-coloured through
  // the shared highlighter; an unknown/absent language falls back to plain text.
  // Only the `.token` classes are used, not a highlighter root class - that would
  // drag github.css's own background over the block's tint (see lib/markdown).
  const codeHtml = toast.code && toast.codeLang ? highlightCode(toast.code, toast.codeLang) : null
  return (
    // Provider so rich `message` content (e.g. an agent link) can close its own
    // toast via ToastDismissContext instead of threading the id through show().
    <ToastDismissContext.Provider value={onDismiss}>
    <div
      role="status"
      className={`relative overflow-hidden bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl ${size.card} ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      {showProjectHeader && (
        <CrossProjectBanner project={pc!.projectName} tone="neutral" projectId={pc!.projectId} icon={pc!.icon} />
      )}
      <div className={size.pad}>
        <div className={`flex items-start ${size.row}`}>
          <div className={`shrink-0 flex items-center justify-center ${TILE_GLYPH} ${size.tile} ${wrap}`}>
            {iconNode}
          </div>
          {/* self-center for BOTH shapes, with a free top backstop: a flex item
              that is taller than the line cannot move, so a body bigger than the
              tile (a wrapped title) stays exactly where top-alignment put it,
              while a body smaller than the tile drops to the middle.
              This only reads right because both shapes are trimmed to their ink
              (`.optical-center` on the paragraph here, on the title and status
              runs in AgentTransitionRow). Untrimmed, the box carried ~8.5px of
              line-box slack below the last baseline and none above it, so
              centring the BOX still left the ink sitting high. */}
          <div className="min-w-0 flex-1 self-center">
            {isProse
              ? (
                <p className={`optical-center text-gray-700 dark:text-gray-200 ${size.message}`}>
                  {typeof toast.message === 'string' ? withBranchPills(toast.message) : toast.message}
                </p>
              )
              : toast.message}
            {toast.code && (
              // w-fit: the block hugs its content instead of stretching to the
              // toast's width. A short value (a branch name, a path) otherwise
              // trailed a band of empty tint out to the right edge.
              <div className={`w-fit max-w-full overflow-hidden bg-gray-100 dark:bg-gray-900/60 ${size.codeWrap}`}>
                {toast.codeLang && (
                  <div className={`pt-1.5 text-[10px] font-mono tracking-wide text-gray-400 dark:text-gray-500 ${toast.compact ? 'px-2' : 'px-2.5'}`}>
                    {toast.codeLang}
                  </div>
                )}
                {codeHtml
                  ? <pre className={`${codeClass} ${size.code} ${toast.codeLang ? size.codeTop.tagged : size.codeTop.plain}`} dangerouslySetInnerHTML={{ __html: codeHtml }} />
                  : <pre className={`${codeClass} ${size.code} ${toast.codeLang ? size.codeTop.tagged : size.codeTop.plain}`}>{toast.code}</pre>}
              </div>
            )}
          </div>
          <IconButton onClick={onDismiss} className={toast.compact ? '-mt-0.5 -mr-0.5' : ''}>
            <X className={toast.compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </IconButton>
        </div>
        {hasActions && (
          <div className={`flex items-center gap-2 flex-wrap ${size.actions}`}>
            {toast.actions!.map((action) => (
              <button
                key={action.label}
                onClick={() => action.onClick(toast.id)}
                className={actionClass(action.variant)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {showCountdown && (
        <div
          className={`toast-progress-bar absolute bottom-0 left-0 h-0.5 w-full opacity-60 ${bar}`}
          style={{ animationDuration: `${toast.duration}ms`, animationPlayState: toast.paused ? 'paused' : 'running' }}
        />
      )}
    </div>
    </ToastDismissContext.Provider>
  )
}

export const Toaster: React.FC = () => {
  const { toasts, dismiss, pause, resume } = useToastStore()

  if (toasts.length === 0) return null

  return (
    // z-[110] sits between the passive image lightbox (z-[100], which the approval
    // toasts must be visible over) and focused modal dialogs (z-[120], e.g. a
    // merge/kill confirmation, which must be visible over the toasts).
    <div className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        // A transparent wrapper carries the hover handlers so every toast variant
        // (plain / transition / approval card) pauses uniformly - hovering freezes
        // the auto-dismiss timer and countdown bar until the pointer leaves.
        <div
          key={toast.id}
          onMouseEnter={() => pause(toast.id)}
          onMouseLeave={() => resume(toast.id)}
        >
          <ToastItem toast={toast} onDismiss={() => dismiss(toast.id)} />
        </div>
      ))}
    </div>
  )
}
