import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GitPullRequest, CircleCheck, CircleX, LoaderCircle, MessageSquare, ExternalLink, Lock, ArrowUp, ArrowDown } from 'lucide-react'
// lucide-react dropped brand glyphs in v1, so the forge icons come from
// simple-icons instead (@icons-pack/react-simple-icons).
import { SiGithub, SiGitlab } from '@icons-pack/react-simple-icons'
import type { AgentResponse } from '../api/models/AgentResponse'
import type { ReviewConfigResponse } from '../api/models/ReviewConfigResponse'
import { Badge } from './Badge'
import { Tooltip } from './Tooltip'
import { DialogCancelButton, DialogConfirmButton } from './dialogPrimitives'
import { HighlightedTextarea } from './HighlightedTextarea'
import { ResizeHandle } from '../lib/ResizeHandle'
import { CopyStateIcon } from './CopyStateIcon'
import { useCopyFlash } from '../lib/useCopyFlash'
import { copyWithToast } from '../lib/copyToast'
import { DialogIconTile } from './dialogPrimitives'

// FieldLabel is the Create MR dialog's field caption: sentence case (like the
// DialogSectionLabel) and tight to the input below it.
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{children}</span>
}

// providerIcon returns the small forge glyph for a provider name.
// title="" suppresses the default SVG <title> the simple-icons marks render
// ("GitHub"/"GitLab") - that <title> is a native OS tooltip in its own right, so
// it double-tipped against the styled <Tooltip> these icons sit inside (and the
// icon is decorative anyway; the surrounding link/badge carries the real name).
export function ProviderIcon({ provider, className }: { provider?: string; className?: string }) {
  if (provider === 'github') return <SiGithub className={className} title="" aria-hidden />
  if (provider === 'gitlab') return <SiGitlab className={className} title="" aria-hidden />
  return <GitPullRequest className={className} />
}

// mrStateTone maps a normalized MR state to a Badge tone.
function mrStateTone(state?: string): 'green' | 'yellow' | 'violet' | 'neutral' {
  switch (state) {
    case 'merged':
      return 'violet'
    case 'open':
      return 'green'
    case 'draft':
      return 'yellow'
    default:
      return 'neutral'
  }
}

// CIChip renders the MR's CI status as a small coloured chip. Absent/none renders
// nothing (no pipeline to report).
function CIChip({ status }: { status?: string }) {
  if (!status || status === 'none') return null
  const map: Record<string, { tone: 'green' | 'red' | 'yellow' | 'neutral'; icon: React.ReactNode; label: string }> = {
    success: { tone: 'green', icon: <CircleCheck className="w-3 h-3" />, label: 'CI' },
    failed: { tone: 'red', icon: <CircleX className="w-3 h-3" />, label: 'CI' },
    running: { tone: 'yellow', icon: <LoaderCircle className="w-3 h-3 animate-spin" />, label: 'CI' },
    pending: { tone: 'neutral', icon: <LoaderCircle className="w-3 h-3" />, label: 'CI' },
  }
  const m = map[status] ?? map.pending
  return (
    <Tooltip content={`CI: ${status}`}>
      <Badge tone={m.tone} icon={m.icon}>
        {m.label}
      </Badge>
    </Tooltip>
  )
}

