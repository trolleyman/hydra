import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CheckCircle, AlertCircle, AlertTriangle, Info, Bot, Clock, X } from 'lucide-react'
import { useToastStore, type Toast, type ToastType } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { IconButton } from './IconButton'
import { ApprovalCard } from './ApprovalToast'
import { CrossProjectBanner } from './CrossProjectBanner'
import { Badge } from './Badge'
import { BranchPill } from './BranchPill'
import { agentStatusBadge } from '../lib/agentDisplay'

// withBranchPills renders toast copy with `backtick` spans as inline mono pills
// (branch names — "Synced with `origin/main`", "merged into `main`"), matching
// how the dialogs embed branch names mid-sentence. Unpaired backticks stay
// literal; text without backticks passes through untouched.
function withBranchPills(text: string): React.ReactNode {
  const parts = text.split(/`([^`]*)`/) // odd indices are the quoted spans
  if (parts.length === 1) return text
  return parts.map((part, i) => (i % 2 === 1 ? <BranchPill key={i}>{part}</BranchPill> : part))
}

// Per-type visual identity: the icon and its tinted rounded square, mirroring the
// approval card's kind icon so the two toast styles read as one family.
const TYPE_VISUAL: Record<ToastType, { Icon: React.ComponentType<{ className?: string }>; wrap: string; bar: string }> = {
  success: { Icon: CheckCircle, wrap: 'bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-300', bar: 'bg-green-500' },
  error: { Icon: AlertCircle, wrap: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300', bar: 'bg-red-500' },
  warning: { Icon: AlertTriangle, wrap: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', bar: 'bg-amber-500' },
  info: { Icon: Info, wrap: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300', bar: 'bg-blue-500' },
}

// Per-variant button styling for a toast action — matched to the approval card's
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

const ToastItem: React.FC<{ toast: Toast; onDismiss: () => void }> = ({ toast, onDismiss }) => {
  const navigate = useNavigate()
  // Only auto-expiring toasts (duration > 0) get a countdown bar, and it's hidden
  // once the toast starts leaving so it doesn't redraw during the exit animation.
  const showCountdown = toast.duration > 0 && !toast.exiting

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

  const { Icon, wrap, bar } = TYPE_VISUAL[toast.type] ?? TYPE_VISUAL.info

  // Agent status transitions (and the merge-lifecycle toasts reusing the same
  // card) render as "<bot> <agent> <before> <status pill> <after>", the agent
  // label linking through to the agent (so there's no View button).
  if (toast.agentTransition) {
    const t = toast.agentTransition
    const badge = t.status ? agentStatusBadge(t.status) : undefined
    const before = t.before ?? 'transitioned to'
    // The queued-merge toast swaps the bot tile for the app's "merge queued"
    // identity — the emerald Clock of the armed pill / queue-merge button.
    const tile = t.icon === 'merge-queued'
      ? { Icon: Clock, wrap: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', bar: 'bg-emerald-500' }
      : { Icon: Bot, wrap, bar }
    const openAgent = () => {
      // Match a cross-project View: select the project (a no-op for the current
      // one) before routing, then tear the toast down.
      useProjectStore.getState().setSelectedProjectId(t.projectId)
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: t.projectId, agentId: t.agentId } })
      onDismiss()
    }
    return (
      <div
        role="status"
        className={`relative min-w-[17rem] max-w-[22rem] overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl ${
          toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
        }`}
      >
        {t.projectName && <CrossProjectBanner project={t.projectName} tone="neutral" />}
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${tile.wrap}`}>
              <tile.Icon className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={openAgent}
                title="Open this agent"
                className="block max-w-full truncate text-left text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 hover:underline dark:hover:text-blue-400 cursor-pointer transition-colors"
              >
                {t.agentName}
              </button>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-gray-500 dark:text-gray-400">
                {before && <span>{withBranchPills(before)}</span>}
                {badge && <Badge variant="sm" className={badge.className}>{badge.label}</Badge>}
                {t.after && <span>{withBranchPills(t.after)}</span>}
              </div>
            </div>
            <IconButton onClick={onDismiss}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>
        {showCountdown && (
          <div
            className={`toast-progress-bar absolute bottom-0 left-0 h-0.5 w-full opacity-60 ${tile.bar}`}
            style={{ animationDuration: `${toast.duration}ms`, animationPlayState: toast.paused ? 'paused' : 'running' }}
          />
        )}
      </div>
    )
  }
  const hasActions = toast.actions && toast.actions.length > 0
  return (
    <div
      role="status"
      className={`relative min-w-[17rem] max-w-[22rem] overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${wrap}`}>
            <Icon className="w-[18px] h-[18px]" />
          </div>
          <p className="min-w-0 flex-1 self-center text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{withBranchPills(toast.message)}</p>
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
        // (plain / transition / approval card) pauses uniformly — hovering freezes
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
