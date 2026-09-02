import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GitPullRequest, ExternalLink, Lock, ArrowUp, ArrowDown } from 'lucide-react'
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
import { DialogIconTile } from './dialogPrimitives'
import { providerLabel } from '../lib/forgeDisplay'

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
  noun,
  readOnly,
  onPush,
  onPull,
  disabled,
}: {
  ahead?: number
  behind?: number
  noun: 'PR' | 'MR'
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
      <Tooltip content={`In sync: this branch and the ${noun} branch have the same commits`}>
        <Badge tone="faint">in sync</Badge>
      </Tooltip>
    )
  }
  return (
    <>
      {down > 0 && (
        <Tooltip content={`Pull ${down} commit${down === 1 ? '' : 's'} from the ${noun} branch (merged into this head)`}>
          <SyncChipButton onClick={onPull} disabled={disabled} label={`Pull ${down} from the ${noun} branch`}>
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
              ? `${up} commit${up === 1 ? '' : 's'} not on the ${noun} branch - this PR is read-only, so they cannot be pushed`
              : `Push ${up} commit${up === 1 ? '' : 's'} to the ${noun} branch`
          }
        >
          <SyncChipButton onClick={readOnly ? undefined : onPush} disabled={disabled} label={`Push ${up} to the ${noun} branch`}>
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

// ReviewTooltipContent keeps passive review metadata behind the existing review
// button instead of expanding each fact into another chip in the metadata row.
// The branch remains selectable for the common copy/fetch use case.
export function ReviewTooltipContent({ agent, actionLabel }: { agent: AgentResponse; actionLabel?: string }) {
  const review = agent.review
  if (!review) return null
  const st = review.state
  const noun = review.provider === 'github' ? 'PR' : 'MR'
  const rows: Array<{ label: string; value: ReactNode }> = []
  if (st?.state) rows.push({ label: 'State', value: st.state })
  if (agent.downstream_branch) {
    rows.push({
      label: `${noun} branch`,
      value: <span className="font-mono select-text break-all">{agent.downstream_branch}</span>,
    })
  }
  if (review.target_branch) {
    rows.push({
      label: 'Target',
      value: <span className="font-mono select-text break-all">{review.target_branch}</span>,
    })
  }
  if (st?.ci_status && st.ci_status !== 'none') rows.push({ label: 'CI', value: st.ci_status })
  if (st?.approvals_required != null && st.approvals_required > 0) {
    rows.push({ label: 'Approvals', value: `${st.approvals ?? 0}/${st.approvals_required}` })
  }
  if (st?.unresolved_discussions != null) {
    rows.push({
      label: 'Discussions',
      value: `${st.unresolved_discussions} unresolved`,
    })
  }
  if (review.adopted) {
    rows.push({ label: 'Access', value: review.can_push === false ? 'Adopted, read-only' : 'Adopted' })
  }
  return (
    <div className="min-w-48 text-left">
      <div className="font-semibold mb-1.5">{providerLabel(review.provider)} {noun} #{review.id}</div>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-gray-400 dark:text-gray-500">{row.label}</span>
            <span>{row.value}</span>
          </div>
        ))}
      </div>
      {actionLabel && <div className="mt-2 text-gray-400 dark:text-gray-500">{actionLabel}</div>}
    </div>
  )
}

// MRStateChip renders one review-identity pill plus actionable ahead/behind
// sync chips. Passive state, branch, CI, approval and discussion details live in
// the review pill's hover card so the metadata row stays scannable.
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
  const noun = review.provider === 'github' ? 'PR' : 'MR'
  // The chip names the review ("PR 41" / "MR 41") - the state is carried
  // by the tone color and spelled out in the tooltip.
  const label = review.id != null ? `${noun} ${review.id}` : noun
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={<ReviewTooltipContent agent={agent} actionLabel={`Click to open on ${providerLabel(review.provider)}`} />} align="left">
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
        noun={noun}
        readOnly={review.adopted === true && review.can_push === false}
        onPush={onPush}
        onPull={onPull}
        disabled={busy}
      />
    </span>
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