// MRSyncChip is the ahead/behind indicator for a linked head, modelled on the
// sidebar's repository sync row: down-arrow + count when the MR branch has
// commits this head lacks, up-arrow + count when this head has commits the MR
// does not, and a quiet "in sync" when neither. It exists because a commit made
// after the MR opened used to be visible only as a line inside the View MR
// dropdown - so the commit just sat there.
//
// Each direction is its own chip rather than one combined Sync button: unlike the
// sidebar's pull-then-push, Push to MR and Pull from MR are separate operations
// with different consequences (the pull is a merge that can conflict), so one
// click must never mean both.
function MRSyncChip({
  ahead,
  behind,
  readOnly,
  onPush,
  onPull,
  disabled,
}: {
  ahead?: number
  behind?: number
  readOnly?: boolean
  onPush?: () => void
  onPull?: () => void
  disabled?: boolean
}) {
  // Both absent means the backend could not measure it (no downstream ref yet) -
  // say nothing rather than claim "in sync", which would be a guess.
  if (ahead == null && behind == null) return null
  const up = ahead ?? 0
  const down = behind ?? 0

  if (up === 0 && down === 0) {
    return (
      <Tooltip content="In sync: this branch and the MR branch have the same commits">
        <Badge tone="faint">in sync</Badge>
      </Tooltip>
    )
  }
  return (
    <>
      {down > 0 && (
        <Tooltip content={`Pull ${down} commit${down === 1 ? '' : 's'} from the MR branch (merged into this head)`}>
          <SyncChipButton onClick={onPull} disabled={disabled} label={`Pull ${down} from the MR branch`}>
            <Badge tone="yellow" icon={<ArrowDown className="w-3 h-3" />}>
              {down}
            </Badge>
          </SyncChipButton>
        </Tooltip>
      )}
      {up > 0 && (
        <Tooltip
          content={
            readOnly
              ? `${up} commit${up === 1 ? '' : 's'} not on the MR branch - this PR is read-only, so they cannot be pushed`
              : `Push ${up} commit${up === 1 ? '' : 's'} to the MR branch`
          }
        >
          <SyncChipButton onClick={readOnly ? undefined : onPush} disabled={disabled} label={`Push ${up} to the MR branch`}>
            <Badge tone={readOnly ? 'muted' : 'blue'} icon={<ArrowUp className="w-3 h-3" />}>
              {up}
            </Badge>
          </SyncChipButton>
        </Tooltip>
      )}
    </>
  )
}

// SyncChipButton makes a sync chip clickable when there is something to click,
// and leaves it as plain markup when there is not. A real <button> rather than an
// onClick span so it is keyboard-reachable and announces itself; the accessible
// name spells the action out, since the chip's own text is just a number.
function SyncChipButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick?: () => void
  disabled?: boolean
  label: string
  children: ReactNode
}) {
  if (!onClick) return <>{children}</>
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  )
}

// MRStateChip renders the metadata-row summary of a head's linked MR: a state
// pill (draft/open/merged), CI status, approvals, unresolved-discussion count
// and how far ahead/behind the MR branch it is. Clicking the state pill opens the
// forge MR; clicking an ahead/behind chip pushes/pulls. Shown only for a linked head.
export function MRStateChip({
  agent,
  onPush,
  onPull,
  busy,
}: {
  agent: AgentResponse
  onPush?: () => void
  onPull?: () => void
  busy?: boolean
}) {
  const review = agent.review
  if (!review) return null
  const st = review.state
  // The chip names the MR ("MR 41") - the state (open/draft/merged) is carried
  // by the tone color and spelled out in the tooltip.
  const label = review.id != null ? `MR ${review.id}` : 'MR'
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={`Open ${review.provider} MR #${review.id}${st?.state ? ` (${st.state})` : ''}`}>
        <a
          href={review.url}
          target="_blank"
          rel="noreferrer"
          className="no-underline"
        >
          <Badge tone={mrStateTone(st?.state)} icon={<ProviderIcon provider={review.provider} className="w-3 h-3" />}>
            {label}
            <ExternalLink className="w-2.5 h-2.5 ml-0.5 opacity-60" />
          </Badge>
        </a>
      </Tooltip>
      {review.adopted && (
        <Tooltip
          content={review.can_push === false
            ? 'Adopted PR - read-only (the author has not enabled maintainer edits, so changes cannot be pushed)'
            : 'Adopted PR - this head is working on an existing PR Hydra did not create'}
        >
          <Badge
            tone={review.can_push === false ? 'yellow' : 'neutral'}
            icon={review.can_push === false ? <Lock className="w-3 h-3" /> : undefined}
          >
            {review.can_push === false ? 'Adopted (read-only)' : 'Adopted'}
          </Badge>
        </Tooltip>
      )}
      <MRSyncChip
        ahead={review.ahead}
        behind={review.behind}
        readOnly={review.adopted === true && review.can_push === false}
        onPush={onPush}
        onPull={onPull}
        disabled={busy}
      />
      <CIChip status={st?.ci_status} />
      {st && st.approvals_required != null && st.approvals_required > 0 && (
        <Tooltip content="Approvals">
          <Badge
            tone={(st.approvals ?? 0) >= st.approvals_required ? 'green' : 'neutral'}
            icon={<CircleCheck className="w-3 h-3" />}
          >
            {st.approvals ?? 0}/{st.approvals_required}
          </Badge>
        </Tooltip>
      )}
      {st && (st.unresolved_discussions ?? 0) > 0 && (
        <Tooltip content="Unresolved discussions">
          <Badge tone="yellow" icon={<MessageSquare className="w-3 h-3" />}>
            {st.unresolved_discussions}
          </Badge>
        </Tooltip>
      )}
    </span>
  )
}

