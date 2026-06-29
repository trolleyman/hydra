import React, { useEffect, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, ArrowRight, Info, HelpCircle, Merge, Trash2, FolderSync, X } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'
import { IconButton } from './IconButton'
import { DialogIconTile, DialogCancelButton, DialogConfirmButton, type DialogTone } from './dialogPrimitives'
import type { DialogDetails } from '../stores/dialogStore'

export const Dialog: React.FC = () => {
  const { isOpen, title, message, type, variant, confirmLabel, details, showCancel, hide, onConfirm, onCancel } =
    useDialogStore()

  // Handle Escape (cancel) and Enter (confirm) keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === 'Escape') {
        handleCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onConfirm, onCancel])

  if (!isOpen) return null

  const getIcon = () => {
    switch (type) {
      case 'error':
        return <AlertCircle className="w-6 h-6 text-red-500" />
      case 'warning':
        return <AlertCircle className="w-6 h-6 text-amber-500" />
      case 'confirm':
        return <HelpCircle className="w-6 h-6 text-blue-500" />
      case 'info':
      default:
        return <Info className="w-6 h-6 text-blue-500" />
    }
  }

  const handleConfirm = () => {
    if (onConfirm) onConfirm()
    hide()
  }

  const handleCancel = () => {
    if (onCancel) onCancel()
    hide()
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      {variant === 'merge' ? (
        <RichConfirmPanel
          tone="emerald"
          icon={<Merge className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Merge branch'}
          confirmIcon={<Merge className="w-4 h-4" />}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          <MergeDetails details={details} />
        </RichConfirmPanel>
      ) : variant === 'kill' ? (
        <RichConfirmPanel
          tone="red"
          icon={<Trash2 className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Kill agent'}
          confirmIcon={<Trash2 className="w-4 h-4" />}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          <KillDetails details={details} />
        </RichConfirmPanel>
      ) : variant === 'updateBase' ? (
        <RichConfirmPanel
          tone="amber"
          icon={<FolderSync className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Update branch'}
          confirmIcon={<FolderSync className="w-4 h-4" />}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          <UpdateBaseDetails details={details} />
        </RichConfirmPanel>
      ) : (
        <div
          className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center gap-3">
              {getIcon()}
              <h3 id="dialog-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </h3>
            </div>
            <IconButton onClick={handleCancel}>
              <X className="w-5 h-5" />
            </IconButton>
          </div>

          <div className="px-6 py-4">
            <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {message}
            </p>
          </div>

          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-2.5 border-t border-gray-100 dark:border-gray-700">
            {(showCancel || type === 'confirm') && (
              <DialogCancelButton onClick={handleCancel}>Cancel</DialogCancelButton>
            )}
            <DialogConfirmButton tone={type === 'error' ? 'red' : 'blue'} onClick={handleConfirm}>
              {type === 'confirm' ? 'Confirm' : 'OK'}
            </DialogConfirmButton>
          </div>
        </div>
      )}
    </div>
  )
}

// Shared shell for the rich (merge/kill) confirmations: an icon tile + a stacked
// title/description, a slot for the variant's details chip, and a footer with a
// neutral Cancel and a toned confirm. Colours come paired with `dark:` variants
// (the mockups are light-only) so it reads correctly in both themes.
function RichConfirmPanel({
  tone,
  icon,
  title,
  description,
  confirmLabel,
  confirmIcon,
  onConfirm,
  onCancel,
  children,
}: {
  tone: DialogTone
  icon: ReactNode
  title: string
  description: string
  confirmLabel: string
  confirmIcon: ReactNode
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-[470px] overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-4">
        <div className="flex items-start gap-3.5">
          <DialogIconTile tone={tone}>{icon}</DialogIconTile>
          <div className="flex flex-col gap-1 min-w-0 pt-0.5">
            <h3 id="dialog-title" className="text-[16px] font-bold leading-tight text-gray-900 dark:text-gray-100">
              {title}
            </h3>
            <p className="text-[12.5px] leading-snug text-gray-500 dark:text-gray-400">{description}</p>
          </div>
        </div>
        {children}
      </div>
      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        <DialogConfirmButton tone={tone} icon={confirmIcon} onClick={onConfirm}>
          {confirmLabel}
        </DialogConfirmButton>
      </div>
    </div>
  )
}

// A caution line shown under the details chip (running-parent / lost-changes
// warnings). Amber to read as advisory rather than destructive.
function CautionNote({ note }: { note: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 text-xs font-medium text-amber-700 dark:text-amber-300">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span>{note}</span>
    </div>
  )
}

// The `from → to` branch chip shared by the merge / update-from-base panels.
// Only `from` truncates (the agent branch is long); `to` is the base branch —
// usually short like `main`, so it keeps its own width and only ellipsizes once
// it would eat more than ~40% of the row. `right` holds the trailing stats.
function BranchChip({
  from,
  to,
  right,
  arrowClass = 'text-emerald-600 dark:text-emerald-400',
}: {
  from: string
  to: string
  right: ReactNode
  arrowClass?: string
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 text-xs font-mono">
      <span className="text-gray-700 dark:text-gray-300 truncate min-w-0" title={from}>{from}</span>
      <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${arrowClass}`} />
      <span className="text-gray-700 dark:text-gray-300 shrink-0 truncate max-w-[40%]" title={to}>{to}</span>
      <span className="ml-auto flex items-center gap-2.5 shrink-0 pl-1">{right}</span>
    </div>
  )
}

function MergeDetails({ details }: { details?: DialogDetails }) {
  const from = details?.fromBranch || '—'
  const to = details?.toBranch || '—'
  const loading = details?.loading ?? false
  return (
    <>
      <BranchChip
        from={from}
        to={to}
        right={
          loading ? (
            <span className="text-gray-400 dark:text-gray-500">…</span>
          ) : (
            <>
              <span className="text-emerald-600 dark:text-emerald-400">+{details?.additions ?? 0}</span>
              <span className="text-red-500 dark:text-red-400">−{details?.deletions ?? 0}</span>
            </>
          )
        }
      />
      {details?.note && <CautionNote note={details.note} />}
    </>
  )
}

function UpdateBaseDetails({ details }: { details?: DialogDetails }) {
  // base → this branch: the base is merged *into* the agent's branch, so the
  // arrow points from base to branch (the reverse of MergeDetails).
  const base = details?.fromBranch || '—'
  const branch = details?.toBranch || '—'
  const behind = details?.behind ?? 0
  return (
    <>
      <BranchChip
        from={base}
        to={branch}
        arrowClass="text-amber-600 dark:text-amber-400"
        right={<span className="text-amber-600 dark:text-amber-400">{behind} behind</span>}
      />
      {details?.note && <CautionNote note={details.note} />}
    </>
  )
}

function KillDetails({ details }: { details?: DialogDetails }) {
  const lost = details?.lostFiles ?? 0
  return (
    <>
      {lost > 0 && (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 text-xs font-medium text-red-600 dark:text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {lost} unmerged file{lost !== 1 ? 's' : ''} in this worktree will be lost.
          </span>
        </div>
      )}
      {details?.note && <CautionNote note={details.note} />}
    </>
  )
}
