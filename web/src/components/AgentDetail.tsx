import { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../stores/apiClient'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatError, apiErrorBody } from '../api/format_error'
import { runWithToast } from '../lib/apiAction'
import type { AgentResponse, RepositoryBranch } from '../api'
import { MRStateChip, DownstreamBranchEditor, CreateMRDialog, MRIcon, ProviderIcon } from './ReviewControls'
import { AgentTerminal } from './AgentTerminal'
import { BranchSelector } from './BranchSelector'
import { BranchTag } from './BranchTag'
import { copyBranchName } from '../lib/branch'
import { SeparatedRow } from './SeparatedRow'
import { AgentTopBar, type AgentTopBarAction, type AgentTopBarMenuItem } from './AgentTopBar'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { uploadBlobUrl } from '../api/uploads'
import type { Attachment } from '../lib/spawnDrafts'
import { DiffViewer } from '../DiffViewer'
import { agentStatusBadge, archivedEndStateBadge, agentDotClass, agentDotAnimate, agentTypePill } from '../lib/agentDisplay'
import { LoaderCircle, GitPullRequestArrow, Trash2, RotateCcw, Pencil, TerminalSquare, Mail, ShieldAlert, ShieldCheck, ShieldOff, AlertTriangle, Clock, Upload, Download, MessageSquare, ChevronRight, ChevronLeft, PanelRightOpen, PanelRightClose, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { InspectorPane } from './InspectorPane'
import { IconButton } from './IconButton'
import { useSplitLayoutStore, usePaneCollapseStore, useMediaQuery, SPLIT_QUERY, loadSplitRatio, saveSplitRatio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX } from '../lib/layout'
import { TestVerdictChip } from './TestVerdict'
import { Tooltip } from './Tooltip'
import { Badge } from './Badge'
import { AgentTypeIcon, type AgentTypeIconName } from './AgentTypeIcon'
import { RelativeTime } from './LiveTime'
import { deepEqual } from '../lib/deepEqual'
import { Markdown } from '../lib/MarkdownRenderer'
import { renderMarkdown } from '../lib/markdown'

import { useDialogStore, type DialogDetails } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { useAgentStore } from '../stores/agentStore'
import { ensureReviewConfig, refreshReviewConfig, useProjectStore } from '../stores/projectStore'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { hasMod, isTypingTarget, SHORTCUT_MERGE, SHORTCUT_MARK_UNREAD, SHORTCUT_KILL, SHORTCUT_RENAME, SHORTCUT_DIFF_SIDEBAR } from '../lib/shortcuts'

// Matches an upload path the spawn form embeds in a prompt: any token containing
// the uploads dir followed by the on-disk filename (sanitized to [A-Za-z0-9._-]
// by uniqueUploadName, so the run stops cleanly at trailing punctuation).
// Shared style for the split layout's divider-flanking pane-collapse toggles.
const PANE_TOGGLE_CLS = 'flex items-center justify-center w-7 h-7 rounded-md border text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer shrink-0'

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

// memo: AgentDetail re-renders on every live tick of its agent, but the prompt
// never changes after spawn - no need to re-parse/re-render its markdown.
// The inner rendering of a prompt: the markdown body plus the referenced upload
// attachments as chips, with a lightbox for image thumbnails. The chrome
// (border/background/scroll) lives in the wrappers below - PromptBlock's box and
// CollapsiblePrompt's card - so this stays a bare content fragment, shared so the
// two never drift.
const PromptContent = memo(function PromptContent({ prompt, projectId }: { prompt: string; projectId: string | null }) {
  const { text, attachments } = useMemo(() => parsePrompt(prompt, projectId), [prompt, projectId])
  // Index into the image-only attachments while the lightbox is open; clicking a
  // thumbnail opens it here, mirroring the spawn form.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  return (
    <>
      {text && <Markdown text={text} className="text-sm text-gray-800 dark:text-gray-200" />}
      <AttachmentChips
        attachments={attachments}
        size="md"
        className={text ? 'mt-3' : ''}
        onOpenImage={(id) => setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))}
      />
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          index={Math.min(lightboxIndex, lightboxImages.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  )
})

const PromptBlock = memo(function PromptBlock({ prompt, projectId }: { prompt: string; projectId: string | null }) {
  // A box that scrolls when the prompt is tall; short prompts show no scrollbar
  // since the content fits under the max-height. The negative top margin tucks
  // it a little closer to the metadata above, and the bottom gradient softens
  // the cutoff as a long prompt scrolls out of view.
  return (
    <div className="relative -mt-2 mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      {/* A taller max-height means most prompts (incl. a code block or two)
          don't need to scroll at all. */}
      <div className="overflow-y-auto max-h-96">
        <PromptContent prompt={prompt} projectId={projectId} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-lg bg-gradient-to-t from-gray-50 dark:from-gray-800 to-transparent" />
    </div>
  )
})

// CollapsiblePrompt wraps the read-only prompt in a disclosure for the split
// layout's working pane, where vertical space is scarce (the terminal/chat wants
// the height). Collapsed by default, showing a one-line truncated preview;
// clicking expands the full PromptBlock. The open/closed state persists per agent
// (agentViewPrefs.promptCollapsed). Only used in terminal mode - chat-mode heads
// have no prompt block (the task is replayed as the first chat message).
const CollapsiblePrompt = memo(function CollapsiblePrompt({ prompt, projectId, agentId }: { prompt: string; projectId: string | null; agentId: string }) {
  // Default collapsed: open only when the stored flag explicitly says so.
  const [open, setOpen] = useState(() => loadAgentViewPrefs(projectId, agentId).promptCollapsed === false)
  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o
      patchAgentViewPrefs(projectId, agentId, { promptCollapsed: !next })
      return next
    })
  }, [projectId, agentId])
  const preview = useMemo(() => parsePrompt(prompt, projectId).text.replace(/\s+/g, ' ').trim(), [prompt, projectId])
  return (
    <div className="shrink-0 mb-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-gray-100/70 dark:hover:bg-gray-700/40 transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 shrink-0">Prompt</span>
        {!open && (
          // Render the one-line preview through the inline markdown renderer (the
          // same one the live-activity line uses) so `code`, *italic*, **bold**
          // etc. show styled instead of as raw markers. singleLine collapses the
          // newlines so it stays a single truncated row.
          <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
            {renderMarkdown(preview, { singleLine: true })}
          </span>
        )}
      </button>
      {/* Animate the body open/closed with a 0fr->1fr grid row (height:auto can't
          transition); the inner wrapper clips its overflow while collapsing. The
          markdown renders straight into the card - no nested PromptBlock box. */}
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-3 pb-3 max-h-96 overflow-y-auto">
            <PromptContent prompt={prompt} projectId={projectId} />
          </div>
        </div>
      </div>
    </div>
  )
})