// DownstreamBranchEditor is an inline editor for a head's downstream branch name
// (the name its work is pushed AS). Mirrors the base-branch editor. Soft-locked
// after first publish (the backend rejects a rename of a linked head), so it is
// read-only once linked.
export function DownstreamBranchEditor({
  agent,
  onSave,
  saving,
}: {
  agent: AgentResponse
  onSave: (next: string) => void
  saving?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(agent.downstream_branch ?? '')
  const linked = !!agent.review
  const value = agent.downstream_branch || ''
  if (!value && !editing) return null

  if (editing && !linked) {
    return (
      <span className="text-xs font-mono flex items-center gap-1.5">
        <span className="font-sans text-gray-400 dark:text-gray-500">MR branch</span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditing(false)
              if (draft.trim() && draft.trim() !== value) onSave(draft.trim())
            } else if (e.key === 'Escape') {
              setEditing(false)
              setDraft(value)
            }
          }}
          onBlur={() => {
            setEditing(false)
            if (draft.trim() && draft.trim() !== value) onSave(draft.trim())
          }}
          className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-mono text-xs w-40"
        />
      </span>
    )
  }

  return (
    <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
      <span className="font-sans text-gray-400 dark:text-gray-500">MR branch</span>
      {/* select-text on both spellings: the name is something you want to grab
          (a `git fetch` needs it), and a <button> is not selectable by default.
          A locked (linked) MR renders it as a plain span rather than a disabled
          button - a disabled button can't be selected from at all. */}
      {linked ? (
        <Tooltip content="Locked: renaming would orphan the open MR">
          <span className="px-1.5 py-0.5 select-text cursor-text">{value}</span>
        </Tooltip>
      ) : (
        <Tooltip content="Edit downstream branch name">
          <button
            type="button"
            disabled={saving}
            onClick={() => { setDraft(value); setEditing(true) }}
            className="px-1.5 py-0.5 rounded select-text hover:bg-gray-100 dark:hover:bg-gray-800 cursor-text"
          >
            {value}
          </button>
        </Tooltip>
      )}
      <CopyBranchButton branch={value} what="MR branch name" />
    </span>
  )
}

// CopyBranchButton is the small copy affordance beside a branch name: it flashes
// a tick/X on the icon and raises the shared copy toast (title + the name in a
// code block), like every other copy in the app.
function CopyBranchButton({ branch, what }: { branch: string; what: string }) {
  const { state, flash } = useCopyFlash(1200)
  return (
    <Tooltip
      content={
        <>
          <div>Copy {what}</div>
          <div className="text-gray-500 dark:text-gray-400">{branch}</div>
        </>
      }
    >
      <button
        type="button"
        aria-label={`Copy ${what}`}
        className="cursor-pointer shrink-0 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 transition-colors"
        onClick={() => { void copyWithToast(branch, { what }).then(flash) }}
      >
        <CopyStateIcon state={state} size="w-3 h-3" />
      </button>
    </Tooltip>
  )
}

