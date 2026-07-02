import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../stores/apiClient'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatError, apiErrorBody } from '../api/format_error'
import { runWithToast } from '../lib/apiAction'
import type { AgentResponse, RepositoryBranch } from '../api'
import { AgentTerminal } from './AgentTerminal'
import { BranchSelector } from './BranchSelector'
import { SeparatedRow } from './SeparatedRow'
import { AgentTopBar, type AgentTopBarAction, type AgentTopBarMenuItem } from './AgentTopBar'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { uploadBlobUrl } from '../api/uploads'
import type { Attachment } from '../lib/spawnDrafts'
import { DiffViewer } from '../DiffViewer'
import { formatStartedAgo, agentStatusBadge, archivedEndStateBadge, agentDotClass, agentDotAnimate, agentTypePill } from '../lib/agentDisplay'
import { LoaderCircle, Merge, Trash2, Tag, RotateCcw, Pencil, TerminalSquare, Mail, ShieldAlert, ShieldCheck, ShieldOff, AlertTriangle, Clock } from 'lucide-react'
import { TestVerdictChip } from './TestVerdict'
import { Tooltip } from './Tooltip'
import { Badge } from './Badge'
import { AgentTypeIcon, type AgentTypeIconName } from './AgentTypeIcon'
import { renderMarkdown } from '../lib/markdown'

import { useDialogStore, type DialogDetails } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { useAgentStore } from '../stores/agentStore'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { hasMod, isTypingTarget, SHORTCUT_MERGE, SHORTCUT_MARK_UNREAD, SHORTCUT_KILL, SHORTCUT_RENAME } from '../lib/shortcuts'

// Matches an upload path the spawn form embeds in a prompt: any token containing
// the uploads dir followed by the on-disk filename (sanitized to [A-Za-z0-9._-]
// by uniqueUploadName, so the run stops cleanly at trailing punctuation).
const UPLOAD_PATH_RE = /\S*\.hydra\/local\/uploads\/[A-Za-z0-9._-]+/g
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i

// Splits a submitted prompt into its display text and the upload attachments it
// references. The paths (appended by the spawn form, usually as trailing lines)
// are lifted out and shown as chips instead of raw links; the leftover text is
// tidied so removing them doesn't leave dangling blank lines.
function parsePrompt(prompt: string, projectId: string | null): { text: string; attachments: Attachment[] } {
  const seen = new Set<string>()
  const attachments: Attachment[] = []
  let id = 0
  for (const m of prompt.matchAll(UPLOAD_PATH_RE)) {
    const full = m[0]
    if (seen.has(full)) continue
    seen.add(full)
    const base = full.split('/').pop() ?? full
    attachments.push({
      id: id++,
      // Drop the "<unixnano>-" prefix uniqueUploadName adds, for a tidy label.
      filename: base.replace(/^\d+-/, ''),
      path: full,
      previewUrl: IMAGE_EXT_RE.test(base) ? uploadBlobUrl(projectId, base) : undefined,
      size: 0,
      uploading: false,
    })
  }
  const text = prompt
    .replace(UPLOAD_PATH_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, attachments }
}

