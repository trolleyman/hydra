import React, { useCallback, useEffect, type ReactNode } from 'react'
import { AlertCircle, TriangleAlert, ArrowRight, ExternalLink, Info, HelpCircle, GitPullRequestArrow, Trash2, RotateCcw, FolderSync, Sparkles, X, Clock, LoaderCircle, Bot } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'
import { IconButton } from './IconButton'
import { DialogIconTile, DialogSectionLabel, DialogCancelButton, DialogConfirmButton, DialogSecondaryButton, type DialogTone } from './dialogPrimitives'
import { BranchPill } from './BranchPill'
import { withBranchPills } from '../lib/branchPills'
import { UrlText } from './HostName'
import { Markdown } from '../lib/MarkdownRenderer'
import type { DialogDetails } from '../stores/dialogStore'
import { ChangeStats } from './ChangeStats'
import { useOverlayScrollbarSuppression } from '../lib/useOverlayScrollbarSuppression'

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

  // Keep native scrollbar chrome below this modal. The shared hook also covers
  // a file lightbox beneath the dialog without either overlay releasing the
  // suppression while the other remains open.
  useOverlayScrollbarSuppression(isOpen)

  if (!isOpen) return null

  // The plain dialog used to hang a bare coloured glyph off its header while every
  // rich variant sat in a tinted tile. Same object, two looks - so it gets the
  // tile too, at the toast's 9x9 rather than the rich panel's 10x10 (this header
  // row is shorter). Warning reads AMBER here, matching the toast's warning tone.
  const getIcon = () => {
    switch (type) {
      case 'error':
        return <DialogIconTile tone="red" size="sm"><AlertCircle className="w-[18px] h-[18px]" /></DialogIconTile>
      case 'warning':
        return <DialogIconTile tone="amber" size="sm"><TriangleAlert className="w-[18px] h-[18px]" /></DialogIconTile>
      case 'confirm':
        return <DialogIconTile tone="blue" size="sm"><HelpCircle className="w-[18px] h-[18px]" /></DialogIconTile>
      case 'info':
      default:
        return <DialogIconTile tone="blue" size="sm"><Info className="w-[18px] h-[18px]" /></DialogIconTile>
    }
  }

  return (
    // Top of the stack. It keeps confirmation dialogs (merge / kill / discard
    // ...) above the approval toasts (z-[110]) - you're mid-decision here, so an
    // approval toast must not cover the buttons - and above the portalled
    // popover tier (z-[9999]: dropdown menus, tooltips). A menu is what usually
    // *opened* the dialog, and at 9999 it punched a bright hole through the
    // modal scrim while the dialog sat behind it.
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      {variant === 'merge' ? (
        <RichConfirmPanel
          tone="emerald"
          icon={<GitPullRequestArrow className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Merge branch'}
          confirmIcon={<GitPullRequestArrow className="w-4 h-4" />}
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
      ) : variant === 'restart' ? (
        <RichConfirmPanel
          tone="amber"
          icon={<RotateCcw className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Restart agent'}
          confirmIcon={<RotateCcw className="w-4 h-4" />}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          {details?.note ? (
            <p className="text-xs leading-snug text-amber-700 dark:text-amber-400">{withBranchPills(details.note)}</p>
          ) : null}
        </RichConfirmPanel>
      ) : variant === 'updateBase' ? (
        <UpdateBasePanel
          title={title}
          confirmLabel={confirmLabel ?? 'Confirm'}
          secondaryLabel={secondaryLabel ?? 'Fix with agent'}
          details={details}
          onConfirm={handleConfirm}
          onSecondary={onSecondary ? handleSecondary : undefined}
          onCancel={handleCancel}
        />
      ) : variant === 'externalLink' ? (
        <RichConfirmPanel
          tone="amber"
          icon={<ExternalLink className="w-5 h-5" />}
          title={title}
          description={message}
          confirmLabel={confirmLabel ?? 'Open link'}
          confirmIcon={<ExternalLink className="w-4 h-4" />}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          {/* The URL in full, laid out like the approval card's fetch preview -
              same mono box, same lowlight - because it asks the same question,
              and the two should not need to be read differently. */}
          <div className="px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-[#232b3a] font-mono text-xs break-all text-gray-600 dark:text-[#8b94a6]">
            <UrlText url={details?.url ?? ''} />
          </div>
        </RichConfirmPanel>
      ) : variant === 'sendPrompt' ? (
        <SendPromptPanel
          title={title}
          description={message}
          details={details}
          confirmLabel={confirmLabel ?? 'Send to agent'}
          secondaryLabel={secondaryLabel ?? 'Spawn agent'}
          onConfirm={handleConfirm}
          onSecondary={onSecondary ? handleSecondary : undefined}
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
              {/* .optical-center: this header centres the title against the icon
                  tile, and items-center centres the title's LINE BOX - descender
                  room the words mostly don't use - so it read ~1px high. */}
              <h3 id="dialog-title" className="optical-center text-lg font-semibold text-gray-900 dark:text-[#eef1f6]">
                {withBranchPills(title)}
              </h3>
            </div>
            <IconButton onClick={handleCancel}>
              <X className="w-5 h-5" />
            </IconButton>
          </div>

          <div className="px-6 py-4">
            <p className="text-sm text-gray-600 dark:text-[#8b94a6] whitespace-pre-wrap leading-relaxed">
              {withBranchPills(message)}
            </p>
          </div>

          <div className="px-6 py-4 bg-gray-50 dark:bg-[#0f141d] flex justify-end gap-2.5 border-t border-gray-100 dark:border-[#232b3a]">
            {(showCancel || type === 'confirm') && (
              <DialogCancelButton onClick={handleCancel}>Cancel</DialogCancelButton>
            )}
            {/* confirmLabel was documented as rich-variants-only, so callers that
                passed one here (Remove project, Switch to chat, ...) silently got
                the generic "Confirm". Honour it - a button that names its action is
                the whole reason those call sites set it - keeping the old wording as
                the fallback. */}
            <DialogConfirmButton tone={type === 'error' ? 'red' : 'blue'} onClick={handleConfirm}>
              {confirmLabel ?? (type === 'confirm' ? 'Confirm' : 'OK')}
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
            {/* Branch names arrive backticked from the call site and render as
                inline mono pills - the same convention the toasts use, so a
                branch reads as a branch wherever it is named. */}
            <h3 id="dialog-title" className="text-base font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
              {withBranchPills(title)}
            </h3>
            <p className="text-xs leading-snug text-gray-500 dark:text-[#8b94a6]">{withBranchPills(description)}</p>
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

// The send-a-prompt confirmation: a one-click action somewhere in the UI wants
// to start an agent turn on your behalf (the tests panel's "fix this test"
// sparkle). Starting a turn isn't something to discover after the fact, so the
// panel shows the message VERBATIM - what you approve is the exact text that
// goes to the agent, not a description of it. Long messages scroll; a failing
// test's output can be arbitrarily long, and truncating it here would hide the
// part you'd most want to check.
function SendPromptPanel({
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
  // Optional "Spawn agent" alternative - hand the SAME message to a fresh head
  // instead of interrupting the one you're looking at. Deliberately not the
  // primary action: sending to the open agent is the cheap, expected outcome of
  // clicking the sparkle, and spawning a head is the bigger commitment. Omitted
  // when the call site has nothing to spawn into, which hides the button.
  onSecondary?: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-2xl shadow-2xl w-full max-w-[560px] overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-3.5">
        <div className="flex items-start gap-3.5">
          <DialogIconTile tone="indigo">
            <Sparkles className="w-5 h-5" />
          </DialogIconTile>
          <div className="flex flex-col gap-1 min-w-0 pt-0.5">
            <h3 id="dialog-title" className="text-base font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
              {withBranchPills(title)}
            </h3>
            <p className="text-xs leading-snug text-gray-500 dark:text-[#8b94a6]">{withBranchPills(description)}</p>
          </div>
        </div>
        <div>
          {/* mb-1 (replacing the label's default mb-2) pulls the caption down
              onto the panel it names - the default gap reads as a separation
              once what follows is a bordered block. */}
          <DialogSectionLabel className="mb-1">Message</DialogSectionLabel>
          {/* Rendered as markdown, not a mono dump: this is how the message will
              look in the chat once it is sent, so the confirmation should show
              it that way. The output is fenced in the source, so it still lands
              as a code block - the surrounding prose just reads as prose. */}
          <Markdown
            text={details?.prompt ?? ''}
            className="max-h-[45vh] overflow-auto px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-[#232b3a] text-sm text-gray-700 dark:text-[#8b94a6]"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-[#232b3a] bg-gray-50 dark:bg-[#0f141d]">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        {onSecondary && (
          <DialogSecondaryButton tone="indigo" icon={<Bot className="w-4 h-4" />} onClick={onSecondary}>
            {secondaryLabel}
          </DialogSecondaryButton>
        )}
        <DialogConfirmButton tone="indigo" icon={<Sparkles className="w-4 h-4" />} onClick={onConfirm}>
          {confirmLabel}
        </DialogConfirmButton>
      </div>
    </div>
  )
}

// The merge-gate dialog (PLAN #68): shown when the head's tests aren't green and
// the user hits Merge (or the server soft-gate 409s). It explains why merging is
// gated and what the head's verdict is, then offers two outcomes - Force merge now
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
  const blueCls = 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50'
  const amberCls = 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50'
  const redCls = 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50'
  // The gate can be driven by the agent not being finished (agentGate) or by the
  // test verdict (testStatus). agentGate wins - it's the reason the merge button
  // opened this dialog in that case.
  const agentGate = details?.agentGate
  const status = details?.testStatus
  const failed = details?.testFailed ?? 0
  // Blue spinner tone while something is actively in progress (the agent working,
  // or tests running); amber warning otherwise.
  const spinner = agentGate === 'running' || (!agentGate && status === 'running')
  const chip = agentGate
    ? agentGate === 'running'
      ? { cls: blueCls, label: 'still working' }
      : { cls: amberCls, label: 'waiting on you' }
    : status === 'failing'
      ? { cls: redCls, label: `${failed || ''} failing`.trim() }
      : status === 'running'
        ? { cls: blueCls, label: details?.testProgress || 'running' }
        : { cls: amberCls, label: 'no verdict' }
  // Explains what the two buttons do, in this commit's terms.
  const gateHelp = agentGate
    ? 'Force merge now to take the branch as-is - or queue it to merge automatically once the agent finishes and its tests pass.'
    : status === 'failing'
      ? 'You can force the merge now, landing the failing tests on the branch - or queue it to merge automatically once the agent finishes and they pass.'
      : status === 'running'
        ? 'You can force the merge now, but the branch may carry issues the tests would catch - or queue it to merge automatically once the agent finishes and they pass.'
        : 'You can force the merge now without a passing verdict - or queue it to merge automatically once the agent finishes and the tests pass.'
  return (
    <div
      className="bg-white dark:bg-[#141a26] dark:border dark:border-[#252d3b] rounded-2xl shadow-2xl w-full max-w-[470px] overflow-hidden animate-in zoom-in-95 duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-4">
        <div className="flex items-start gap-3.5">
          {/* Blue spinner while work is in progress (agent or tests); amber warning otherwise. */}
          <DialogIconTile tone={spinner ? 'blue' : 'amber'}>
            {spinner ? <LoaderCircle className="w-5 h-5 animate-spin" /> : <TriangleAlert className="w-5 h-5" />}
          </DialogIconTile>
          <div className="flex flex-col gap-1 min-w-0 pt-0.5">
            <h3 id="dialog-title" className="text-base font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
              {withBranchPills(title)}
            </h3>
            <p className="text-xs leading-snug text-gray-500 dark:text-[#8b94a6]">{withBranchPills(description)}</p>
          </div>
        </div>
        <BranchChip
          from={details?.fromBranch || '-'}
          to={details?.toBranch || '-'}
          arrowClass="text-amber-600 dark:text-amber-400"
          right={
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium ${chip.cls}`}>
              {spinner && <LoaderCircle className="w-3 h-3 animate-spin" />}
              {chip.label}
            </span>
          }
        />
        <p className="text-2xs leading-snug text-gray-400 dark:text-gray-500">{gateHelp}</p>
      </div>
      <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-gray-100 dark:border-[#232b3a] bg-gray-50 dark:bg-[#0f141d]">
        <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
        <DialogConfirmButton tone="amber" icon={<GitPullRequestArrow className="w-4 h-4" />} onClick={onSecondary}>
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
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
      <span>{withBranchPills(note)}</span>
    </div>
  )
}

// The `from → to` branch chip shared by the merge / update-from-base panels.
// Only `from` truncates (the agent branch is long); `to` is the base branch -
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
  const from = details?.fromBranch || '-'
  const to = details?.toBranch || '-'
  const loading = details?.loading ?? false
  return (
    <>
      <BranchChip
        from={from}
        to={to}
        right={
          loading ? (
            <span className="text-gray-400 dark:text-gray-500">...</span>
          ) : (
            <ChangeStats additions={details?.additions} deletions={details?.deletions} />
          )
        }
      />
      {details?.note && <CautionNote note={details.note} />}
    </>
  )
}

// The update-from-base confirmation. Unlike the merge/kill panels (icon tile +
// subtitle + chip), this one keeps a bordered header (icon tile + title + close)
// over a prose body that embeds the branch names as inline pills, with a blue
// Confirm - matching the agreed redesign. The base is merged *into* the agent's
// branch, so the branch is named first and the base second.
function UpdateBasePanel({
  title,
  confirmLabel,
  secondaryLabel,
  details,
  onConfirm,
  onSecondary,
  onCancel,
}: {
  title: string
  confirmLabel: string
  secondaryLabel?: string
  details?: DialogDetails
  onConfirm: () => void
  // Optional "Fix with agent" action - hands the update off to the agent session
  // (like the merge-conflict dialog) instead of merging on the server. Rendered
  // as a secondary button; the primary Confirm stays a plain update-from-base.
  onSecondary?: () => void
  onCancel: () => void
}) {
  const base = details?.fromBranch || '-'
  const branch = details?.toBranch || '-'
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
        {/* .optical-center - see the plain dialog header above. */}
        <h3 id="dialog-title" className="optical-center flex-1 text-lg font-bold leading-tight text-gray-900 dark:text-[#eef1f6]">
          {withBranchPills(title)}
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
        {onSecondary && (
          <DialogConfirmButton tone="indigo" icon={<Bot className="w-4 h-4" />} onClick={onSecondary}>
            {secondaryLabel ?? 'Fix with agent'}
          </DialogConfirmButton>
        )}
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
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          <span>
            {lost} unmerged file{lost !== 1 ? 's' : ''} in this worktree will be lost.
          </span>
        </div>
      )}
      {details?.note && <CautionNote note={details.note} />}
    </>
  )
}
