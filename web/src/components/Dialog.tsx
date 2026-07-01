import React, { useCallback, useEffect, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, ArrowRight, Info, HelpCircle, Merge, Trash2, FolderSync, X, Clock, LoaderCircle } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'
import { IconButton } from './IconButton'
import { DialogIconTile, DialogCancelButton, DialogConfirmButton, type DialogTone } from './dialogPrimitives'
import type { DialogDetails } from '../stores/dialogStore'

export const Dialog: React.FC = () => {
  const { isOpen, title, message, type, variant, confirmLabel, secondaryLabel, details, showCancel, hide, onConfirm, onSecondary, onCancel } =
    useDialogStore()

  // Memoized so the keydown effect can depend on them without re-subscribing every
  // render, and so the effect references them after their declaration (not before).
  const handleConfirm = useCallback(() => {
    if (onConfirm) onConfirm()
    hide()
  }, [onConfirm, hide])

  const handleSecondary = useCallback(() => {
    if (onSecondary) onSecondary()
    hide()
  }, [onSecondary, hide])

  const handleCancel = useCallback(() => {
    if (onCancel) onCancel()
    hide()
  }, [onCancel, hide])

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
  }, [isOpen, handleCancel, handleConfirm])

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
        <UpdateBasePanel
          title={title}
          confirmLabel={confirmLabel ?? 'Confirm'}
          details={details}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : variant === 'mergeGate' ? (
        <MergeGatePanel
          title={title}
          description={message}
          details={details}
          confirmLabel={confirmLabel ?? 'Queue merge'}
          secondaryLabel={secondaryLabel ?? 'Force merge'}
          onConfirm={handleConfirm}
          onSecondary={handleSecondary}
          onCancel={handleCancel}
        />
      ) : (
        <div
          className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-[#232b3a]">
            <div className="flex items-center gap-3">
              {getIcon()}
              <h3 id="dialog-title" className="text-lg font-semibold text-gray-900 dark:text-[#eef1f6]">
                {title}
              </h3>
            </div>
            <IconButton onClick={handleCancel}>
              <X className="w-5 h-5" />
            </IconButton>
          </div>

          <div className="px-6 py-4">
            <p className="text-sm text-gray-600 dark:text-[#8b94a6] whitespace-pre-wrap leading-relaxed">
              {message}
            </p>
          </div>

          <div className="px-6 py-4 bg-gray-50 dark:bg-[#0f141d] flex justify-end gap-2.5 border-t border-gray-100 dark:border-[#232b3a]">
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
      className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-2xl shadow-2xl w-full max-w-[470px] overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-4">
        <div className="flex items-start gap-3.5">
          <DialogIconTile tone={tone}>{icon}</DialogIconTile>
          <div className="flex flex-col gap-1 min-w-0 pt-0.5">
            <h3 id="dialog-title" className="text-[16px] font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
              {title}
            </h3>
            <p className="text-[12.5px] leading-snug text-gray-500 dark:text-[#8b94a6]">{description}</p>
          </div>
        </div>
        {children}
      </div>
      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-[#232b3a] bg-gray-50 dark:bg-[#0f141d]">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        <DialogConfirmButton tone={tone} icon={confirmIcon} onClick={onConfirm}>
          {confirmLabel}
        </DialogConfirmButton>
      </div>
    </div>
  )
}

// The merge-gate dialog (PLAN #68): shown when the head's tests aren't green and
// the user hits Merge (or the server soft-gate 409s). It explains why merging is
// gated and what the head's verdict is, then offers two outcomes — Force merge now
// (amber, the override) or Queue merge when green (emerald, the recommended path),
// alongside Cancel. The verdict chip + branch chip make the situation concrete.
function MergeGatePanel({
  title,
  description,
  details,
  confirmLabel,
  secondaryLabel,
  onConfirm,
  onSecondary,
  onCancel,
}: {
  title: string
  description: string
  details?: DialogDetails
  confirmLabel: string
  secondaryLabel: string
  onConfirm: () => void
  onSecondary: () => void
  onCancel: () => void
}) {
  const status = details?.testStatus
  const failed = details?.testFailed ?? 0
  const running = status === 'running'
  const chip =
    status === 'failing'
      ? { cls: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50', label: `${failed || ''} failing`.trim() }
      : running
        ? { cls: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50', label: details?.testProgress || 'running' }
        : { cls: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50', label: 'no verdict' }
  // Explains what the two buttons do, in this commit's terms.
  const gateHelp =
    status === 'failing'
      ? 'You can force the merge now, landing the failing tests on the branch — or queue it to merge automatically once they pass.'
      : running
        ? 'You can force the merge now, but the branch may carry issues the tests would catch — or queue it to merge automatically once they pass.'
        : 'You can force the merge now without a passing verdict — or queue it to merge automatically once the tests pass.'
  return (
    <div
      className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-2xl shadow-2xl w-full max-w-[470px] overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-4">
        <div className="flex items-start gap-3.5">
          {/* Blue spinner while tests are still running; amber warning otherwise. */}
          <DialogIconTile tone={running ? 'blue' : 'amber'}>
            {running ? <LoaderCircle className="w-5 h-5 animate-spin" /> : <AlertTriangle className="w-5 h-5" />}
          </DialogIconTile>
          <div className="flex flex-col gap-1 min-w-0 pt-0.5">
            <h3 id="dialog-title" className="text-[16px] font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
              {title}
            </h3>
            <p className="text-[12.5px] leading-snug text-gray-500 dark:text-[#8b94a6]">{description}</p>
          </div>
        </div>
        <BranchChip
          from={details?.fromBranch || '—'}
          to={details?.toBranch || '—'}
          arrowClass="text-amber-600 dark:text-amber-400"
          right={
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
              {running && <LoaderCircle className="w-3 h-3 animate-spin" />}
              {chip.label}
            </span>
          }
        />
        <p className="text-[11.5px] leading-snug text-gray-400 dark:text-gray-500">{gateHelp}</p>
      </div>
      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-[#232b3a] bg-gray-50 dark:bg-[#0f141d]">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        <DialogConfirmButton tone="amber" icon={<Merge className="w-4 h-4" />} onClick={onSecondary}>
          {secondaryLabel}
        </DialogConfirmButton>
        <DialogConfirmButton tone="emerald" icon={<Clock className="w-4 h-4" />} onClick={onConfirm}>
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
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-[#232b3a] text-xs font-mono">
      <span className="text-gray-700 dark:text-[#8b94a6] truncate min-w-0" title={from}>{from}</span>
      <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${arrowClass}`} />
      <span className="text-gray-700 dark:text-[#8b94a6] shrink-0 truncate max-w-[40%]" title={to}>{to}</span>
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

// A branch name rendered as an inline mono pill, the way the update-from-base
// dialog embeds branch names mid-sentence.
function BranchPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700/60 border border-gray-200 dark:border-gray-600 px-1.5 py-px font-mono text-[0.9em] text-gray-700 dark:text-gray-200 align-baseline">
      {children}
    </span>
  )
}

// The update-from-base confirmation. Unlike the merge/kill panels (icon tile +
// subtitle + chip), this one keeps a bordered header (icon tile + title + close)
// over a prose body that embeds the branch names as inline pills, with a blue
// Confirm — matching the agreed redesign. The base is merged *into* the agent's
// branch, so the branch is named first and the base second.
function UpdateBasePanel({
  title,
  confirmLabel,
  details,
  onConfirm,
  onCancel,
}: {
  title: string
  confirmLabel: string
  details?: DialogDetails
  onConfirm: () => void
  onCancel: () => void
}) {
  const base = details?.fromBranch || '—'
  const branch = details?.toBranch || '—'
  const behind = details?.behind ?? 0
  return (
    <div
      className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-gray-100 dark:border-[#232b3a]">
        <DialogIconTile tone="blue">
          <FolderSync className="w-5 h-5" />
        </DialogIconTile>
        <h3 id="dialog-title" className="flex-1 text-lg font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
          {title}
        </h3>
        <IconButton onClick={onCancel} aria-label="Close">
          <X className="w-5 h-5" />
        </IconButton>
      </div>

      <div className="px-5 py-4 flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-gray-700 dark:text-[#8b94a6]">
          <BranchPill>{branch}</BranchPill> is{' '}
          <span className="font-semibold text-gray-900 dark:text-[#eef1f6]">
            {behind} commit{behind !== 1 ? 's' : ''} behind
          </span>{' '}
          <BranchPill>{base}</BranchPill>.
        </p>
        <p className="text-sm leading-relaxed text-gray-500 dark:text-[#8b94a6]">
          Merge <BranchPill>{base}</BranchPill> into your branch to bring it up to date? This also re-baselines diff
          artifacts (e.g. screenshots) against the latest base.
        </p>
        {details?.note && <CautionNote note={details.note} />}
      </div>

      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-[#232b3a] bg-gray-50 dark:bg-[#0f141d]">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        <DialogConfirmButton tone="blue" onClick={onConfirm}>
          {confirmLabel}
        </DialogConfirmButton>
      </div>
    </div>
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
