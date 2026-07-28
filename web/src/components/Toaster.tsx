import React from 'react'
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { useToastStore, ToastDismissContext, type Toast, type ToastType } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { IconButton } from './IconButton'
import { ApprovalCard } from './ApprovalToast'
import { CrossProjectBanner } from './CrossProjectBanner'
import { withBranchPills } from '../lib/branchPills'
import { highlightCode } from '../lib/markdown'

// Per-type visual identity: the icon and its tinted rounded square, mirroring the
// approval card's kind icon so the two toast styles read as one family.
const TYPE_VISUAL: Record<ToastType, { Icon: React.ComponentType<{ className?: string }>; wrap: string; bar: string }> = {
  success: { Icon: CheckCircle, wrap: 'bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-300', bar: 'bg-green-500' },
  error: { Icon: AlertCircle, wrap: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300', bar: 'bg-red-500' },
  warning: { Icon: AlertTriangle, wrap: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', bar: 'bg-amber-500' },
  info: { Icon: Info, wrap: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300', bar: 'bg-blue-500' },
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
const codeClass = 'max-h-40 overflow-auto px-2.5 pb-2 text-[11px] leading-relaxed font-mono text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words'

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
  // The tile glyph, tile tint and countdown-bar colour all default to the type
  // identity; a toast may override the glyph (`icon`, e.g. a Bot for agent rows)
  // and the tint+bar pair (`accent`, e.g. the emerald "merge queued" card).
  const iconNode = toast.icon ?? <base.Icon className="w-[18px] h-[18px]" />
  const wrap = toast.accent?.wrap ?? base.wrap
  const bar = toast.accent?.bar ?? base.bar
  // A plain string message is a single line, vertically centred against the tile;
  // a rich node (e.g. the two-line agent-transition row) tops out with the tile.
  const isStringMessage = typeof toast.message === 'string'
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
      className={`relative min-w-[17rem] max-w-[22rem] overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      {showProjectHeader && (
        <CrossProjectBanner project={pc!.projectName} tone="neutral" projectId={pc!.projectId} icon={pc!.icon} />
      )}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${wrap}`}>
            {iconNode}
          </div>
          <div className={`min-w-0 flex-1 ${isStringMessage ? 'self-center' : ''}`}>
            {isStringMessage
              ? <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{withBranchPills(toast.message as string)}</p>
              : toast.message}
            {toast.code && (
              <div className="mt-2 overflow-hidden rounded-md bg-gray-100 dark:bg-gray-900/60">
                {toast.codeLang && (
                  <div className="px-2.5 pt-1.5 text-[10px] font-mono tracking-wide text-gray-400 dark:text-gray-500">
                    {toast.codeLang}
                  </div>
                )}
                {codeHtml
                  ? <pre className={`${codeClass} ${toast.codeLang ? 'pt-1' : 'pt-2'}`} dangerouslySetInnerHTML={{ __html: codeHtml }} />
                  : <pre className={`${codeClass} ${toast.codeLang ? 'pt-1' : 'pt-2'}`}>{toast.code}</pre>}
              </div>
            )}
          </div>
          <IconButton onClick={onDismiss}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        {hasActions && (
          <div className="mt-3 flex items-center gap-2 flex-wrap pl-12">
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