function PromptBlock({ prompt, projectId }: { prompt: string; projectId: string | null }) {
  // A box that scrolls when the prompt is tall; short prompts show no scrollbar
  // since the content fits under the max-height. The negative top margin tucks
  // it a little closer to the metadata above, and the bottom gradient softens
  // the cutoff as a long prompt scrolls out of view.
  const { text, attachments } = useMemo(() => parsePrompt(prompt, projectId), [prompt, projectId])
  // Index into the image-only attachments while the lightbox is open; clicking a
  // thumbnail opens it here, mirroring the spawn form.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  return (
    <div className="relative -mt-2 mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      {/* A taller max-height means most prompts (incl. a code block or two)
          don't need to scroll at all. */}
      <div className="overflow-y-auto max-h-96">
        {text && <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{renderMarkdown(text)}</p>}
        <AttachmentChips
          attachments={attachments}
          size="md"
          className={text ? 'pt-3' : ''}
          onOpenImage={(id) => setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-lg bg-gradient-to-t from-gray-50 dark:from-gray-800 to-transparent" />
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          index={Math.min(lightboxIndex, lightboxImages.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  )
}

// ArchivedAgentDetail is the read-only view for a finished (killed/merged) agent
// retained in the history. There is no live session, so there is no terminal
// (just a grayed placeholder) and no diff/kill/merge/restart actions. The
// "Resume" affordance is shown but not yet wired — see PLAN #49.
function ArchivedAgentDetail({ agent, projectId, onPurged }: { agent: AgentResponse; projectId: string | null; onPurged: (id: string) => void }) {
  const [purging, setPurging] = useState(false)
  const endBadge = archivedEndStateBadge(agent.end_state)

  function handlePurge() {
    useDialogStore.getState().show({
      title: 'Delete agent permanently',
      message:
        `Permanently delete "${agent.title || agent.id}"? This erases its record from the ` +
        `history list and deletes its Claude session history. This cannot be undone.`,
      type: 'warning',
      showCancel: true,
      onConfirm: async () => {
        setPurging(true)
        try {
          await api.default.purgeAgent(projectId ?? '', agent.id)
          // Drop it from the history list and navigate off the now-dead URL.
          useAgentStore.getState().removeArchived(agent.id)
          onPurged(agent.id)
        } catch (e) {
          useDialogStore.getState().show({
            title: 'Delete Failed',
            message: formatError(e),
            type: 'error',
          })
        } finally {
          setPurging(false)
        }
      },
    })
  }
  const agentTypeClass = agentTypePill(agent.agent_type)

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* The agent header is a single header bar (no separate H1): the archived
          agent's name + a delete action, and a dim status dot. While the sidebar
          is collapsed it also hosts the show-sidebar toggle. It sits above the
          scroll area. */}
      <AgentTopBar
        title={agent.title || agent.id}
        statusDot={<span className="block w-2.5 h-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />}
        actions={[
          { label: 'Delete permanently', icon: <Trash2 className="w-4 h-4" />, onClick: handlePurge, danger: true, disabled: purging },
        ]}
      />
      <div className="flex-1 flex flex-col overflow-auto p-3 sm:p-6 min-w-0 min-h-0" data-main-scroll>
        <div className="w-full">
        {/* Header */}
        <div className="mb-6">
          {/* Metadata row */}
          <SeparatedRow className="flex items-center gap-3 flex-wrap">
            <Badge
              variant="pill"
              className={agentTypeClass}
              icon={<AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />}
            >
              {agent.agent_type}
            </Badge>
            <Badge className={endBadge.className}>{endBadge.label}</Badge>
            {agent.branch_name && (
              <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                {agent.branch_name}
              </span>
            )}
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                created {formatStartedAgo(agent.created_at)}
              </span>
            )}
          </SeparatedRow>
        </div>

        {/* Prompt */}
        {agent.prompt && <PromptBlock prompt={agent.prompt} projectId={projectId} />}

        {/* Grayed-out terminal placeholder with a (not-yet-wired) Resume button. */}
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-8 flex flex-col items-center justify-center text-center gap-3">
          <TerminalSquare className="w-8 h-8 text-gray-300 dark:text-gray-600" />
          <div className="text-sm text-gray-500 dark:text-gray-400">
            This agent was {endBadge.label}. Its session, worktree and branch were removed,
            so there is no live terminal or diff to show.
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Tooltip content="Resuming archived agents isn't available yet (see PLAN #49)">
              <button
                disabled
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-400 dark:border-gray-600 dark:text-gray-500 cursor-not-allowed"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Resume agent
              </button>
            </Tooltip>
            <Tooltip content="Permanently delete this agent and its Claude session history">
              <button
                onClick={handlePurge}
                disabled={purging}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {purging ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete permanently
              </button>
            </Tooltip>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

// NetworkEnforcementBadge shows a live head's egress posture (AUDIT.md rec 3):
// the green "locked" hard boundary, the amber advisory (proxy-respecting) fallback,
// "no network", and the open "unrestricted" state (so an open egress channel is
// always visible, not silently hidden). Hidden only when the head isn't live
// (mode absent).
// mergeQueueWaitingOn describes what an armed (merge-when-green) head's queued
// merge is currently blocked on, for the pill's tooltip. Reaching a finished
// state is the dominant gate — the head can't merge mid-work — so any not-yet-
// finished agent (still running, or blocked asking you something) reads simply as
// "the agent to finish"; once it's finished, the test verdict is the remaining gate.
function mergeQueueWaitingOn(agent: AgentResponse): string {
  const st = agent.agent_status?.status
  if (st && st !== 'finished') return 'the agent to finish'
  const verdict = agent.tests?.status
  if (verdict === 'running') return 'the tests to finish'
  if (verdict === 'failing' || verdict === 'errored') return 'the tests to pass'
  return 'the final checks'
}

// MergeWhenGreenPill is the merge button's "armed" state (PLAN #68): a green
// "Merge queued" pill carrying its own white Cancel button to disarm. It replaces
// the plain Merge button while armed, so the state and the way out are both
// visible at a glance; a hover hint says what the queue does and what it's
// currently waiting on. The hint opens below (the pill sits in the top bar) with
// extra offset so it clears the Cancel button beside it.
function MergeWhenGreenPill({ agent, onCancel, disabled }: { agent: AgentResponse; onCancel: () => void; disabled?: boolean }) {
  const toBranch = agent.base_branch || 'its base branch'
  const waitingOn = mergeQueueWaitingOn(agent)
  return (
    <div className="shrink-0 inline-flex items-center gap-2 h-8 pl-2.5 pr-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300">
      <Tooltip
        side="bottom"
        offset={8}
        delay={0}
        content={`Merges into ${toBranch} on its own — but only once the agent is finished (not mid-task) and its tests pass. Waiting on ${waitingOn}.`}
      >
        <span className="inline-flex items-center gap-2 cursor-help">
          <Clock className="w-4 h-4 shrink-0" />
          <span className="text-[13px] font-semibold whitespace-nowrap">Merge queued</span>
        </span>
      </Tooltip>
      <button
        type="button"
        onClick={onCancel}
        disabled={disabled}
        title="Cancel the queued merge"
        className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-white dark:bg-[#141a26] text-gray-600 dark:text-gray-200 border border-emerald-200/80 dark:border-emerald-800/60 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Cancel
      </button>
    </div>
  )
}

function NetworkEnforcementBadge({ mode }: { mode?: string }) {
  if (!mode) return null
  const cfg: Record<string, { label: string; className: string; Icon: typeof ShieldCheck; tip: string }> = {
    'filtered-hard': {
      label: 'egress locked',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
      Icon: ShieldCheck,
      tip: 'Outbound network is confined to the allow-list inside a network namespace (pasta + nft) — a determined process cannot bypass it.',
    },
    'filtered-advisory': {
      label: 'egress filtered (advisory)',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
      Icon: ShieldAlert,
      tip: 'Outbound traffic is filtered via HTTP(S)_PROXY, so every well-behaved client is restricted to the allow-list — but this is NOT an inescapable boundary: a process that ignores the proxy can still reach the network. Install/upgrade passt (pasta with --map-host-loopback) for a hard boundary, or set network.enabled = false to block egress entirely.',
    },
    unrestricted: {
      label: 'unrestricted network access',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
      Icon: ShieldAlert,
      tip: 'Host filtering is off, so this head can reach any host on the network — a full outbound channel with the provider/GitHub tokens in reach. Set [sandbox.network] filter_enabled = true with an allowed_hosts list to restrict it, or network.enabled = false to block egress entirely.',
    },
    off: {
      label: 'no network',
      className: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
      Icon: ShieldOff,
      tip: 'This head runs with no outbound network access.',
    },
  }
  const c = cfg[mode]
  if (!c) return null
  return (
    <Tooltip variant="card" title="Network access" content={c.tip}>
      <Badge className={c.className} icon={<c.Icon className="w-3 h-3 shrink-0" />}>
        {c.label}
      </Badge>
    </Tooltip>
  )
}

export function AgentDetail({
  agent,
  projectId,
  onKilled,
  onUnselect,
  onRefresh,
}: {
  agent: AgentResponse
  projectId: string | null
  onKilled: (id: string) => void
  // Deselect the agent (navigate back to the project page) without removing it
  // from the list. Used by "Mark as unread", which keeps the agent around with
  // its unread dot lit.
  onUnselect?: () => void
  onRefresh?: () => void
}) {
  const [killing, setKilling] = useState(false)
  const [merging, setMerging] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)
  const [savingBase, setSavingBase] = useState(false)
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const updateAgentInStore = useAgentStore((s) => s.updateAgent)
  const navigate = useNavigate()
  const [, setTick] = useState(0)
  const [diffRefreshTrigger, setDiffRefreshTrigger] = useState(0)
  // Bumped only when the refresh was a new commit (HEAD moved), so the diff
  // viewer re-snapshots the per-commit artifacts (screenshots) on commit — not
  // on every uncommitted working-tree edit, which would rebuild them needlessly.
  const [artifactRefreshTrigger, setArtifactRefreshTrigger] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (agent.created_at == null) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [agent.created_at])

  // Load the repo's branch list for the base-branch selector. Cheap (`git
  // branch`); failures just leave the selector showing the current base as
  // static text. The cached list is shown immediately and refreshed in the
  // background each time the dropdown opens (see BranchSelector `onOpen`), so a
  // newly-spawned agent branch shows up as a base option without a page reload.
  const refreshBranches = useCallback(async () => {
    if (!projectId) return
    try {
      const r = await api.default.getRepositoryBranches(projectId)
      setBranches(r.branches)
    } catch {
      // Keep any previously-cached list on failure; only seed an empty list so
      // the selector can render at all on the very first (failed) load.
      setBranches((prev) => prev ?? [])
    }
  }, [projectId])

  useEffect(() => {
    setBranches(null)
    void refreshBranches()
  }, [refreshBranches])

  // Restore & persist the page scroll position per agent, so each agent's detail
  // page behaves like its own page. Content below the fold (terminal, diff)
  // loads asynchronously and grows the page, so we retry the restore for a short
  // window until the saved offset is reachable, yielding the moment the user
  // scrolls so we never fight them.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const target = loadAgentViewPrefs(projectId, agent.id).scrollTop ?? 0
    let restoring = target > 0
    let raf = 0
    const save = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (restoring) return // ignore the programmatic scrolls of an in-flight restore
        patchAgentViewPrefs(projectId, agent.id, { scrollTop: Math.round(el.scrollTop) })
      })
    }
    const stopRestore = () => { restoring = false }
    el.addEventListener('scroll', save, { passive: true })
    // A real user gesture cancels any in-progress restore.
    el.addEventListener('wheel', stopRestore, { passive: true })
    el.addEventListener('touchstart', stopRestore, { passive: true })

    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const tryRestore = () => {
      if (!restoring) return
      el.scrollTop = target
      // Reached it (within rounding) or out of attempts → stop restoring.
      if (el.scrollTop >= target - 1 || attempts >= 30) {
        restoring = false
        return
      }
      attempts++
      timer = setTimeout(tryRestore, 50)
    }
    tryRestore()

    return () => {
      el.removeEventListener('scroll', save)
      el.removeEventListener('wheel', stopRestore)
      el.removeEventListener('touchstart', stopRestore)
      if (raf) cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [agent.id, projectId])

  const agentTypeClass = agentTypePill(agent.agent_type)

  async function handleKill() {
    useDialogStore.getState().show({
      title: 'Kill this agent?',
      message: 'Stops the running session and deletes its sandbox worktree. This can’t be undone.',
      type: 'confirm',
      variant: 'kill',
      confirmLabel: 'Kill agent',
      details: { loading: true },
      onConfirm: async () => {
        setKilling(true)
        try {
          await api.default.killAgent(projectId ?? '', agent.id)
          useToastStore.getState().show({ message: `Agent "${agent.id}" killed`, type: 'info' })
          // Optimistically move the agent into the archived history so it appears
          // in the sidebar immediately, rather than vanishing until the next
          // archived-list refetch (which only happens on a project switch).
          useAgentStore.getState().upsertArchived({ ...agent, archived: true, end_state: 'killed', session_status: 'stopped', session_pid: 0 })
          onKilled(agent.id)
        } catch (err) {
          useDialogStore.getState().show({
            title: 'Kill Failed',
            message: `Failed to kill agent: ${formatError(err)}`,
            type: 'error'
          })
        } finally {
          setKilling(false)
        }
      }
    })

    // Background: count the unmerged files the worktree deletion will discard,
    // folded into the open dialog when the query returns (kill destroys the whole
    // branch + worktree, so every changed file — committed or not — is "lost").
    void (async () => {
      let lostFiles: number | undefined
      try {
        const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
        lostFiles = d.files?.length ?? 0
      } catch { /* ignore — show the dialog without a count */ }
      const dialog = useDialogStore.getState()
      if (dialog.isOpen && dialog.variant === 'kill') dialog.update({ details: { lostFiles, loading: false } })
    })()
  }

  // executeMerge runs the actual merge POST (optionally force, bypassing the test
  // gate — PLAN #68). On a tests_failing/tests_errored 409 from a non-force merge
  // (e.g. a stale verdict that re-ran red), it offers a force-merge follow-up.
  async function executeMerge(force: boolean) {
    setMerging(true)
    // Both toasts render the agent-transition card (bot icon + clickable agent
    // name + status pill), matching the status-update notifications.
    const name = agent.title || agent.id
    const toastId = useToastStore.getState().show({
      message: `Merging agent "${name}" into ${agent.base_branch}…`,
      type: 'info',
      duration: 0,
      agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merging', before: '', after: `into \`${agent.base_branch}\`…` },
    })
    try {
      await api.default.mergeAgent(projectId ?? '', agent.id, force || undefined)
      useToastStore.getState().dismiss(toastId)
      useToastStore.getState().show({
        message: `Agent "${name}" merged into ${agent.base_branch}`,
        type: 'success',
        agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merged', before: '', after: `into \`${agent.base_branch}\`` },
      })
      useAgentStore.getState().upsertArchived({ ...agent, archived: true, end_state: 'merged', session_status: 'stopped', session_pid: 0 })
      onKilled(agent.id)
    } catch (err) {
      const body = apiErrorBody(err)
      if (body?.error === 'uncommitted_changes') {
        const files = body.conflicting_files ?? []
        const fileList = files.length ? `\n\n${files.map((f) => `• ${f}`).join('\n')}` : ''
        useDialogStore.getState().show({ title: 'Uncommitted Changes in Target', message: `Can't merge: the merge target (${agent.base_branch}) has uncommitted changes that the merge would overwrite. Commit or stash them, then try again.${fileList}`, type: 'warning' })
      } else if (body?.error === 'tests_failing' || body?.error === 'tests_errored') {
        // The soft gate blocked it (the verdict moved since the button rendered).
        // Surface the same Force / Queue choice dialog the button opens proactively.
        const n = (body as { failing_tests?: number }).failing_tests ?? 0
        confirmMergeGate(body.error === 'tests_failing' ? 'failing' : 'errored', n)
      } else if (body?.error === 'merge_conflict') {
        useDialogStore.getState().show({ title: 'Merge Conflict', message: `CONFLICT: Merge failed due to git conflicts. Please resolve them manually or update from base.`, type: 'warning' })
      } else {
        useDialogStore.getState().show({ title: 'Merge Failed', message: `Failed to merge agent: ${formatError(err)}`, type: 'error' })
      }
    } finally {
      useToastStore.getState().dismiss(toastId)
      setMerging(false)
    }
  }

  // confirmMergeGate opens the rich merge-gate dialog (PLAN #68): it explains why
  // the merge is gated (tests failing / still running / no verdict) and offers
  // Force merge now vs Queue merge when green, so the choice is explicit rather
  // than a bare error. Used both proactively (the Merge button when the verdict is
  // known un-green) and reactively (a soft-gate 409 when the verdict moved).
  function confirmMergeGate(kind: 'failing' | 'errored' | 'running', n: number) {
    const toBranch = agent.base_branch || 'base'
    const fromBranch = agent.branch_name || `hydra/${agent.id}`
    const progress = agent.tests?.progress ?? undefined // e.g. "84/142"
    // The heading + a brief situational line; the dialog's under-branch copy (see
    // MergeGatePanel) explains what the two buttons do.
    const title =
      kind === 'failing'
        ? `${n || 'Some'} test${n === 1 ? '' : 's'} failing`
        : kind === 'running'
          ? 'Tests still running'
          : "Tests couldn't run"
    const message =
      kind === 'failing'
        ? `Some tests are failing on this commit.`
        : kind === 'running'
          ? `Tests haven't finished on this commit yet.`
          : `The runner errored, or produced no verdict, for this commit.`
    useDialogStore.getState().show({
      title,
      message,
      type: 'warning',
      variant: 'mergeGate',
      details: { fromBranch, toBranch, testStatus: kind, testFailed: n, testProgress: progress },
      confirmLabel: 'Queue merge',
      onConfirm: () => void armMerge(),
      secondaryLabel: 'Force merge',
      onSecondary: () => void executeMerge(true),
    })
  }

  // confirmForceMerge shows the override confirm for a failing/errored verdict,
  // with copy that names exactly what's being overridden (PLAN #68 design).
  function confirmForceMerge(kind: 'failing' | 'errored') {
    const toBranch = agent.base_branch || 'base'
    const n = agent.tests?.failed ?? 0
    showMergeConfirm({
      force: true,
      title: `Force merge into ${toBranch}?`,
      confirmLabel: 'Force merge',
      caution: kind === 'failing'
        ? `${n || 'Some'} failing test${n === 1 ? '' : 's'} will land on ${toBranch}.`
        : `No passing test verdict for this commit — merging anyway.`,
    })
  }

  // armMerge / cancelMerge toggle "merge when green" (auto-merge).
  async function armMerge() {
    try {
      await api.default.armMergeWhenGreen(projectId ?? '', agent.id)
      // Same agent-transition card as the status-update toasts, but text-only
      // (no status pill — "queued" isn't a status the agent is in yet).
      const name = agent.title || agent.id
      const toBranch = agent.base_branch || 'base'
      useToastStore.getState().show({
        message: `Will merge "${name}" into ${toBranch} when it finishes and its tests pass`,
        type: 'info',
        agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', before: `will merge into \`${toBranch}\` when it finishes and tests pass` },
      })
    } catch (err) {
      useToastStore.getState().show({ message: `Couldn't arm auto-merge: ${formatError(err)}`, type: 'error' })
    }
  }
  async function cancelMerge() {
    try {
      await api.default.disarmMergeWhenGreen(projectId ?? '', agent.id)
      useToastStore.getState().show({ message: 'Auto-merge cancelled', type: 'info' })
    } catch (err) {
      useToastStore.getState().show({ message: `Couldn't cancel auto-merge: ${formatError(err)}`, type: 'error' })
    }
  }

  // handleMerge is the primary merge button + Ctrl+M action. The button always
  // reads "Merge" now (PLAN #68): a click runs the normal, gated merge regardless
  // of verdict — the soft test gate is enforced server-side (a failing verdict
  // 409s and the catch offers a force-merge follow-up), and the explicit Force
  // merge / Queue merge overrides live in the button's dropdown. While armed
  // ("merge when green"), the button toggles the queue off instead.
  function handleMerge() {
    if (agent.merge_when_green === true) return void cancelMerge()
    // Don't wait for the server to 409: when the verdict is already known to be
    // un-green, open the merge-gate dialog (Force / Queue + explanation) directly.
    const verdict = agent.tests?.status
    const n = agent.tests?.failed ?? 0
    if (verdict === 'failing') return confirmMergeGate('failing', n)
    if (verdict === 'errored') return confirmMergeGate('errored', n)
    if (verdict === 'running') return confirmMergeGate('running', n)
    // Verdict is green (or there are no runners) — nothing else gates the merge,
    // so this is where an accidental merge of a still-working agent would slip
    // through. Warn first if it hasn't finished: still working (running/starting)
    // or blocked asking you a question (needs_input). A non-green verdict already
    // routes through the merge-gate above, so this only adds a prompt where there
    // would otherwise be none.
    const st = agent.agent_status?.status
    if (st === 'running' || st === 'starting' || st === 'needs_input') {
      return confirmMergeWhileActive(st === 'needs_input')
    }
    return confirmNormalMerge()
  }

  // confirmMergeWhileActive gates a merge whose branch is green but whose AGENT
  // hasn't finished: still working (running/starting) or blocked asking you a
  // question (needs_input). It reuses the merge-gate dialog's Force / Queue /
  // Cancel choice — Queue is the natural action here, arming merge-when-green so
  // it lands once the agent is actually done. `blocked` selects the wording.
  function confirmMergeWhileActive(blocked: boolean) {
    const toBranch = agent.base_branch || 'base'
    const fromBranch = agent.branch_name || `hydra/${agent.id}`
    useDialogStore.getState().show({
      title: blocked ? 'Agent is waiting on you' : 'Agent is still running',
      message: blocked
        ? `"${agent.id}" is asking you a question — merging now abandons it and may land incomplete work.`
        : `"${agent.id}" hasn't finished this turn — merging now may capture an incomplete state.`,
      type: 'warning',
      variant: 'mergeGate',
      details: { fromBranch, toBranch, agentGate: blocked ? 'needs_input' : 'running' },
      confirmLabel: 'Queue merge',
      onConfirm: () => void armMerge(),
      secondaryLabel: 'Force merge',
      onSecondary: () => void executeMerge(true),
    })
  }

  function confirmNormalMerge() {
    showMergeConfirm({})
  }

  // showMergeConfirm renders the rich merge dialog (branch chip + diff stats + an
  // optional caution line) — shared by the normal merge and the force-merge override
  // so they look identical bar the title/label/caution. `force` bypasses the soft
  // test gate server-side.
  function showMergeConfirm(opts: { force?: boolean; title?: string; confirmLabel?: string; caution?: string }) {
    const force = opts.force ?? false
    // If this agent is stacked on another agent (its base branch is another
    // agent's branch), the merge advances that parent agent's branch — name it,
    // and warn when the parent is still running since its working files will
    // shift underneath it.
    const parent = useAgentStore.getState().agents.find((a) => a.branch_name === agent.base_branch)
    const fromBranch = agent.branch_name || `hydra/${agent.id}`
    const toBranch = agent.base_branch || 'base'
    const parentWarning = parent && parent.session_status === 'running'
      ? `Parent agent "${parent.id}" is running — merging will change its working files.`
      : undefined
    const lead = parent
      ? `Merges this agent’s work into agent "${parent.id}"'s branch (${toBranch}) and closes the session.`
      : `Merges this agent’s work into ${toBranch} and closes the session.`
    // A caller-supplied caution (e.g. failing tests for a force merge) wins over the
    // uncommitted-changes note the background check would otherwise add.
    const caution = opts.caution ?? parentWarning

    // Show the dialog immediately so it never lags behind a slow git query.
    // The diff stats + uncommitted-changes check run in the background and fold
    // into the open dialog when they return.
    useDialogStore.getState().show({
      title: opts.title ?? `Merge into ${toBranch}?`,
      message: lead,
      type: caution ? 'warning' : 'confirm',
      variant: 'merge',
      confirmLabel: opts.confirmLabel ?? 'Merge branch',
      details: { fromBranch, toBranch, note: caution, loading: true },
      onConfirm: () => void executeMerge(force),
    })

    void (async () => {
      let patch: Partial<DialogDetails> = { loading: false }
      try {
        const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
        const additions = d.files.reduce((s, f) => s + (f.additions ?? 0), 0)
        const deletions = d.files.reduce((s, f) => s + (f.deletions ?? 0), 0)
        patch = { ...patch, additions, deletions }
        // Only add the uncommitted-loss note when the caller didn't supply its own
        // caution (which takes priority).
        if (!caution && d.uncommitted_changes) {
          const total = (d.uncommitted_summary?.tracked_count ?? 0) + (d.uncommitted_summary?.untracked_count ?? 0)
          patch.note = `${total} uncommitted file change${total !== 1 ? 's' : ''} will be lost when merging.`
        }
      } catch { /* ignore — show the dialog without stats */ }
      const dialog = useDialogStore.getState()
      if (dialog.isOpen && dialog.variant === 'merge') {
        dialog.update({ details: { ...dialog.details, ...patch }, type: (patch.note || caution) ? 'warning' : 'confirm' })
      }
    })()
  }

  // Mark the agent unread and deselect it: lights the sidebar unread dot and
  // navigates back to the project page (viewing an agent is what "reads" it, so
  // staying open would be contradictory). The unread override set by markUnread
  // is what stops the auto-clear-on-open effect (__root.tsx) from immediately
  // re-reading it — navigation alone can't, since the store update lands a render
  // before the route changes. Optimistic locally + a fire-and-forget POST.
  function handleMarkUnread() {
    useAgentStore.getState().markUnread(agent.id)
    onUnselect?.()
    if (projectId) {
      api.default.markAgentUnread(projectId, agent.id).catch(() => {})
    }
  }

  // Keyboard shortcuts for the open agent: merge (Ctrl+M), mark unread (Ctrl+U),
  // kill (Ctrl+K), rename (F2), and switch to the next/previous agent (Alt+↓ /
  // Alt+↑). Ctrl is the action modifier on every platform (see lib/shortcuts
  // hasMod); navigation uses Alt+arrows so it doesn't collide with Ctrl+K. The
  // listener binds once and reads the latest handlers/agent through a ref so it
  // never goes stale. It stays inert while typing (the terminal, a form field) or
  // while a dialog / help overlay is open, so it never steals a keystroke (Ctrl+M
  // is Enter in a terminal) or acts behind a modal.
  const shortcutRef = useRef<{ merge: () => void; markUnread: () => void; kill: () => void; rename: () => void; agentId: string; projectId: string | null; busy: boolean; archived: boolean }>(null!)
  shortcutRef.current = {
    merge: handleMerge,
    markUnread: handleMarkUnread,
    kill: handleKill,
    rename: startEditingTitle,
    agentId: agent.id,
    projectId,
    busy: merging || killing,
    archived: !!agent.archived,
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialogOpen = useDialogStore.getState().isOpen || useShortcutsStore.getState().open
      const ctx = shortcutRef.current
      // Merge (Ctrl+M) and mark-unread (Ctrl+U) fire even while the terminal is
      // focused, so handle them before the typing-target guard below. They're
      // agent-wide actions and the terminal's key handler suppresses these combos
      // (Ctrl+M = Enter, Ctrl+U = kill-line) so they never reach the PTY. They
      // still defer to an open dialog / help overlay.
      if (hasMod(e) && !e.altKey && !e.shiftKey) {
        const actionKey = e.key.toLowerCase()
        if (actionKey === 'm') {
          if (dialogOpen || ctx.archived || ctx.busy) return
          e.preventDefault()
          ctx.merge()
          return
        }
        if (actionKey === 'u') {
          if (dialogOpen || ctx.archived) return
          e.preventDefault()
          ctx.markUnread()
          return
        }
      }
      // The remaining shortcuts defer to typing surfaces (form fields, terminal)
      // and to open modals.
      if (isTypingTarget(e.target)) return
      if (dialogOpen) return
      // Rename — F2, no modifier (Windows convention).
      if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (ctx.archived) return
        e.preventDefault()
        ctx.rename()
        return
      }
      // Switch agent — Alt+↑/↓ steps through the live agents list (wrapping).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = useAgentStore.getState().agents
        if (list.length < 2 || !ctx.projectId) return
        e.preventDefault()
        const idx = list.findIndex((a) => a.id === ctx.agentId)
        const dir = e.key === 'ArrowDown' ? 1 : -1
        // First step moves off the current agent; with the current agent not in
        // the live list (e.g. an archived one) land on the first/last.
        const start = idx === -1 ? (dir === 1 ? -1 : 0) : idx
        const next = list[(start + dir + list.length) % list.length]
        if (next && next.id !== ctx.agentId) {
          navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: ctx.projectId, agentId: next.id } })
        }
        return
      }
      // Kill — Ctrl+K (Ctrl is hasMod on every platform). Merge/mark-unread are
      // handled above so they also work with the terminal focused; kill stays
      // gated by the typing guard since Ctrl+K is kill-to-end-of-line in a shell.
      if (!hasMod(e) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() === 'k') {
        if (ctx.archived || ctx.busy) return
        e.preventDefault()
        ctx.kill()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  function startEditingTitle() {
    setTitleDraft(agent.title || agent.id)
    setEditingTitle(true)
  }

  async function saveTitle() {
    const next = titleDraft.trim()
    // No-op edits (empty, or unchanged) just close the editor without a request.
    if (!next || next === (agent.title || '')) {
      setEditingTitle(false)
      return
    }
    setSavingTitle(true)
    const res = await runWithToast(
      () => api.default.updateAgent(projectId ?? '', agent.id, { title: next }),
      { errorPrefix: 'Failed to rename agent' },
    )
    if (res.ok) {
      updateAgentInStore(res.value)
      setEditingTitle(false)
    }
    setSavingTitle(false)
  }

  // Changing the base branch is metadata-only: it updates what update-from-base
  // merges in and what the diff compares against, but does NOT rebase existing
  // commits (the user can do that with git if they want). The backend validates
  // the ref exists and returns a 400 we surface as a toast.
  async function saveBase(next: string) {
    if (!next || next === (agent.base_branch || '')) return
    // An agent can't be based on its own branch (diffs/update-from-base would
    // compare it against itself). The dropdown already filters this out; this is
    // a defensive guard in case it's ever reachable.
    if (next === agent.branch_name) return
    setSavingBase(true)
    const res = await runWithToast(
      () => api.default.updateAgent(projectId ?? '', agent.id, { base_branch: next }),
      {
        success: `Base branch set to ${next} (commits not moved)`,
        errorPrefix: 'Failed to set base branch',
      },
    )
    if (res.ok) updateAgentInStore(res.value)
    setSavingBase(false)
  }

  // Archived agents are read-only: render the history view instead of the live
  // terminal/diff. Placed after all hooks above so hook order stays stable when
  // the same mounted component switches between a live and an archived agent.
  if (agent.archived) {
    return <ArchivedAgentDetail agent={agent} projectId={projectId} onPurged={onKilled} />
  }

  // The merge button (PLAN #68) has three states:
  //  • merging  — a quiet, inert "Merging…" button (in-flight, spinner).
  //  • armed    — the green "Merges when tests pass" pill with its own Cancel button.
  //  • resting  — the emerald "Merge" split button; the verdict-specific overrides
  //               (Force / Queue) live in its dropdown, with a failing-tests warning.
  const verdict = agent.tests?.status
  const armed = agent.merge_when_green === true
  const busy = merging || killing
  const toBranch = agent.base_branch || 'base'
  // Force routes to the right confirm copy: a failing verdict names the failing
  // count; anything else (errored / no verdict / still running) is "merge anyway".
  const forceMerge = () => confirmForceMerge(verdict === 'failing' ? 'failing' : 'errored')

  const mergeAction: AgentTopBarAction = merging
    ? {
        label: 'Merging…',
        icon: <LoaderCircle className="w-4 h-4 animate-spin" />,
        onClick: () => {},
        variant: 'muted',
        shortcut: SHORTCUT_MERGE,
      }
    : armed
      ? {
          // Compound control (see AgentTopBarAction.render): a green status pill
          // carrying its own Cancel button, so the state and the way out are both
          // visible. `onClick` is the keyboard-shortcut fallback (Ctrl+M cancels).
          label: 'Merge queued',
          icon: <Clock className="w-4 h-4" />,
          onClick: () => void cancelMerge(),
          shortcut: SHORTCUT_MERGE,
          render: <MergeWhenGreenPill agent={agent} onCancel={() => void cancelMerge()} disabled={busy} />,
        }
      : {
          label: 'Merge',
          icon: <Merge className="w-4 h-4" />,
          onClick: handleMerge,
          variant: 'primary',
          disabled: busy,
          shortcut: SHORTCUT_MERGE,
          menu: ([
            { label: 'Force merge', description: `Merge this commit to ${toBranch} right now.`, icon: <AlertTriangle className="w-4 h-4" />, onClick: forceMerge, danger: true, tone: 'red', disabled: busy },
            { label: 'Queue merge', description: 'Merges on its own once tests pass.', icon: <Clock className="w-4 h-4" />, onClick: () => void armMerge(), tone: 'emerald', disabled: busy },
          ] as AgentTopBarMenuItem[]),
        }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* The agent header is a single header bar (no separate H1): the name with
          an actions dropdown (Rename / Merge / Kill — clicking the name also
          renames it inline) and a status dot. While the sidebar is collapsed it
          also hosts the show-sidebar toggle. It sits above the scroll area so it
          never collides with the diff's own sticky "Changes" header. */}
      <AgentTopBar
        title={agent.title || agent.id}
        statusDot={<span className={`block w-2.5 h-2.5 rounded-full ${agentDotClass(agent)} ${agentDotAnimate(agent)}`} />}
        rename={{
          editing: editingTitle,
          draft: titleDraft,
          saving: savingTitle,
          onStart: startEditingTitle,
          onChange: setTitleDraft,
          onSave: saveTitle,
          onCancel: () => setEditingTitle(false),
        }}
        actions={[
          mergeAction,
          { label: 'Mark as unread', icon: <Mail className="w-4 h-4" />, onClick: handleMarkUnread, variant: 'segment', shortcut: SHORTCUT_MARK_UNREAD },
          { label: 'Rename', icon: <Pencil className="w-4 h-4" />, onClick: startEditingTitle, variant: 'segment', shortcut: SHORTCUT_RENAME },
          { label: 'Kill', icon: <Trash2 className="w-4 h-4" />, onClick: handleKill, variant: 'danger', disabled: merging || killing, shortcut: SHORTCUT_KILL },
        ]}
      />
      {/* pt-4 (16px) above the metadata row matches the effective gap below it
          (its mb-6 minus the prompt block's -mt-2), so it sits evenly spaced. */}
      <div ref={scrollRef} className="flex-1 flex flex-col overflow-auto px-3 sm:px-6 pb-3 sm:pb-6 pt-4 min-w-0 min-h-0" data-main-scroll>
        <div className="w-full">
        {/* Header */}
        <div className="mb-6">
          {/* Metadata row */}
          <SeparatedRow className="flex items-center gap-x-3 gap-y-1 flex-wrap">
            <Badge
              variant="pill"
              className={agentTypeClass}
              icon={<AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />}
            >
              {agent.agent_type}
            </Badge>
            {agent.agent_status && (
              <Badge className={agentStatusBadge(agent.agent_status.status).className}>
                {agentStatusBadge(agent.agent_status.status).label}
              </Badge>
            )}
            {/* Test verdict chip (PLAN #68): an at-a-glance verdict. The full
                tests panel lives in the diff viewer, below the Changes header. */}
            {agent.tests && agent.tests.status !== 'none' && (
              <TestVerdictChip tests={agent.tests} variant="sm" />
            )}
            {/* The armed "merges when tests pass" state is shown by the merge button
                itself now (the green pill), so no separate metadata-row badge. */}
            {agent.network_enforcement && <NetworkEnforcementBadge mode={agent.network_enforcement} />}
            {agent.branch_name && (
              <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                {agent.branch_name}
              </span>
            )}
            {/* Base branch. Editing it is metadata-only: it changes what
                update-from-base merges in and what the diff compares against,
                but does not rebase existing commits. */}
            <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              <span className="font-sans text-gray-400 dark:text-gray-500">base</span>
              {branches !== null && !savingBase ? (
                <BranchSelector
                  // An agent can't be its own base, so drop its own branch from
                  // the options (the backend lists every branch agent-agnostically).
                  branches={branches.filter((b) => b.name !== agent.branch_name)}
                  activeRef={agent.base_branch || ''}
                  isKnownBranch={branches.some((b) => b.name === agent.base_branch)}
                  onSelect={(name) => void saveBase(name)}
                  onOpen={() => void refreshBranches()}
                  title="Change base branch (metadata only — does not rebase commits)"
                />
              ) : (
                <span className="flex items-center gap-1.5 px-2.5 py-1.5">
                  {savingBase && <LoaderCircle className="w-3 h-3 animate-spin" />}
                  {agent.base_branch || '—'}
                </span>
              )}
            </span>
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                created {formatStartedAgo(agent.created_at)}
              </span>
            )}
          </SeparatedRow>

        </div>

        {/* Prompt */}
        {agent.prompt && <PromptBlock prompt={agent.prompt} projectId={projectId} />}

        {/* Security-gate approvals are surfaced as global toasts (see
            useAgentNotifications) rather than an inline card. */}

        {/* Terminal */}
        <AgentTerminal
          agentId={agent.id}
          projectId={projectId}
          isEphemeral={agent.ephemeral}
          onRefresh={onRefresh}
          onDiffRefresh={(headMoved) => {
            setDiffRefreshTrigger((t) => t + 1)
            if (headMoved) setArtifactRefreshTrigger((t) => t + 1)
          }}
        />

        {/* Diff viewer */}
        <DiffViewer agent={agent} projectId={projectId} externalRefreshTrigger={diffRefreshTrigger} externalArtifactRefresh={artifactRefreshTrigger} />
        </div>
      </div>
    </div>
  )
}
