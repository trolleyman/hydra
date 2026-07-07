import { useEffect, useRef, useState } from 'react'
import { GitPullRequest, GitMerge, CircleCheck, CircleX, LoaderCircle, MessageSquare, ExternalLink, Github, GitlabIcon } from 'lucide-react'
import type { AgentResponse } from '../api/models/AgentResponse'
import type { ReviewConfigResponse } from '../api/models/ReviewConfigResponse'
import { Badge } from './Badge'
import { DialogCancelButton, DialogConfirmButton, DialogSectionLabel } from './dialogPrimitives'

// providerIcon returns the small forge glyph for a provider name.
export function ProviderIcon({ provider, className }: { provider?: string; className?: string }) {
  if (provider === 'github') return <Github className={className} />
  if (provider === 'gitlab') return <GitlabIcon className={className} />
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
    <Badge tone={m.tone} icon={m.icon} title={`CI: ${status}`}>
      {m.label}
    </Badge>
  )
}

// MRStateChip renders the metadata-row summary of a head's linked MR: a state
// pill (draft/open/merged), CI status, approvals, and unresolved-discussion
// count. Clicking the state pill opens the forge MR. Shown only for a linked head.
export function MRStateChip({ agent }: { agent: AgentResponse }) {
  const review = agent.review
  if (!review) return null
  const st = review.state
  const stateLabel = st?.state ?? 'MR'
  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={review.url}
        target="_blank"
        rel="noreferrer"
        title={`Open ${review.provider} MR #${review.id}`}
        className="no-underline"
      >
        <Badge tone={mrStateTone(st?.state)} icon={<ProviderIcon provider={review.provider} className="w-3 h-3" />}>
          {stateLabel}
          <ExternalLink className="w-2.5 h-2.5 ml-0.5 opacity-60" />
        </Badge>
      </a>
      <CIChip status={st?.ci_status} />
      {st && st.approvals_required != null && st.approvals_required > 0 && (
        <Badge
          tone={(st.approvals ?? 0) >= st.approvals_required ? 'green' : 'neutral'}
          icon={<CircleCheck className="w-3 h-3" />}
          title="Approvals"
        >
          {st.approvals ?? 0}/{st.approvals_required}
        </Badge>
      )}
      {st && (st.unresolved_discussions ?? 0) > 0 && (
        <Badge tone="yellow" icon={<MessageSquare className="w-3 h-3" />} title="Unresolved discussions">
          {st.unresolved_discussions}
        </Badge>
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
        <span className="font-sans text-gray-400 dark:text-gray-500">push as</span>
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
      <span className="font-sans text-gray-400 dark:text-gray-500">push as</span>
      <button
        type="button"
        disabled={linked || saving}
        onClick={() => {
          if (linked) return
          setDraft(value)
          setEditing(true)
        }}
        title={linked ? 'Locked: renaming would orphan the open MR' : 'Edit downstream branch name'}
        className={`px-1.5 py-0.5 rounded ${linked ? 'cursor-default' : 'hover:bg-gray-100 dark:hover:bg-gray-800 cursor-text'}`}
      >
        {value}
      </button>
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
}: {
  agent: AgentResponse
  config: ReviewConfigResponse | null
  remotes: string[]
  onConfirm: (body: { downstream_branch: string; remote: string; target_branch: string; title: string; description: string; draft: boolean }) => void
  onCancel: () => void
  submitting?: boolean
}) {
  const [branch, setBranch] = useState(agent.downstream_branch || config?.push_branch_template?.replace('{id}', agent.id).replace(/\{[a-z]+\}/g, '') || agent.id)
  const [remote, setRemote] = useState(config?.remote || 'origin')
  const [target, setTarget] = useState(config?.target_branch || agent.base_branch || 'main')
  const [title, setTitle] = useState(agent.title || agent.id)
  const [description, setDescription] = useState(agent.prompt || '')
  const [draft, setDraft] = useState(config?.draft ?? true)

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
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <ProviderIcon provider={config?.provider} className="w-5 h-5" />
          <h2 className="text-base font-semibold">Create {providerLabel}</h2>
        </div>
        <div className="px-5 py-4 overflow-auto flex flex-col gap-3">
          {config && !config.authenticated && config.auth === 'cli' && (
            <div className="text-xs rounded-md px-3 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
              {config.auth_status || 'The forge CLI is not authenticated. Run `gh auth login` / `glab auth login` on the host.'}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <DialogSectionLabel>Downstream branch</DialogSectionLabel>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} className={`${inputClass} font-mono`} />
            <span className="text-[11px] text-gray-400">The local branch stays {agent.branch_name}; this is the name it is pushed as.</span>
          </label>
          <div className="flex gap-3">
            {remotes.length > 1 && (
              <label className="flex flex-col gap-1 w-32">
                <DialogSectionLabel>Remote</DialogSectionLabel>
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
              <DialogSectionLabel>Target branch</DialogSectionLabel>
              <input value={target} onChange={(e) => setTarget(e.target.value)} className={`${inputClass} font-mono`} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <DialogSectionLabel>Title</DialogSectionLabel>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <DialogSectionLabel>Description</DialogSectionLabel>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputClass} resize-y`} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Open as draft
          </label>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <DialogCancelButton onClick={onCancel}>Cancel</DialogCancelButton>
          <DialogConfirmButton
            tone="emerald"
            onClick={() => onConfirm({ downstream_branch: branch.trim(), remote, target_branch: target.trim(), title: title.trim(), description, draft })}
            disabled={submitting || !branch.trim() || !target.trim()}
          >
            {submitting ? 'Publishing...' : `Create ${providerLabel}`}
          </DialogConfirmButton>
        </div>
      </div>
    </div>
  )
}

// mrIcon returns the icon for the publish/view-MR action button.
export function MRIcon({ linked, className }: { linked: boolean; className?: string }) {
  return linked ? <GitMerge className={className} /> : <GitPullRequest className={className} />
}