// ArchivedAgentDetail is the read-only view for a finished (killed/merged) agent
// retained in the history. There is no live session, so there is no terminal
// (just a grayed placeholder) and no diff/kill/merge/restart actions. The
// "Resume" affordance is shown but not yet wired - see PLAN #49.
function ArchivedAgentDetail({ agent, projectId, onPurged }: { agent: AgentResponse; projectId: string | null; onPurged: (id: string) => void }) {
  const [purging, setPurging] = useState(false)
  const [resuming, setResuming] = useState(false)
  const navigate = useNavigate()
  const endBadge = archivedEndStateBadge(agent.end_state)

  // Resume revives the archived head: the backend recreates its worktree+branch
  // off the current base and relaunches the agent continuing from its saved
  // conversation (the file changes start fresh). On success the head moves from
  // the archived history into the live list and we open its live page.
  async function handleResume() {
    setResuming(true)
    try {
      const revived = await api.default.resumeAgent(projectId ?? '', agent.id)
      useAgentStore.getState().removeArchived(agent.id)
      useAgentStore.getState().addAgent(revived)
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: projectId ?? '', agentId: agent.id } })
    } catch (e) {
      useDialogStore.getState().show({
        title: 'Resume Failed',
        message: formatError(e),
        type: 'error',
      })
    } finally {
      setResuming(false)
    }
  }

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
          {/* Metadata row. Not `live`: this archived view's agent is static, so
              the only thing that ticks is "created X ago", which self-updates via
              its own <RelativeTime> leaf - no need to re-render + re-measure the
              whole row every second. */}
          <SeparatedRow className="flex items-center gap-3 flex-wrap">
            <Badge
              variant="pill"
              className={agentTypeClass}
              icon={<AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />}
            >
              {agent.agent_type}
            </Badge>
            <Badge className={endBadge.className}>{endBadge.label}</Badge>
            {agent.branch_name && <BranchTag branch={agent.branch_name} />}
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                created <RelativeTime createdAt={agent.created_at} />
              </span>
            )}
          </SeparatedRow>
        </div>

        {/* Prompt */}
        {agent.prompt && <PromptBlock prompt={agent.prompt} projectId={projectId} />}

        {/* Grayed-out terminal placeholder with Resume / Delete actions. */}
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-8 flex flex-col items-center justify-center text-center gap-3">
          <TerminalSquare className="w-8 h-8 text-gray-300 dark:text-gray-600" />
          <div className="text-sm text-gray-500 dark:text-gray-400">
            This agent was {endBadge.label}. Its session, worktree and branch were removed.
            Resume recreates its worktree off the current base and continues from its saved
            conversation - the code changes start fresh.
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Tooltip content="Recreate this agent's worktree and continue from its saved conversation">
              <button
                onClick={handleResume}
                disabled={resuming}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resuming ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
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
// the green "locked" hard boundary, the amber advisory (proxy-respecting) mode,
// "no network", and the open "unrestricted" state (so an open egress channel is
// always visible, not silently hidden). Hidden only when the head isn't live
// (mode absent). Advisory only ever appears when explicitly configured - a hard
// head whose boundary can't be built fails closed and shows "no network".
// mergeQueueWaitingOn describes what an armed (merge-when-green) head's queued
// merge is currently blocked on, for the pill's tooltip. Reaching a finished
// state is the dominant gate - the head can't merge mid-work - so any not-yet-
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
        content={`Merges into ${toBranch} on its own - but only once the agent is finished (not mid-task) and its tests pass. Waiting on ${waitingOn}.`}
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
      tip: 'Outbound network is confined to the allow-list inside a network namespace (pasta + nft) - a determined process cannot bypass it.',
    },
    'filtered-advisory': {
      label: 'egress filtered (advisory)',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
      Icon: ShieldAlert,
      tip: 'Outbound traffic is filtered via HTTP(S)_PROXY, so every well-behaved client is restricted to the allow-list - but this is NOT an inescapable boundary: a process that ignores the proxy can still reach the network. Set network.mode = "hard" for an inescapable boundary (needs passt/pasta with --map-host-loopback), or "off" to block egress entirely.',
    },
    unrestricted: {
      label: 'unrestricted network access',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
      Icon: ShieldAlert,
      tip: 'Host filtering is off, so this head can reach any host on the network - a full outbound channel with the provider/GitHub tokens in reach. Set [sandbox.network] mode = "hard" to restrict it to the allow-list, or "off" to block egress entirely.',
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

// The fields of `agent` the metadata row (AgentMetaRow) actually renders. The
// row is memoized on a deep comparison of just these, so the near-constant agent
// refreshes while a head works (activity text, timestamps, token counts - none
// shown here) don't re-render the header and its BranchSelector/badges/chips on
// every tick, and don't fire SeparatedRow's layout re-measure. A fresh listAgents
// poll rebuilds every nested object, so identity (===) can't be trusted - hence
// deepEqual over this projected subset. KEEP THIS IN SYNC with the JSX below: a
// new agent field shown in the row must be added here or it won't update live.
function metaRowSignature(a: AgentResponse) {
  return {
    agent_type: a.agent_type,
    archived: a.archived,
    // status + tests moved to the header (AgentTopBar), so the row no longer
    // depends on them.
    network_enforcement: a.network_enforcement,
    branch_name: a.branch_name,
    base_branch: a.base_branch,
    chat_mode: a.chat_mode,
    created_at: a.created_at,
    // Read by the DownstreamBranchEditor + MRStateChip children.
    downstream_branch: a.downstream_branch,
    review: a.review,
  }
}

// The agent-page metadata row: the type/status/test badges, network + branch
// tags, base-branch selector, terminal/chat toggle, downstream editor and MR
// chip, plus a self-ticking "created X ago". Memoized (see metaRowSignature) so a
// running head's constant refreshes don't churn it; the handlers are stabilized
// by the caller so only real display changes get through.
const AgentMetaRow = memo(function AgentMetaRow({
  agent,
  agentTypeClass,
  branches,
  savingBase,
  savingChatMode,
  savingDownstream,
  onSaveBase,
  onRefreshBranches,
  onSaveChatMode,
  onSaveDownstream,
}: {
  agent: AgentResponse
  agentTypeClass: string
  branches: RepositoryBranch[] | null
  savingBase: boolean
  savingChatMode: boolean
  savingDownstream: boolean
  onSaveBase: (name: string) => void
  onRefreshBranches: () => void
  onSaveChatMode: (next: boolean) => void
  onSaveDownstream: (n: string) => void
}) {
  return (
    // Not `live`: "created X ago" self-updates via its own <RelativeTime> leaf, so
    // the row no longer subscribes to the 1s clock (which re-rendered + re-measured
    // it every second even when idle).
    <SeparatedRow className="flex items-center gap-x-3 gap-y-1 flex-wrap">
      <Badge
        variant="pill"
        className={agentTypeClass}
        icon={<AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />}
      >
        {agent.agent_type}
      </Badge>
      {/* Status pill sits right after the agent-type chip (moved back out of the
          header). The test verdict stays in the header. */}
      {agent.agent_status && (
        <Badge className={agentStatusBadge(agent.agent_status.status).className}>
          {agentStatusBadge(agent.agent_status.status).label}
        </Badge>
      )}
      {/* The armed "merges when tests pass" state is shown by the merge button
          itself now (the green pill), so no separate metadata-row badge. */}
      {agent.network_enforcement && <NetworkEnforcementBadge mode={agent.network_enforcement} />}
      {agent.branch_name && <BranchTag branch={agent.branch_name} />}
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
            onSelect={(name) => onSaveBase(name)}
            onOpen={() => onRefreshBranches()}
            title="Change base branch (metadata only - does not rebase commits)"
          />
        ) : (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5">
            {savingBase && <LoaderCircle className="w-3 h-3 animate-spin" />}
            {agent.base_branch || '-'}
          </span>
        )}
      </span>
      {/* Terminal/chat mode toggle (Claude only). Switching
          restarts the Claude process in the new mode; the conversation is
          preserved via --continue. */}
      {agent.agent_type === 'claude' && !agent.archived && (
        <span
          className="inline-flex items-center overflow-hidden rounded-full border border-gray-300 dark:border-gray-600 text-xs font-mono"
          title="How this head is driven: a terminal or a chat view. Switching restarts the Claude process; the conversation is preserved."
        >
          {savingChatMode ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1 text-gray-500 dark:text-gray-400">
              <LoaderCircle className="w-3 h-3 animate-spin" />
              switching
            </span>
          ) : (
            <>
              <button
                onClick={() => onSaveChatMode(false)}
                className={`flex items-center gap-1 px-2 py-1 transition-colors ${
                  agent.chat_mode
                    ? 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer'
                    : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium'
                }`}
              >
                <TerminalSquare className="w-3 h-3" />
                terminal
              </button>
              <button
                onClick={() => onSaveChatMode(true)}
                className={`flex items-center gap-1 px-2 py-1 transition-colors border-l border-gray-300 dark:border-gray-600 ${
                  agent.chat_mode
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer'
                }`}
              >
                <MessageSquare className="w-3 h-3" />
                chat
              </button>
            </>
          )}
        </span>
      )}
      {/* Downstream branch (the name this head is pushed AS) - editable
          until first publish, then soft-locked. Only shown once set. */}
      <DownstreamBranchEditor agent={agent} onSave={(n) => onSaveDownstream(n)} saving={savingDownstream} />
      {/* Linked-MR state chip (state/CI/approvals/discussions). */}
      <MRStateChip agent={agent} />
      {agent.created_at !== 0 && agent.created_at !== undefined && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          created <RelativeTime createdAt={agent.created_at} />
        </span>
      )}
    </SeparatedRow>
  )
}, (prev, next) =>
  prev.agentTypeClass === next.agentTypeClass &&
  prev.branches === next.branches &&
  prev.savingBase === next.savingBase &&
  prev.savingChatMode === next.savingChatMode &&
  prev.savingDownstream === next.savingDownstream &&
  prev.onSaveBase === next.onSaveBase &&
  prev.onRefreshBranches === next.onRefreshBranches &&
  prev.onSaveChatMode === next.onSaveChatMode &&
  prev.onSaveDownstream === next.onSaveDownstream &&
  deepEqual(metaRowSignature(prev.agent), metaRowSignature(next.agent)),
)

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
  const [publishing, setPublishing] = useState(false)
  const [showCreateMR, setShowCreateMR] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  // Review config is project-scoped, cached in the project store so it is
  // fetched once per project (not per agent) and shared with the Settings editor.
  const reviewConfig = useProjectStore((s) => (projectId ? s.reviewConfigs[projectId] ?? null : null))
  const remotes = reviewConfig?.remote ? [reviewConfig.remote] : ['origin']
  const [savingDownstream, setSavingDownstream] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)
  const [savingBase, setSavingBase] = useState(false)
  const [savingChatMode, setSavingChatMode] = useState(false)
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const updateAgentInStore = useAgentStore((s) => s.updateAgent)
  const navigate = useNavigate()
  const [diffRefreshTrigger, setDiffRefreshTrigger] = useState(0)
  // Bumped only when the refresh was a new commit (HEAD moved), so the diff
  // viewer re-snapshots the per-commit artifacts (screenshots) on commit - not
  // on every uncommitted working-tree edit, which would rebuild them needlessly.
  const [artifactRefreshTrigger, setArtifactRefreshTrigger] = useState(0)
  // Stable identity so the memo'd AgentTerminal doesn't re-render on every
  // live tick of the agent (this component re-renders on each one).
  const handleDiffRefresh = useCallback((headMoved: boolean) => {
    setDiffRefreshTrigger((t) => t + 1)
    if (headMoved) setArtifactRefreshTrigger((t) => t + 1)
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── Two-pane split layout ──────────────────────────────────────────────────
  // Gated behind the split-layout flag. On a WIDE viewport it's the real two-pane
  // split (working pane + diff/inspector pane, divider between). On a NARROW
  // viewport there's no room for two panes, so it degrades to a single pane that
  // the diff-sidebar toggle flips between the working view and a full-screen diff.
  // The pane-collapse store holds the shared state (none / inspector-hidden /
  // working-hidden). With the flag off (or archived) the classic stacked layout
  // renders instead.
  const splitEnabled = useSplitLayoutStore((s) => s.enabled)
  const isWide = useMediaQuery(SPLIT_QUERY)
  const paneCollapse = usePaneCollapseStore((s) => s.collapse)
  const toggleInspector = usePaneCollapseStore((s) => s.toggleInspector)
  const toggleWorking = usePaneCollapseStore((s) => s.toggleWorking)
  const splitActive = splitEnabled && isWide && !agent.archived
  const narrowSplit = splitEnabled && !isWide && !agent.archived
  const paneActive = splitActive || narrowSplit
  // Is the diff currently on screen? Wide: the inspector pane isn't collapsed.
  // Narrow: the single pane is showing the full-screen diff (working collapsed).
  const diffShown = isWide ? paneCollapse !== 'inspector' : paneCollapse === 'working'
  // The diff-sidebar toggle (top bar + Ctrl+,): wide hides/shows the inspector
  // pane; narrow flips the single pane between working and full-screen diff.
  const toggleDiffSidebar = useCallback(() => {
    if (!paneActive) return
    if (isWide) toggleInspector()
    else toggleWorking()
  }, [paneActive, isWide, toggleInspector, toggleWorking])
  // Divider-flanking collapse toggles (wide split). The same two spots host both
  // hide and show, keyed off the OTHER pane's state:
  //  - workingTopButton (working pane's top-right, left of the divider): "Hide
  //    chat" normally; "Show diff" once the inspector is collapsed (working is
  //    then full-width).
  //  - changesLeadingButton (left edge of the diff's Changes bar, right of the
  //    divider): "Hide diff" normally; "Show chat" once the working pane is
  //    collapsed. memoized so a new node each agent tick doesn't defeat
  //    DiffViewer's memo.
  const workingTopButton = useMemo(() => (
    <Tooltip content={paneCollapse === 'inspector' ? `Show diff (${SHORTCUT_DIFF_SIDEBAR})` : 'Hide chat'}>
      <button
        className={PANE_TOGGLE_CLS}
        aria-label={paneCollapse === 'inspector' ? 'Show diff' : 'Hide chat'}
        onClick={paneCollapse === 'inspector' ? toggleInspector : toggleWorking}
      >
        {paneCollapse === 'inspector' ? <PanelRightOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
      </button>
    </Tooltip>
  ), [paneCollapse, toggleInspector, toggleWorking])
  const changesLeadingButton = useMemo(() => (
    <Tooltip content={paneCollapse === 'working' ? 'Show chat' : `Hide diff (${SHORTCUT_DIFF_SIDEBAR})`}>
      <button
        className={PANE_TOGGLE_CLS}
        aria-label={paneCollapse === 'working' ? 'Show chat' : 'Hide diff'}
        onClick={paneCollapse === 'working' ? toggleWorking : toggleInspector}
      >
        {paneCollapse === 'working' ? <PanelLeftOpen className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
      </button>
    </Tooltip>
  ), [paneCollapse, toggleWorking, toggleInspector])
  // Narrow (single-pane) back button: the diff screen slides in over the chat,
  // so its Changes bar leads with a back chevron that slides back to the chat
  // (toggleWorking reveals the working pane). memoized for DiffViewer's memo.
  const narrowBackButton = useMemo(() => (
    <Tooltip content={`Back to chat (${SHORTCUT_DIFF_SIDEBAR})`}>
      <button className={PANE_TOGGLE_CLS} aria-label="Back to chat" onClick={toggleWorking}>
        <ChevronLeft className="w-4 h-4" />
      </button>
    </Tooltip>
  ), [toggleWorking])
  // Left (working) pane's share of the split, persisted like sidebarWidth.
  const [splitRatio, setSplitRatio] = useState(() => loadSplitRatio())
  const splitRatioRef = useRef(splitRatio)
  splitRatioRef.current = splitRatio
  const [splitResizing, setSplitResizing] = useState(false)
  const panesRef = useRef<HTMLDivElement>(null)
  // Hand-rolled divider drag, mirroring handleSidebarResizeStart in __root.tsx.
  const handleSplitResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const cont = panesRef.current
    if (!cont) return
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setSplitResizing(true)
    function onMove(ev: PointerEvent) {
      const rect = cont!.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, (ev.clientX - rect.left) / rect.width))
      splitRatioRef.current = ratio
      setSplitRatio(ratio)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setSplitResizing(false)
      saveSplitRatio(splitRatioRef.current)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [])

  // The relative "created Xs ago" labels update via their own <RelativeTime>
  // leaves (see LiveTime / useNowTick) - each re-renders only itself once a
  // second, instead of a page-wide setInterval re-rendering the whole agent view
  // (diff viewer, terminal, panels) every second. The metadata rows themselves
  // are no longer `live`, so they don't re-render/re-measure on the clock.

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

  // Stable wrappers for the metadata-row handlers so memoizing AgentMetaRow isn't
  // defeated by these functions being re-created each render. Each forwards to the
  // latest closure via a ref, so no stale `agent`/state is captured.
  const saveBaseRef = useRef(saveBase)
  saveBaseRef.current = saveBase
  const saveChatModeRef = useRef(saveChatMode)
  saveChatModeRef.current = saveChatMode
  const saveDownstreamRef = useRef(saveDownstream)
  saveDownstreamRef.current = saveDownstream
  const onSaveBase = useCallback((name: string) => { void saveBaseRef.current(name) }, [])
  const onSaveChatMode = useCallback((next: boolean) => { void saveChatModeRef.current(next) }, [])
  const onSaveDownstream = useCallback((n: string) => { void saveDownstreamRef.current(n) }, [])

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
    // branch + worktree, so every changed file - committed or not - is "lost").
    void (async () => {
      let lostFiles: number | undefined
      try {
        const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
        lostFiles = d.files?.length ?? 0
      } catch { /* ignore - show the dialog without a count */ }
      const dialog = useDialogStore.getState()
      if (dialog.isOpen && dialog.variant === 'kill') dialog.update({ details: { lostFiles, loading: false } })
    })()
  }

  // executeMerge runs the actual merge POST (optionally force, bypassing the test
  // gate - PLAN #68). On a tests_failing/tests_errored 409 from a non-force merge
  // (e.g. a stale verdict that re-ran red), it offers a force-merge follow-up.
  // keepOpen merges with close=false: the agent survives the merge (session,
  // worktree, branch) and keeps working, so instead of navigating away we stay
  // on the page and refresh the diff (which resets to only-unmerged work).
  async function executeMerge(force: boolean, keepOpen = false) {
    setMerging(true)
    // Both toasts render the agent-transition card (bot icon + clickable agent
    // name + status pill), matching the status-update notifications.
    const name = agent.title || agent.id
    const toastId = useToastStore.getState().show({
      message: `Merging agent "${name}" into ${agent.base_branch}...`,
      type: 'info',
      duration: 0,
      agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merging', before: '', after: `into \`${agent.base_branch}\`...` },
    })
    try {
      await api.default.mergeAgent(projectId ?? '', agent.id, force || undefined, !keepOpen)
      useToastStore.getState().dismiss(toastId)
      if (keepOpen) {
        useToastStore.getState().show({
          message: `Agent "${name}" merged into ${agent.base_branch} - still running`,
          type: 'success',
          agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merged', before: '', after: `into \`${agent.base_branch}\` - agent kept running` },
        })
        // Stay on the page: the base branch just absorbed the head's commits, so
        // the diff (base...head) and any artifact comparison need a refetch.
        onRefresh?.()
        setDiffRefreshTrigger((t) => t + 1)
        setArtifactRefreshTrigger((t) => t + 1)
        return
      }
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
        // Surface the same Force / Queue choice dialog the button opens proactively
        // - except for a keep-open merge, where "Queue" (merge-when-green) would
        // merge AND close; offer a force merge-and-continue confirm instead.
        const n = (body as { failing_tests?: number }).failing_tests ?? 0
        if (keepOpen) confirmMergeKeepOpen(true)
        else confirmMergeGate(body.error === 'tests_failing' ? 'failing' : 'errored', n)
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
        : `No passing test verdict for this commit - merging anyway.`,
    })
  }

  // armMerge / cancelMerge toggle "merge when green" (auto-merge).
  async function armMerge() {
    try {
      await api.default.armMergeWhenGreen(projectId ?? '', agent.id)
      // Same agent-transition card as the status-update toasts, but text-only
      // (no status pill - "queued" isn't a status the agent is in yet) and with
      // the emerald "merge queued" Clock in place of the bot tile.
      const name = agent.title || agent.id
      const toBranch = agent.base_branch || 'base'
      useToastStore.getState().show({
        message: `Will merge "${name}" into ${toBranch} when it finishes and its tests pass`,
        type: 'info',
        agentTransition: { agentName: name, agentId: agent.id, projectId: projectId ?? '', icon: 'merge-queued', before: `will merge into \`${toBranch}\` when it finishes and tests pass` },
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
  // of verdict - the soft test gate is enforced server-side (a failing verdict
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
    // Verdict is green (or there are no runners) - nothing else gates the merge,
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
  // Cancel choice - Queue is the natural action here, arming merge-when-green so
  // it lands once the agent is actually done. `blocked` selects the wording.
  function confirmMergeWhileActive(blocked: boolean) {
    const toBranch = agent.base_branch || 'base'
    const fromBranch = agent.branch_name || `hydra/${agent.id}`
    useDialogStore.getState().show({
      title: blocked ? 'Agent is waiting on you' : 'Agent is still running',
      message: blocked
        ? `"${agent.id}" is asking you a question - merging now abandons it and may land incomplete work.`
        : `"${agent.id}" hasn't finished this turn - merging now may capture an incomplete state.`,
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

  // confirmMergeKeepOpen is the "Merge and continue" dropdown action: merge the
  // branch with close=false so the agent keeps running afterwards. The test gate
  // still applies server-side, but the merge-gate dialog's Queue option doesn't
  // fit here (merge-when-green merges AND closes) - so when the verdict is known
  // un-green (or the server just 409'd, forceGate) this offers a single force
  // merge-and-continue confirm with a caution naming what's being overridden.
  // Merging while the agent is still working is the point of this action, so the
  // "agent is still running" warning is deliberately skipped.
  function confirmMergeKeepOpen(forceGate = false) {
    const toBranch = agent.base_branch || 'base'
    const verdict = agent.tests?.status
    const gated = forceGate || verdict === 'failing' || verdict === 'errored' || verdict === 'running'
    if (gated) {
      const n = agent.tests?.failed ?? 0
      const caution = verdict === 'failing'
        ? `${n || 'Some'} failing test${n === 1 ? '' : 's'} will land on ${toBranch}.`
        : verdict === 'running'
          ? `Tests haven't finished on this commit - merging anyway.`
          : `No passing test verdict for this commit - merging anyway.`
      showMergeConfirm({
        force: true,
        keepOpen: true,
        title: `Force merge into ${toBranch} and continue?`,
        confirmLabel: 'Force merge',
        caution,
      })
      return
    }
    showMergeConfirm({ keepOpen: true })
  }

  // showMergeConfirm renders the rich merge dialog (branch chip + diff stats + an
  // optional caution line) - shared by the normal merge, the force-merge override
  // and merge-and-continue so they look identical bar the title/label/caution.
  // `force` bypasses the soft test gate server-side; `keepOpen` merges with
  // close=false (the agent keeps running afterwards).
  function showMergeConfirm(opts: { force?: boolean; keepOpen?: boolean; title?: string; confirmLabel?: string; caution?: string }) {
    const force = opts.force ?? false
    const keepOpen = opts.keepOpen ?? false
    // If this agent is stacked on another agent (its base branch is another
    // agent's branch), the merge advances that parent agent's branch - name it,
    // and warn when the parent is still running since its working files will
    // shift underneath it.
    const parent = useAgentStore.getState().agents.find((a) => a.branch_name === agent.base_branch)
    const fromBranch = agent.branch_name || `hydra/${agent.id}`
    const toBranch = agent.base_branch || 'base'
    const parentWarning = parent && parent.session_status === 'running'
      ? `Parent agent "${parent.id}" is running - merging will change its working files.`
      : undefined
    // Warn before a direct local merge into a branch listed in the [review]
    // protected_branches config (NON_LOCAL_INTEGRATION.md 3.2): the branch is
    // protected on the forge, so the local merge would land commits the server
    // will refuse on push - the MR path is the intended route.
    const reviewCfg = useProjectStore.getState().reviewConfigs[projectId ?? '']
    const protectedWarning = reviewCfg?.protected_branches?.includes(toBranch)
      ? `${toBranch} is a protected branch on the forge - pushing a direct local merge will likely be rejected. Consider a merge request instead.`
      : undefined
    const lead = parent
      ? `Merges this agent’s work into agent "${parent.id}"'s branch (${toBranch})${keepOpen ? ' and keeps the agent running so it can continue from here.' : ' and closes the session.'}`
      : `Merges this agent’s work into ${toBranch}${keepOpen ? ' and keeps the agent running so it can continue from here.' : ' and closes the session.'}`
    // A caller-supplied caution (e.g. failing tests for a force merge) wins over the
    // uncommitted-changes note the background check would otherwise add.
    const caution = opts.caution ?? protectedWarning ?? parentWarning

    // Show the dialog immediately so it never lags behind a slow git query.
    // The diff stats + uncommitted-changes check run in the background and fold
    // into the open dialog when they return.
    useDialogStore.getState().show({
      title: opts.title ?? (keepOpen ? `Merge into ${toBranch} and continue?` : `Merge into ${toBranch}?`),
      message: lead,
      type: caution ? 'warning' : 'confirm',
      variant: 'merge',
      confirmLabel: opts.confirmLabel ?? (keepOpen ? 'Merge and continue' : 'Merge branch'),
      details: { fromBranch, toBranch, note: caution, loading: true },
      onConfirm: () => void executeMerge(force, keepOpen),
    })

    void (async () => {
      let patch: Partial<DialogDetails> = { loading: false }
      try {
        const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
        const additions = d.files.reduce((s, f) => s + (f.additions ?? 0), 0)
        const deletions = d.files.reduce((s, f) => s + (f.deletions ?? 0), 0)
        patch = { ...patch, additions, deletions }
        // Only add the uncommitted-changes note when the caller didn't supply its
        // own caution (which takes priority). A closing merge destroys the
        // worktree, so uncommitted work is lost; a keep-open merge preserves the
        // worktree - the note just clarifies the merge won't include that work.
        if (!caution && d.uncommitted_changes) {
          const total = (d.uncommitted_summary?.tracked_count ?? 0) + (d.uncommitted_summary?.untracked_count ?? 0)
          patch.note = keepOpen
            ? `${total} uncommitted file change${total !== 1 ? 's' : ''} won't be included in the merge.`
            : `${total} uncommitted file change${total !== 1 ? 's' : ''} will be lost when merging.`
        }
      } catch { /* ignore - show the dialog without stats */ }
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
  // re-reading it - navigation alone can't, since the store update lands a render
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
  const shortcutRef = useRef<{ merge: () => void; markUnread: () => void; kill: () => void; rename: () => void; toggleDiffSidebar: () => void; agentId: string; projectId: string | null; busy: boolean; archived: boolean; branch: string }>(null!)
  shortcutRef.current = {
    merge: handleMerge,
    markUnread: handleMarkUnread,
    kill: handleKill,
    rename: startEditingTitle,
    toggleDiffSidebar,
    agentId: agent.id,
    projectId,
    busy: merging || killing,
    archived: !!agent.archived,
    branch: agent.branch_name || '',
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
        // Toggle the diff sidebar (Ctrl+,) - works with the terminal focused, like
        // merge/mark-unread. A no-op when the split layout isn't active.
        if (actionKey === ',') {
          if (dialogOpen) return
          e.preventDefault()
          ctx.toggleDiffSidebar()
          return
        }
      }
      // The remaining shortcuts defer to typing surfaces (form fields, terminal)
      // and to open modals.
      if (isTypingTarget(e.target)) return
      if (dialogOpen) return
      // Rename - F2, no modifier (Windows convention).
      if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (ctx.archived) return
        e.preventDefault()
        ctx.rename()
        return
      }
      // Copy branch name - B, no modifier (GitLab convention). Works for archived
      // agents too; their branch name is still shown even once the branch is gone.
      if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (!ctx.branch) return
        e.preventDefault()
        copyBranchName(ctx.branch)
        return
      }
      // Switch agent - Alt+↑/↓ steps through the live agents list (wrapping).
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
      // Kill - Ctrl+K (Ctrl is hasMod on every platform). Merge/mark-unread are
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

  // Toggling chat mode relaunches the Claude process in the new
  // mode: the backend stops the live session and the pane's reconnect
  // lazy-resumes it with --continue, so the conversation itself is preserved
  // (terminal and chat mode share one transcript). Confirm first when the
  // agent is mid-turn, since the in-flight turn gets cut short.
  async function saveChatMode(next: boolean) {
    if (next === (agent.chat_mode === true) || savingChatMode) return
    const doSave = async () => {
      setSavingChatMode(true)
      const res = await runWithToast(
        () => api.default.updateAgent(projectId ?? '', agent.id, { chat_mode: next }),
        {
          success: next ? 'Switched to chat mode' : 'Switched to terminal mode',
          errorPrefix: 'Failed to switch mode',
        },
      )
      if (res.ok) updateAgentInStore(res.value)
      setSavingChatMode(false)
    }
    if (agent.agent_status?.status === 'running') {
      useDialogStore.getState().show({
        title: next ? 'Switch to chat mode?' : 'Switch to terminal mode?',
        message: 'The agent is mid-turn. Switching modes restarts the Claude process, cutting the current turn short; the conversation itself is preserved.',
        type: 'confirm',
        confirmLabel: 'Switch',
        onConfirm: () => void doSave(),
      })
      return
    }
    await doSave()
  }

  // --- Non-local integration: publish / MR sync (NON_LOCAL_INTEGRATION.md 3.3) ---

  // Fetch the review config once per project (if not already cached) as soon as
  // the head is on screen, so clicking "Create MR" opens the dialog instantly
  // with prefilled values - the fetch no longer gates the popup. Deduped in the
  // store, so this and the root layout's fetch produce a single request.
  useEffect(() => {
    if (projectId && !reviewConfig) void ensureReviewConfig(projectId)
  }, [projectId, reviewConfig])

  // openCreateMR opens the Create MR dialog immediately, refreshing the config
  // in the background rather than blocking the popup on a network round-trip.
  function openCreateMR() {
    setPublishError(null)
    setShowCreateMR(true)
    if (projectId) void refreshReviewConfig(projectId)
  }

  // doPublish runs the publish POST with the dialog's values. A failure is shown
  // inline in the dialog (not a toast) and keeps the dialog open so the values
  // can be fixed and retried; success closes it.
  async function doPublish(body: { downstream_branch: string; remote: string; target_branch: string; title: string; description: string; draft: boolean }) {
    setPublishing(true)
    setPublishError(null)
    try {
      const updated = await api.default.publishAgent(projectId ?? '', agent.id, undefined, body)
      updateAgentInStore(updated)
      useToastStore.getState().show({ message: 'MR published', type: 'success' })
      setShowCreateMR(false)
    } catch (err) {
      setPublishError(formatError(err))
    }
    setPublishing(false)
  }

  // handlePushToMR / handlePullFromMR sync a linked head with its remote branch.
  async function handlePushToMR() {
    setPublishing(true)
    const res = await runWithToast(() => api.default.pushToMr(projectId ?? '', agent.id), {
      success: 'Pushed to MR',
      errorPrefix: 'Push failed',
    })
    if (res.ok) updateAgentInStore(res.value)
    setPublishing(false)
  }

  async function handlePullFromMR() {
    setPublishing(true)
    const res = await runWithToast(() => api.default.pullFromMr(projectId ?? '', agent.id), {
      success: 'Pulled from MR',
      errorPrefix: 'Pull failed',
    })
    if (res.ok) updateAgentInStore(res.value)
    setPublishing(false)
  }

  // saveDownstream edits the head's downstream branch (metadata only; soft-locked
  // after publish - the backend rejects a rename of a linked head).
  async function saveDownstream(next: string) {
    setSavingDownstream(true)
    const res = await runWithToast(() => api.default.setDownstreamBranch(projectId ?? '', agent.id, { downstream_branch: next }), {
      success: `Downstream branch set to ${next}`,
      errorPrefix: 'Failed to set downstream branch',
    })
    if (res.ok) updateAgentInStore(res.value)
    setSavingDownstream(false)
  }

  // armPublish / disarmPublish toggle publish-when-green (auto-open a draft MR /
  // auto-push once local tests pass and the head finishes).
  async function armPublish() {
    await runWithToast(() => api.default.armPublishWhenGreen(projectId ?? '', agent.id), {
      success: 'Publish when green armed',
      errorPrefix: 'Failed to arm',
    })
  }
  async function disarmPublish() {
    await runWithToast(() => api.default.disarmPublishWhenGreen(projectId ?? '', agent.id), {
      success: 'Publish when green disarmed',
      errorPrefix: 'Failed to disarm',
    })
  }

  // respondToReview sends the agent a one-line canned prompt to fetch and address
  // its MR's unresolved review comments (via the mcp__hydra__* tools) - the same
  // agent-pull pattern as the diff viewer's "Fix the merge conflicts" action
  // (NON_LOCAL_INTEGRATION.md 3.5). Data is fetched by the agent when it reads,
  // so it is fresh at that moment, not at click time.
  async function respondToReview() {
    await runWithToast(
      () => api.default.sendAgentInput(projectId ?? '', agent.id, { text: "Fetch your MR's unresolved review comments with the hydra MCP tools (get_review_comments) and address them, then commit." }),
      { success: 'Asked the agent to address review comments', errorPrefix: 'Failed to send' },
    )
  }

  // Archived agents are read-only: render the history view instead of the live
  // terminal/diff. Placed after all hooks above so hook order stays stable when
  // the same mounted component switches between a live and an archived agent.
  if (agent.archived) {
    return <ArchivedAgentDetail agent={agent} projectId={projectId} onPurged={onKilled} />
  }

  // The merge button (PLAN #68) has three states:
  //  • merging  - a quiet, inert "Merging..." button (in-flight, spinner).
  //  • armed    - the green "Merges when tests pass" pill with its own Cancel button.
  //  • resting  - the emerald "Merge" split button; the verdict-specific overrides
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
        label: 'Merging...',
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
          icon: <GitPullRequestArrow className="w-4 h-4" />,
          onClick: handleMerge,
          variant: 'primary',
          disabled: busy,
          shortcut: SHORTCUT_MERGE,
          menu: ([
            { label: 'Merge and continue', description: `Merge into ${toBranch} but keep the agent running.`, icon: <GitPullRequestArrow className="w-4 h-4" />, onClick: () => confirmMergeKeepOpen(), tone: 'emerald', disabled: busy },
            { label: 'Force merge', description: `Merge this commit to ${toBranch} right now.`, icon: <AlertTriangle className="w-4 h-4" />, onClick: forceMerge, danger: true, tone: 'red', disabled: busy },
            { label: 'Queue merge', description: 'Merges on its own once tests pass.', icon: <Clock className="w-4 h-4" />, onClick: () => void armMerge(), tone: 'emerald', disabled: busy },
          ] as AgentTopBarMenuItem[]),
        }

  // publishAction is the Create MR / View MR button (NON_LOCAL_INTEGRATION.md 3.3).
  // Unlinked: "Create MR" opens the dialog. Linked: "View MR" deep-links to the
  // forge, with Push to MR / Pull from MR in its dropdown (shown by ahead/behind).
  const linked = !!agent.review
  const ahead = agent.review?.ahead ?? 0
  const behind = agent.review?.behind ?? 0
  const publishAction: AgentTopBarAction = publishing
    ? { label: 'Publishing...', icon: <LoaderCircle className="w-4 h-4 animate-spin" />, onClick: () => {}, variant: 'muted' }
    : linked
      ? {
          label: 'View MR',
          icon: <ProviderIcon provider={agent.review?.provider} className="w-4 h-4" />,
          onClick: () => window.open(agent.review!.url, '_blank', 'noreferrer'),
          variant: 'segment',
          menu: [
            ...(ahead > 0 ? [{ label: `Push to MR (${ahead} ahead)`, description: 'Push local commits to the MR branch.', icon: <Upload className="w-4 h-4" />, onClick: () => void handlePushToMR(), tone: 'emerald' as const, disabled: busy || publishing }] : []),
            ...(behind > 0 ? [{ label: `Pull from MR (${behind} behind)`, description: 'Merge the remote MR branch into this head.', icon: <Download className="w-4 h-4" />, onClick: () => void handlePullFromMR(), tone: 'neutral' as const, disabled: busy || publishing }] : []),
            { label: 'Push to MR', description: 'Push the local head branch again (idempotent).', icon: <Upload className="w-4 h-4" />, onClick: () => void handlePushToMR(), tone: 'emerald' as const, disabled: busy || publishing },
            ...((agent.review?.state?.unresolved_discussions ?? 0) > 0 ? [{ label: 'Respond to review comments', description: 'Ask the agent to fetch and address the unresolved review comments.', icon: <MessageSquare className="w-4 h-4" />, onClick: () => void respondToReview(), tone: 'neutral' as const, disabled: busy }] : []),
          ] as AgentTopBarMenuItem[],
        }
      : {
          label: 'Create MR',
          icon: <MRIcon linked={false} className="w-4 h-4" />,
          onClick: () => void openCreateMR(),
          variant: 'blue',
          disabled: busy || publishing,
          menu: [
            agent.publish_when_green
              ? { label: 'Disarm publish-when-green', description: 'Stop auto-opening a draft MR when tests pass.', icon: <Clock className="w-4 h-4" />, onClick: () => void disarmPublish(), tone: 'neutral' as const, disabled: busy }
              : { label: 'Publish when green', description: 'Auto-open a draft MR once local tests pass and the head finishes.', icon: <Clock className="w-4 h-4" />, onClick: () => void armPublish(), tone: 'emerald' as const, disabled: busy || publishing },
          ] as AgentTopBarMenuItem[],
        }
  // Create MR (blue) always leads, to the left of Merge; once linked it becomes
  // the View-MR button, still first.
  const mrFirst = true

  // The agent header is a single header bar (no separate H1): the name with an
  // actions dropdown (Rename / Merge / Kill - clicking the name also renames it
  // inline) and a status dot. While the sidebar is collapsed it also hosts the
  // show-sidebar toggle. It sits above the scroll area so it never collides with
  // the diff's own sticky "Changes" header. On the narrow screen-stack it rides
  // INSIDE the chat screen (not above the whole track), so the diff screen's own
  // Changes bar is its top-level header - back button top-left, no agent status.
  const agentTopBar = (
    <AgentTopBar
      title={agent.title || agent.id}
        // Status cluster next to the name: the dot, the status pill, and the test
        // verdict - pulled out of the metadata row to declutter it (image 13/14).
        statusDot={
          <>
            <span className={`block w-2.5 h-2.5 rounded-full ${agentDotClass(agent)} ${agentDotAnimate(agent)}`} />
            {/* Status pill moved back to the metadata row (after the agent-type
                chip); the header keeps just the dot + test verdict. */}
            {agent.tests && agent.tests.status !== 'none' && (
              <TestVerdictChip tests={agent.tests} variant="sm" />
            )}
          </>
        }
        rename={{
          editing: editingTitle,
          draft: titleDraft,
          saving: savingTitle,
          onStart: startEditingTitle,
          onChange: setTitleDraft,
          onSave: saveTitle,
          onCancel: () => setEditingTitle(false),
        }}
        // Narrow only: the single pane flips between the working view and a
        // full-screen diff (Ctrl+, does the same). On a wide split this toggle
        // moves to the two buttons flanking the divider (see workingTopButton /
        // changesLeadingButton below).
        rightSlot={
          narrowSplit ? (
            <IconButton
              variant="panel"
              aria-label={diffShown ? 'Show chat' : 'Show diff'}
              title={`${diffShown ? 'Show chat' : 'Show diff'} (${SHORTCUT_DIFF_SIDEBAR})`}
              onClick={toggleDiffSidebar}
            >
              {diffShown ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
            </IconButton>
          ) : undefined
        }
        actions={[
          ...(mrFirst ? [publishAction, mergeAction] : [mergeAction, publishAction]),
          { label: 'Mark as unread', icon: <Mail className="w-4 h-4" />, onClick: handleMarkUnread, variant: 'segment', shortcut: SHORTCUT_MARK_UNREAD },
          { label: 'Rename', icon: <Pencil className="w-4 h-4" />, onClick: startEditingTitle, variant: 'segment', shortcut: SHORTCUT_RENAME },
          { label: 'Kill', icon: <Trash2 className="w-4 h-4" />, onClick: handleKill, variant: 'danger', disabled: merging || killing, shortcut: SHORTCUT_KILL },
        ]}
      />
  )

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {showCreateMR && (
        <CreateMRDialog
          agent={agent}
          config={reviewConfig}
          remotes={remotes}
          submitting={publishing}
          error={publishError}
          onConfirm={(body) => void doPublish(body)}
          onCancel={() => setShowCreateMR(false)}
        />
      )}
      {/* Narrow (screen-stack) hosts the top bar inside the chat screen instead,
          so the diff screen's Changes bar is its own top-level header. */}
      {!narrowSplit && agentTopBar}
      {splitActive ? (
        // ── Two-pane split ──────────────────────────────────────────────────
        // Left: metadata + collapsible prompt + terminal/chat filling the height.
        // Right: the inspector pane (diff / tests / previews). A hand-rolled
        // divider between them, plus the three collapse states from paneCollapse.
        // The panes' widths animate (width transition) so collapsing/expanding the
        // inspector glides; the transition is suppressed mid-drag so resizing stays
        // snappy. The working pane stays mounted while the inspector collapses (so
        // its terminal never hits a 0-width relayout); "Diff only" (working
        // collapsed) unmounts it instead - that transition isn't animated.
        <div ref={panesRef} className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
          {paneCollapse !== 'working' && (
            <div
              className="flex flex-col min-h-0 overflow-hidden shrink-0"
              style={{
                width: paneCollapse === 'inspector' ? '100%' : `calc(${(splitRatio * 100).toFixed(4)}% - 6px)`,
                transition: splitResizing ? undefined : 'width 240ms ease',
              }}
            >
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden px-3 sm:px-4 pt-4 pb-4 gap-3">
                <div className="shrink-0 flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <AgentMetaRow
                      agent={agent}
                      agentTypeClass={agentTypeClass}
                      branches={branches}
                      savingBase={savingBase}
                      savingChatMode={savingChatMode}
                      savingDownstream={savingDownstream}
                      onSaveBase={onSaveBase}
                      onRefreshBranches={refreshBranches}
                      onSaveChatMode={onSaveChatMode}
                      onSaveDownstream={onSaveDownstream}
                    />
                  </div>
                  {/* Hide-chat toggle, inline at the metadata row's right (no header
                      box - it must not push the metadata chips down). */}
                  {workingTopButton}
                </div>
                {/* Prompt collapsed by default (terminal mode only) - chat heads
                    replay the task as the first chat message. */}
                {agent.prompt && agent.chat_mode !== true && (
                  <CollapsiblePrompt prompt={agent.prompt} projectId={projectId} agentId={agent.id} />
                )}
                <AgentTerminal
                  agentId={agent.id}
                  projectId={projectId}
                  isEphemeral={agent.ephemeral}
                  chatMode={agent.chat_mode === true}
                  fill
                  onRefresh={onRefresh}
                  onDiffRefresh={handleDiffRefresh}
                />
              </div>
            </div>
          )}
          {/* Draggable divider - kept mounted but width-collapsed off the full
              split so the pane widths add up cleanly and animate. */}
          <div
            onPointerDown={paneCollapse === 'none' ? handleSplitResizeStart : undefined}
            className={`group shrink-0 flex items-center justify-center overflow-hidden ${paneCollapse === 'none' ? 'cursor-ew-resize touch-none border-x-1 border-gray-200 dark:border-gray-800' : ''}`}
            style={{ width: paneCollapse === 'none' ? 12 : 0, transition: splitResizing ? undefined : 'width 240ms ease' }}
            title={paneCollapse === 'none' ? 'Drag to resize' : undefined}
          >
            <div className="w-1 h-20 rounded-full bg-gray-200 dark:bg-gray-600 group-hover:bg-blue-400/70 group-active:bg-blue-500 transition-colors" />
          </div>
          <div
            className="flex flex-col min-w-0 min-h-0 overflow-hidden shrink-0"
            style={{
              width: paneCollapse === 'inspector' ? '0px' : paneCollapse === 'working' ? '100%' : `calc(${((1 - splitRatio) * 100).toFixed(4)}% - 6px)`,
              transition: splitResizing ? undefined : 'width 240ms ease',
            }}
          >
            <InspectorPane
              agent={agent}
              projectId={projectId}
              externalRefreshTrigger={diffRefreshTrigger}
              externalArtifactRefresh={artifactRefreshTrigger}
              changesLeading={changesLeadingButton}
            />
          </div>
          {/* Transparent overlay during the divider drag so the pointer isn't
              swallowed by the xterm/iframe (gotcha #5). */}
          {splitResizing && <div className="fixed inset-0 z-[200] cursor-col-resize" />}
        </div>
      ) : narrowSplit ? (
        // ── Narrow single-pane "screen stack" (split on, no room for two) ────
        // The chat and the diff are two full-screen screens on a horizontal
        // track: the diff slides in over the chat when diffShown (the top-bar
        // toggle / Ctrl+, / the diff's own back chevron flip paneCollapse
        // between 'none'/'working'). Both stay mounted so the swap is a real
        // slide - no remount, so the terminal/chat never resets - and the diff's
        // Changes bar leads with a back button (narrowBackButton).
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <div
            className="flex h-full w-[200%]"
            style={{
              transform: diffShown ? 'translateX(-50%)' : 'translateX(0)',
              transition: 'transform 300ms ease',
            }}
          >
            <div className="w-1/2 flex flex-col min-h-0 overflow-hidden">
              {agentTopBar}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden px-3 sm:px-4 pt-4 pb-4 gap-3">
              <div className="shrink-0">
                <AgentMetaRow
                  agent={agent}
                  agentTypeClass={agentTypeClass}
                  branches={branches}
                  savingBase={savingBase}
                  savingChatMode={savingChatMode}
                  savingDownstream={savingDownstream}
                  onSaveBase={onSaveBase}
                  onRefreshBranches={refreshBranches}
                  onSaveChatMode={onSaveChatMode}
                  onSaveDownstream={onSaveDownstream}
                />
              </div>
              {agent.prompt && agent.chat_mode !== true && (
                <CollapsiblePrompt prompt={agent.prompt} projectId={projectId} agentId={agent.id} />
              )}
              <AgentTerminal
                agentId={agent.id}
                projectId={projectId}
                isEphemeral={agent.ephemeral}
                chatMode={agent.chat_mode === true}
                fill
                onRefresh={onRefresh}
                onDiffRefresh={handleDiffRefresh}
              />
              </div>
            </div>
            <div className="w-1/2 flex flex-col min-w-0 min-h-0 overflow-hidden">
              <InspectorPane
                agent={agent}
                projectId={projectId}
                changesLeading={narrowBackButton}
                leadingInline
                externalRefreshTrigger={diffRefreshTrigger}
                externalArtifactRefresh={artifactRefreshTrigger}
              />
            </div>
          </div>
        </div>
      ) : (
        // ── Classic single-column stacked layout (flag off, or archived) ─────
        // pt-4 (16px) above the metadata row matches the effective gap below it
        // (its mb-6 minus the prompt block's -mt-2), so it sits evenly spaced.
        <div ref={scrollRef} className="flex-1 flex flex-col overflow-auto px-3 sm:px-6 pb-3 sm:pb-6 pt-4 min-w-0 min-h-0" data-main-scroll>
          <div className="w-full">
            <div className="mb-6">
              <AgentMetaRow
                agent={agent}
                agentTypeClass={agentTypeClass}
                branches={branches}
                savingBase={savingBase}
                savingChatMode={savingChatMode}
                savingDownstream={savingDownstream}
                onSaveBase={onSaveBase}
                onRefreshBranches={refreshBranches}
                onSaveChatMode={onSaveChatMode}
                onSaveDownstream={onSaveDownstream}
              />
            </div>
            {agent.prompt && agent.chat_mode !== true && <PromptBlock prompt={agent.prompt} projectId={projectId} />}
            <AgentTerminal
              agentId={agent.id}
              projectId={projectId}
              isEphemeral={agent.ephemeral}
              chatMode={agent.chat_mode === true}
              onRefresh={onRefresh}
              onDiffRefresh={handleDiffRefresh}
            />
            <DiffViewer agent={agent} projectId={projectId} externalRefreshTrigger={diffRefreshTrigger} externalArtifactRefresh={artifactRefreshTrigger} />
          </div>
        </div>
      )}
    </div>
  )
}