// CreateMRDialog is the Create MR form: a modal prefilled from the resolved
// [review] config + the head, letting the user tweak the downstream branch,
// remote, target, title/description and draft toggle before publishing.
export function CreateMRDialog({
  agent,
  config,
  remotes,
  onConfirm,
  onCancel,
  submitting,
  error,
}: {
  agent: AgentResponse
  config: ReviewConfigResponse | null
  remotes: string[]
  onConfirm: (body: { downstream_branch: string; remote: string; target_branch: string; title: string; description: string; draft: boolean }) => void
  onCancel: () => void
  submitting?: boolean
  // A publish failure to surface inline (the dialog stays open so the user can
  // fix and retry) instead of a toast.
  error?: string | null
}) {
  const graphite = config?.publisher === 'graphite'
  const [branch, setBranch] = useState(graphite ? agent.branch_name || agent.id : agent.downstream_branch || config?.push_branch_template?.replace('{id}', agent.id).replace(/\{[a-z]+\}/g, '') || agent.id)
  const [remote, setRemote] = useState(config?.remote || 'origin')
  // The MR targets the head's base branch (where its work merges back); editable
  // here as a per-publish override. There is no configurable [review] target.
  const [target, setTarget] = useState(agent.base_branch || 'main')
  const [title, setTitle] = useState(agent.title || agent.id)
  const [description, setDescription] = useState(agent.prompt || '')
  const [draft, setDraft] = useState(config?.draft ?? true)
  const descBoxRef = useRef<HTMLDivElement>(null)

  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const providerLabel = config?.provider === 'gitlab' ? 'merge request' : config?.provider === 'github' ? 'pull request' : 'MR'
  const inputClass = 'w-full px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm'

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[90vh]">
        {/* The tile, like every other rich dialog header - this was the one
            that hung a bare glyph off the heading. Blue to match the Create MR
            button that opens it; `.optical-center` because the heading is being
            centred against the tile (see CLAUDE.md). */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <DialogIconTile tone="blue" size="sm">
            <ProviderIcon provider={config?.provider} className="w-[18px] h-[18px]" />
          </DialogIconTile>
          <h2 className="optical-center text-base font-semibold">Create {providerLabel}</h2>
        </div>
        <div className="px-5 py-4 overflow-auto flex flex-col gap-3">
          {/* Only an explicit false warns: the auth check runs in the background
              server-side, so a config without the field just means "still
              checking" and stays quiet. */}
          {config && config.authenticated === false && config.auth === 'cli' && (
            <div className="text-xs rounded-md px-3 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
              {config.auth_status || 'The forge CLI is not authenticated. Run `gh auth login` / `glab auth login` on the host.'}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <FieldLabel>Downstream branch</FieldLabel>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={graphite} className={`${inputClass} font-mono disabled:opacity-60`} />
            <span className="text-2xs text-gray-400">{graphite ? 'Graphite tracks the local branch as the PR source.' : `The local branch stays ${agent.branch_name}; this is the name it is pushed as.`}</span>
          </label>
          <div className="flex gap-3">
            {remotes.length > 1 && (
              <label className="flex flex-col gap-1 w-32">
                <FieldLabel>Remote</FieldLabel>
                <select value={remote} onChange={(e) => setRemote(e.target.value)} className={inputClass}>
                  {remotes.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1 flex-1">
              <FieldLabel>Target branch</FieldLabel>
              <input value={target} onChange={(e) => setTarget(e.target.value)} disabled={graphite} className={`${inputClass} font-mono disabled:opacity-60`} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <FieldLabel>Title</FieldLabel>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>
          <div className="flex flex-col gap-1">
            <FieldLabel>Description</FieldLabel>
            {/* Resizable, markdown-highlighted like the spawn box: a grab bar
                below the box adjusts its height, HighlightedTextarea tints the
                markdown source as it is typed. */}
            <div
              ref={descBoxRef}
              style={{ height: 140 }}
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 overflow-hidden"
            >
              <HighlightedTextarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                wrapperClassName="h-full"
                textClassName="px-2.5 py-1.5 text-sm leading-5"
                placeholder="Describe the change - markdown supported"
              />
            </div>
            <ResizeHandle targetRef={descBoxRef} minHeight={80} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Open as draft
          </label>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2.5">
          {error && (
            <div className="text-xs rounded-md px-3 py-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
            {/* Blue, not emerald: this dialog IS the Create MR button, which is
                blue in the top bar - and its own header tile is blue for the same
                reason. Emerald is the merge identity (the Merge button, the merge
                dialog, the merged toast), so a green confirm here read as if it
                were about to merge something. */}
            <DialogConfirmButton
              tone="blue"
              onClick={() => onConfirm({ downstream_branch: branch.trim(), remote, target_branch: target.trim(), title: title.trim(), description, draft })}
              disabled={submitting || !branch.trim() || !target.trim()}
            >
              {submitting ? 'Publishing...' : `Create ${providerLabel}`}
            </DialogConfirmButton>
          </div>
        </div>
      </div>
    </div>
  )
}
