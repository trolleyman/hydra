import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, type ReactNode } from 'react'
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
import { TrackBranchButton } from './TrackBranchButton'
import { copyBranchName } from '../lib/branch'
import { SeparatedRow } from './SeparatedRow'
import { AgentTopBarContent, type AgentTopBarAction, type AgentTopBarMenuItem } from './AgentTopBar'
import { TopBarPortal } from './TopBarPortal'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { uploadBlobUrl } from '../api/uploads'
import type { Attachment } from '../lib/spawnDrafts'
import { agentStatusBadge, agentStatusHelp, archivedEndStateBadge, agentDotClass, agentDotAnimate, agentTypePill, agentTypeLabel } from '../lib/agentDisplay'
import { agentTransitionToast } from '../lib/agentToast'
import { LoaderCircle, GitPullRequestArrow, Trash2, RotateCcw, Pencil, TerminalSquare, Mail, ShieldAlert, ShieldCheck, ShieldOff, Lock, AlertTriangle, Clock, FileDiff, Upload, Download, MessageSquare, ChevronRight, ChevronLeft, PanelRightOpen, PanelRightClose, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { InspectorPane } from './InspectorPane'
import { ResizeGrip } from './ResizeGrip'
import { usePaneCollapseStore, useMediaQuery, SPLIT_QUERY, loadSplitRatio, saveSplitRatio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX } from '../lib/layout'
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
  // The chip clicked, so the picture flies out of it instead of fading in.
  const [lightboxOrigin, setLightboxOrigin] = useState<Element | null>(null)
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  return (
    <>
      {text && <Markdown text={text} className="text-sm text-gray-800 dark:text-gray-200" />}
      <AttachmentChips
        attachments={attachments}
        size="md"
        className={text ? 'mt-3' : ''}
        onOpenImage={(id, origin) => {
          setLightboxOrigin(origin)
          setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))
        }}
      />
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          index={Math.min(lightboxIndex, lightboxImages.length - 1)}
          origin={lightboxOrigin}
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
      {/* The archived agent's slice of the global top bar (portalled into
          __root's slot): the name + a delete action, and a dim status dot. */}
      <TopBarPortal>
        <AgentTopBarContent
          title={agent.title || agent.id}
          statusDot={<span className="block w-2.5 h-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />}
          actions={[
            { label: 'Delete permanently', icon: <Trash2 className="w-4 h-4" />, onClick: handlePurge, danger: true, disabled: purging },
          ]}
        />
      </TopBarPortal>
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

// NetworkEnforcementBadge shows a live head's egress posture (docs/security-audit.md rec 3):
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
      <Tooltip content="Cancel the queued merge" side="bottom">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-white dark:bg-[#141a26] text-gray-600 dark:text-gray-200 border border-emerald-200/80 dark:border-emerald-800/60 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </Tooltip>
    </div>
  )
}

// MetaStrip is the chip row's container. On md+ it wraps to multiple lines
// (plenty of room, and a visible scrollbar there read badly); below md it's a
// single horizontally scrollable line with edge fades hinting at overflowing
// content on either side.
function MetaStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ left: false, right: false })
  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', update, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [update])
  // Chips come and go with agent state (scrollWidth changes without the element
  // resizing), so re-measure after every render of the row.
  useEffect(() => {
    update()
  })
  return (
    <div data-meta-strip className="relative min-w-0">
      <div
        ref={ref}
        className="flex items-center gap-2 min-w-0 md:flex-wrap md:gap-y-1.5 max-md:overflow-x-auto max-md:whitespace-nowrap max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {fade.left && (
        <div aria-hidden className="md:hidden pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-gray-50 dark:from-gray-900 to-transparent" />
      )}
      {fade.right && (
        <div aria-hidden className="md:hidden pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-gray-50 dark:from-gray-900 to-transparent" />
      )}
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
  // Icon-only: the shield color/glyph carries the signal at a glance; the label
  // and full explanation live in the tooltip (row real estate is precious).
  return (
    <Tooltip variant="card" title={`Network access - ${c.label}`} content={c.tip} className="shrink-0">
      {/* min-h-5 matches the text chips' height (text-xs line + py-0.5) - an
          icon-only chip would otherwise sit a few px shorter than its
          neighbours. */}
      <Badge className={c.className} containerClassName="min-h-5" icon={<c.Icon className="w-3 h-3 shrink-0" />}>{null}</Badge>
    </Tooltip>
  )
}

// GitIsolationBadge sits just right of the network badge and marks a head whose
// .git is locked down. Only shown for readonly (off is the default and needs no
// signal), mirroring the network badge's icon-only chip + card tooltip.
function GitIsolationBadge({ mode }: { mode?: string }) {
  if (mode !== 'readonly') return null
  return (
    <Tooltip
      variant="card"
      title="Git access - .git read-only"
      content="This head's .git is bound read-only in the sandbox, so the agent cannot write it - no in-sandbox commit, add, stash, or object destruction, and it cannot damage the main repo or a sibling head. Commits are staged and made host-side (the git_commit tool) onto the head's own branch."
      className="shrink-0"
    >
      <Badge
        className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
        containerClassName="min-h-5"
        icon={<Lock className="w-3 h-3 shrink-0" />}
      >{null}</Badge>
    </Tooltip>
  )
}

// AgentStatusChip is the head's live status badge with an explainer behind it:
// the labels are short and internal ("needs_input", "waiting", "errored"), so the
// chip says WHICH state and the card says what that state means and what it wants
// from you. A card (not a hint): it's a sentence you're meant to read, it opens
// instantly, and it can be pinned open by clicking - the only way to read it on a
// touch device. An unmapped status has no prose, so it stays a bare chip rather
// than opening an empty box. No card heading: it would be the status word, which
// the chip an inch above the card already says.
function AgentStatusChip({ status }: { status: string }) {
  const badge = agentStatusBadge(status)
  const help = agentStatusHelp(status)
  const chip = <Badge className={badge.className} containerClassName="shrink-0">{badge.label}</Badge>
  if (!help) return chip
  return (
    <Tooltip variant="card" width={300} content={help} className="shrink-0">
      {/* The chip is a plain span, so the card needs a focusable trigger of its
          own for keyboard parity (Tooltip only opens a card on focus-visible). */}
      <button type="button" aria-label={`What "${badge.label}" means`} className="inline-flex cursor-help rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50">
        {chip}
      </button>
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
    // Read by the status pill + test verdict chip.
    agent_status: a.agent_status,
    tests: a.tests,
    network_enforcement: a.network_enforcement,
    git_isolation: a.git_isolation,
    branch_name: a.branch_name,
    base_branch: a.base_branch,
    chat_mode: a.chat_mode,
    created_at: a.created_at,
    // Read by the DownstreamBranchEditor + MRStateChip children.
    downstream_branch: a.downstream_branch,
    review: a.review,
  }
}

// Whether the head's identity line (its id + "created X ago") sits ABOVE the
// chip strip or below it. Above reads better: the id is the head's NAME, so it
// belongs where a title goes, with the chips as the detail line under it - the
// other way round leaves the id looking orphaned at the bottom of the block.
// Flip this to compare the two.
const IDENTITY_LINE_FIRST = true

// The agent-page metadata row: two lines. The identity line carries what the head
// IS and is DOING - the agent-type pill, the status chip and the head id - plus a
// self-ticking "created X ago", right-aligned; the chip strip under it carries the
// configuration: test verdict, network + git-isolation tags, base-branch selector,
// terminal/chat toggle, downstream editor and MR chip. Memoized (see
// metaRowSignature) so a running head's constant refreshes don't churn it; the
// handlers are stabilized by the caller so only real display changes get through.
const AgentMetaRow = memo(function AgentMetaRow({
  agent,
  projectId,
  agentTypeClass,
  branches,
  savingBase,
  savingChatMode,
  savingDownstream,
  publishing,
  onSaveBase,
  onRefreshBranches,
  onSaveChatMode,
  onSaveDownstream,
  onPushToMR,
  onPullFromMR,
}: {
  agent: AgentResponse
  projectId: string | null
  agentTypeClass: string
  branches: RepositoryBranch[] | null
  savingBase: boolean
  savingChatMode: boolean
  savingDownstream: boolean
  publishing: boolean
  onSaveBase: (name: string) => void
  onRefreshBranches: () => void
  onSaveChatMode: (next: boolean) => void
  onSaveDownstream: (n: string) => void
  onPushToMR: () => void
  onPullFromMR: () => void
}) {
  // Confirm before flipping the terminal/chat mode - switching restarts the
  // Claude process, so an accidental tap on the pill shouldn't do it silently.
  const confirmChatMode = (next: boolean) => {
    if ((agent.chat_mode === true) === next) return
    useDialogStore.getState().show({
      title: next ? 'Switch to chat?' : 'Switch to terminal?',
      message: 'This restarts the Claude process in the new mode. The conversation is preserved.',
      type: 'confirm',
      showCancel: true,
      confirmLabel: next ? 'Switch to chat' : 'Switch to terminal',
      onConfirm: () => onSaveChatMode(next),
    })
  }
  // The head's own line: its id (the branch minus the `hydra/` prefix - the
  // prefix is on every head, so it's noise) on the left, and how long ago it was
  // created on the right. The full branch name is still what the copy button
  // (and the title on hover) gives you.
  const headId = agent.branch_name?.replace(/^hydra\//, '') || agent.id
  const identityLine = (
    // min-h-7 (the height of the pane's collapse toggle, and of the inspector
    // bar's "Changes" row across the divider) so this line's contents centre on
    // the same baseline as both - the toolbar rows line up across the split.
    <div className="flex items-center gap-2 min-w-0 min-h-7">
      {/* What this head IS (agent type) and what it is DOING (status), leading the
          head's own name. They were the first two chips of the strip below, but
          they answer the question you ask first, so they belong on the identity
          line - the strip under it is configuration (network, git, base branch,
          MR), which you read second. */}
      <Tooltip content={agentTypeLabel(agent.agent_type)} className="shrink-0">
        {/* min-h-5 keeps the icon-only pill the same height as text chips. */}
        <Badge
          variant="pill"
          className={agentTypeClass}
          containerClassName="min-h-5"
          icon={<AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />}
        >{null}</Badge>
      </Tooltip>
      {agent.agent_status && <AgentStatusChip status={agent.agent_status.status} />}
      {agent.branch_name && (
        <BranchTag
          branch={agent.branch_name}
          label={headId}
          icon={false}
          className="ml-1 text-sm font-mono text-gray-700 dark:text-gray-200"
        />
      )}
      {agent.created_at !== 0 && agent.created_at !== undefined && (
        // ml-auto: pinned to the right edge of the row, whatever is on the left.
        <span className="ml-auto shrink-0 text-xs text-gray-400 dark:text-gray-500">
          created <RelativeTime createdAt={agent.created_at} />
        </span>
      )}
    </div>
  )
  const chipLine = (
    // The chip strip: no interpunct separators; wraps on desktop, scrolls on
    // mobile (see MetaStrip). Dropdown children (the base selector) are
    // portalled, so the mobile overflow clipping can't swallow them.
    <MetaStrip>
      {/* Test verdict leads the strip - the agent type + status chips it used to
          follow now sit on the identity line above. shrink-0 wrappers throughout:
          several chips have min-w-0/truncate internals for wrapping rows, which
          would otherwise absorb ALL the shrink in this nowrap row and collapse
          to their icons - the strip must scroll instead. */}
      {agent.tests && agent.tests.status !== 'none' && (
        <span className="shrink-0 inline-flex">
          <TestVerdictChip tests={agent.tests} variant="sm" />
        </span>
      )}
      {agent.network_enforcement && <NetworkEnforcementBadge mode={agent.network_enforcement} />}
      {agent.git_isolation && <GitIsolationBadge mode={agent.git_isolation} />}
      {projectId && agent.branch_name && !agent.archived && (
        <span className="shrink-0"><TrackBranchButton projectId={projectId} agentId={agent.id} /></span>
      )}
      {/* The base branch this head merges into / diffs against. The head's own
          branch lives on the identity line above, so there's no arrow pairing
          the two here. Editing the base is metadata-only: it changes what
          update-from-base merges in and what the diff compares against, but
          does not rebase commits. */}
      <span className="shrink-0 text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1">
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
      {/* Downstream branch (the name this head is pushed AS) - editable
          until first publish, then soft-locked. Only shown once set.
          empty:hidden on both wrappers below: their child renders nothing for a
          head with no downstream branch / no linked MR, and a zero-width span
          still eats the row's gap on either side of it - 16px that pushed the
          terminal/chat toggle onto a line of its own. */}
      <span className="shrink-0 inline-flex items-center empty:hidden">
        <DownstreamBranchEditor agent={agent} onSave={(n) => onSaveDownstream(n)} saving={savingDownstream} />
      </span>
      {/* Linked-MR state chip (state/CI/approvals/discussions/ahead-behind). The
          ahead/behind chips are the click target for Push/Pull to MR, so a commit
          made after the MR opened is both visible and actionable here rather than
          only inside the View MR dropdown. */}
      <span className="shrink-0 inline-flex items-center gap-1.5 empty:hidden">
        <MRStateChip agent={agent} onPush={onPushToMR} onPull={onPullFromMR} busy={publishing} />
      </span>
      {/* Terminal/chat mode toggle for agents with structured chat transports.
          A confirmation prevents an accidental process restart. */}
      {(agent.agent_type === 'claude' || agent.agent_type === 'codex') && !agent.archived && (
        <Tooltip
          content="How this head is driven: a terminal or a chat view. Switching restarts the agent process; the conversation is preserved."
          className="shrink-0"
        >
          <span className="inline-flex items-center overflow-hidden rounded-full border border-gray-300 dark:border-gray-600 text-xs font-mono">
            {savingChatMode ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 text-gray-500 dark:text-gray-400">
                <LoaderCircle className="w-3 h-3 animate-spin" />
                switching
              </span>
            ) : (
              <>
                <button
                  onClick={() => confirmChatMode(false)}
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
                  onClick={() => confirmChatMode(true)}
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
        </Tooltip>
      )}
    </MetaStrip>
  )
  return (
    // Two lines: the head's identity + age, and the chip strip. Which one comes
    // first is IDENTITY_LINE_FIRST below.
    <div className="flex flex-col gap-1.5 min-w-0">
      {IDENTITY_LINE_FIRST ? identityLine : chipLine}
      {IDENTITY_LINE_FIRST ? chipLine : identityLine}
    </div>
  )
}, (prev, next) =>
  prev.agentTypeClass === next.agentTypeClass &&
  prev.branches === next.branches &&
  prev.savingBase === next.savingBase &&
  prev.savingChatMode === next.savingChatMode &&
  prev.savingDownstream === next.savingDownstream &&
  prev.publishing === next.publishing &&
  prev.onSaveBase === next.onSaveBase &&
  prev.onRefreshBranches === next.onRefreshBranches &&
  prev.onSaveChatMode === next.onSaveChatMode &&
  prev.onSaveDownstream === next.onSaveDownstream &&
  prev.onPushToMR === next.onPushToMR &&
  prev.onPullFromMR === next.onPullFromMR &&
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
  const [restarting, setRestarting] = useState(false)
  // Bumped after a successful process restart to tell AgentTerminal to reconnect
  // its agent tab onto the fresh session.
  const [restartSignal, setRestartSignal] = useState(0)
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
  const [generatingTitle, setGeneratingTitle] = useState(false)
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
  // ── Two-pane split layout ──────────────────────────────────────────────────
  // On a WIDE viewport it's the real two-pane split (working pane +
  // diff/inspector pane, divider between). On a NARROW viewport there's no room
  // for two panes, so it degrades to a single pane that the diff-sidebar toggle
  // flips between the working view and a full-screen diff. The pane-collapse
  // store holds the shared state (none / inspector-hidden / working-hidden).
  const isWide = useMediaQuery(SPLIT_QUERY)
  const paneCollapse = usePaneCollapseStore((s) => s.collapse)
  const toggleInspector = usePaneCollapseStore((s) => s.toggleInspector)
  const toggleWorking = usePaneCollapseStore((s) => s.toggleWorking)
  // Is the diff currently on screen? Wide: the inspector pane isn't collapsed.
  // Narrow: the single pane is showing the full-screen diff (working collapsed).
  const diffShown = isWide ? paneCollapse !== 'inspector' : paneCollapse === 'working'
  // The diff-sidebar toggle (top bar + Ctrl+,): wide hides/shows the inspector
  // pane; narrow flips the single pane between working and full-screen diff.
  const toggleDiffSidebar = useCallback(() => {
    if (isWide) toggleInspector()
    else toggleWorking()
  }, [isWide, toggleInspector, toggleWorking])
  // A commit chip clicked in the chat transcript: point the diff viewer at just
  // that commit (nonce makes re-clicking the same chip re-apply) and make sure
  // the diff is on screen - wide: un-collapse the inspector pane; narrow: slide
  // the full-screen diff over the chat. Stable identity (state read via the
  // store/ref) so it never breaks the memo'd AgentTerminal.
  const [commitSelect, setCommitSelect] = useState<{ sha: string; nonce: number } | null>(null)
  const isWideRef = useRef(isWide)
  isWideRef.current = isWide
  const handleSelectCommit = useCallback((sha: string) => {
    setCommitSelect((prev) => ({ sha, nonce: (prev?.nonce ?? 0) + 1 }))
    const store = usePaneCollapseStore.getState()
    if (isWideRef.current) {
      if (store.collapse === 'inspector') store.setCollapse('none')
    } else if (store.collapse !== 'working') {
      store.setCollapse('working')
    }
  }, [])
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
  // Pixel width of the panes container - the working pane's inner content is
  // pinned to a fixed pixel width during its collapse/reveal animation, and
  // that width is derived from this.
  const [panesW, setPanesW] = useState(0)
  useLayoutEffect(() => {
    if (!isWide) return
    const el = panesRef.current
    if (!el) return
    const update = () => setPanesW(el.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isWide])
  // True while the working pane is animating back open from "Diff only": its
  // inner content must stay at the fixed target width until the outer width
  // tween lands, or the terminal would relayout through near-zero widths.
  const [workingRevealing, setWorkingRevealing] = useState(false)
  const prevPaneCollapseRef = useRef(paneCollapse)
  useEffect(() => {
    if (prevPaneCollapseRef.current === 'working' && paneCollapse !== 'working') setWorkingRevealing(true)
    prevPaneCollapseRef.current = paneCollapse
  }, [paneCollapse])
  useEffect(() => {
    if (!workingRevealing) return
    // Matches the 240ms width tween (with a little slack).
    const t = setTimeout(() => setWorkingRevealing(false), 300)
    return () => clearTimeout(t)
  }, [workingRevealing])
  const paneTransition = splitResizing ? undefined : 'width 240ms ease'
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

  // Clear the cached branch list when the project changes, during render (the
  // previous-key idiom) rather than synchronously in the effect below - so switching
  // project doesn't briefly show the old project's branches, without a cascading
  // effect render. The effect then only kicks off the (async) refetch.
  const [branchesProject, setBranchesProject] = useState(projectId)
  if (branchesProject !== projectId) {
    setBranchesProject(projectId)
    setBranches(null)
  }
  useEffect(() => {
    // Legitimate load-on-mount/project-change: refreshBranches only sets state after
    // its await, so this isn't a synchronous cascading render. It's a shared
    // useCallback (also the manual "refresh branches" action), so it can't be inlined
    // to make that async boundary visible to the rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshBranches()
  }, [refreshBranches])

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
  const pushToMRRef = useRef(handlePushToMR)
  pushToMRRef.current = handlePushToMR
  const pullFromMRRef = useRef(handlePullFromMR)
  pullFromMRRef.current = handlePullFromMR
  const onSaveBase = useCallback((name: string) => { void saveBaseRef.current(name) }, [])
  const onSaveChatMode = useCallback((next: boolean) => { void saveChatModeRef.current(next) }, [])
  const onSaveDownstream = useCallback((n: string) => { void saveDownstreamRef.current(n) }, [])
  const onPushToMR = useCallback(() => { void pushToMRRef.current() }, [])
  const onPullFromMR = useCallback(() => { void pullFromMRRef.current() }, [])

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
          useToastStore.getState().show({
            type: 'info',
            ...agentTransitionToast({ agentName: agent.title || agent.id, agentId: agent.id, projectId: projectId ?? '', status: 'killed', before: '' }),
          })
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

  // handleRestart restarts just the agent's CLI process (claude/codex/...): it
  // stops the running process and relaunches it in a fresh sandbox, resuming the
  // same conversation. The worktree, branch and diff are untouched - this is not
  // Kill. On success we bump restartSignal so the terminal reconnects onto the
  // new session.
  function handleRestart() {
    useDialogStore.getState().show({
      title: 'Restart this agent?',
      message: `Stops the running ${agentTypeLabel(agent.agent_type)} process and starts it again, continuing the same conversation. Your worktree, branch and changes are kept.`,
      type: 'confirm',
      variant: 'restart',
      confirmLabel: 'Restart agent',
      onConfirm: async () => {
        setRestarting(true)
        try {
          await api.default.restartAgentSession(projectId ?? '', agent.id)
          setRestartSignal((n) => n + 1)
          const name = agent.title || agent.id
          useToastStore.getState().show({
            type: 'info',
            ...agentTransitionToast({ agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'restarting', before: '' }),
          })
        } catch (err) {
          useDialogStore.getState().show({
            title: 'Restart Failed',
            message: `Failed to restart agent: ${formatError(err)}`,
            type: 'error',
          })
        } finally {
          setRestarting(false)
        }
      },
    })
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
      type: 'info',
      duration: 0,
      ...agentTransitionToast({ agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merging', before: '', after: `into \`${agent.base_branch}\`...` }),
    })
    try {
      await api.default.mergeAgent(projectId ?? '', agent.id, force || undefined, !keepOpen)
      useToastStore.getState().dismiss(toastId)
      if (keepOpen) {
        useToastStore.getState().show({
          type: 'success',
          ...agentTransitionToast({ agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merged', before: '', after: `into \`${agent.base_branch}\` - agent kept running` }),
        })
        // Stay on the page: the base branch just absorbed the head's commits, so
        // the diff (base...head) and any artifact comparison need a refetch.
        onRefresh?.()
        setDiffRefreshTrigger((t) => t + 1)
        setArtifactRefreshTrigger((t) => t + 1)
        return
      }
      useToastStore.getState().show({
        type: 'success',
        ...agentTransitionToast({ agentName: name, agentId: agent.id, projectId: projectId ?? '', status: 'merged', before: '', after: `into \`${agent.base_branch}\`` }),
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
        type: 'info',
        ...agentTransitionToast({ agentName: name, agentId: agent.id, projectId: projectId ?? '', icon: 'merge-queued', before: `will merge into \`${toBranch}\` when it finishes and tests pass` }),
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
    // protected_branches config (docs/non-local-integration.md): the branch is
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

  // The rename box's "Generate" button: the same one-shot summary of the task
  // prompt the spawn flow runs in the background, on demand. The result lands in
  // the draft rather than the DB, so it's a suggestion the user can edit, accept
  // with Enter, or throw away with Escape. Useful when the spawn-time generation
  // never landed (offline, out of credits, daemon restarted mid-call) and the
  // head kept its truncated prompt-derived title.
  async function generateTitle() {
    setGeneratingTitle(true)
    const res = await runWithToast(() => api.default.generateAgentTitle(projectId ?? '', agent.id), {
      errorPrefix: 'Failed to generate title',
    })
    if (res.ok) setTitleDraft(res.value.title)
    setGeneratingTitle(false)
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

  // --- Non-local integration: publish / MR sync (docs/non-local-integration.md) ---

  // Fetch the review config once per project (if not already cached) as soon as
  // the head is on screen, so clicking "Create MR" opens the dialog instantly
  // with prefilled values - the fetch no longer gates the popup. Deduped in the
  // store, so this and the root layout's fetch produce a single request.
  useEffect(() => {
    // Unconditional: a persisted snapshot may already be in the store, but
    // ensureReviewConfig still owes one background refresh per session.
    if (projectId) void ensureReviewConfig(projectId)
  }, [projectId])

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

  // armPublish / disarmPublish toggle the publish-when-green arm: an unlinked head
  // opens a draft MR, a linked one pushes, and the arm is sticky, so it keeps
  // doing that for every later commit (docs/non-local-integration.md). The toast
  // names whichever the head is actually armed for, in the same plain terms the
  // menu uses - "when green" is the code's word for this, not the user's.
  async function armPublish(acknowledgeAdopted = false) {
    const linkedNow = !!agent.review
    const noun = agent.review?.adopted ? 'PR' : 'MR'
    const res = await runWithToast(() => api.default.armPublishWhenGreen(projectId ?? '', agent.id, acknowledgeAdopted || undefined), {
      success: linkedNow ? `Will push to the ${noun} once tests pass` : 'Will open a draft MR once tests pass',
      errorPrefix: 'Failed to arm',
    })
    // The arm endpoint returns no body, so refresh to repaint the menu's toggle.
    if (res.ok) onRefresh?.()
  }

  // Arming an adopted PR means Hydra starts pushing into a PR someone else owns,
  // on every green commit, until it is cancelled - so the API refuses it unless the
  // caller acknowledges exactly that (acknowledge_adopted, docs/pr-adoption.md).
  // This dialog is where that acknowledgement is collected: it names the PR and the
  // stickiness, because "it pushed again on its own" is the surprise worth spending
  // a click to prevent.
  function confirmArmAdoptedPublish() {
    const pr = agent.review?.id ? `PR #${agent.review.id}` : 'this PR'
    useDialogStore.getState().show({
      title: `Push automatically to ${pr}?`,
      message: `${pr} is not yours - Hydra did not open it. Arming this pushes every commit that passes tests straight to its branch, and keeps doing so until you stop it.`,
      type: 'warning',
      confirmLabel: 'Push automatically',
      showCancel: true,
      onConfirm: () => void armPublish(true),
    })
  }
  async function disarmPublish() {
    const linkedNow = !!agent.review
    const res = await runWithToast(() => api.default.disarmPublishWhenGreen(projectId ?? '', agent.id), {
      success: linkedNow ? 'No longer pushing automatically' : 'MR no longer queued',
      errorPrefix: 'Failed to cancel',
    })
    if (res.ok) onRefresh?.()
  }

  // respondToReview sends the agent a one-line canned prompt to fetch and address
  // its MR's unresolved review comments (via the mcp__hydra__* tools) - the same
  // agent-pull pattern as the diff viewer's "Fix the merge conflicts" action
  // (docs/non-local-integration.md). Data is fetched by the agent when it reads,
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

  // publishAction is the Create MR / Push to MR / View MR button
  // (docs/non-local-integration.md). Unlinked: "Create MR" opens the dialog.
  // Linked: the button LEADS with the thing there is to do - "Push to MR (2)"
  // while the head is ahead, otherwise "View MR" - because the state that used to
  // be invisible (a commit made after the MR opened) is exactly the state where
  // there is an action to take. What the button doesn't lead with stays in the
  // dropdown, so nothing is ever only reachable one way.
  const linked = !!agent.review
  const ahead = agent.review?.ahead ?? 0
  const behind = agent.review?.behind ?? 0
  // An adopted PR the author has not opened to maintainer edits is read-only: the
  // backend rejects a push, so the push affordances are replaced with a disabled
  // note (docs/pr-adoption.md).
  const adoptedPR = agent.review?.adopted === true
  const readOnlyPR = adoptedPR && agent.review?.can_push === false
  const mrNoun = adoptedPR ? 'PR' : 'MR'
  const canPushToMR = linked && !readOnlyPR
  const leadWithPush = canPushToMR && ahead > 0
  const viewMRItem = {
    label: `View ${mrNoun}`,
    description: 'Open it on the forge.',
    icon: <ProviderIcon provider={agent.review?.provider} className="w-4 h-4" />,
    onClick: () => window.open(agent.review!.url, '_blank', 'noreferrer'),
    tone: 'neutral' as const,
  }
  const pullItem = {
    label: `Pull from ${mrNoun} (${behind} behind)`,
    description: `Merge the remote ${mrNoun} branch into this head.`,
    icon: <Download className="w-4 h-4" />,
    onClick: () => void handlePullFromMR(),
    tone: 'neutral' as const,
    disabled: busy || publishing,
  }
  // One armed state with two faces: before the MR exists it opens a draft one,
  // after it keeps pushing. Same flag, so the label follows whichever the head is
  // about to do rather than inventing a second toggle. Worded like the merge
  // button's "Queue merge" - "publish-when-green" is the code's name for this,
  // and it means nothing to someone reading a menu.
  const syncWhenGreenItem = agent.publish_when_green
    ? {
        label: linked ? 'Stop pushing automatically' : 'Cancel queued MR',
        description: linked ? `New commits will no longer go to the ${mrNoun} on their own.` : 'No MR will be opened automatically.',
        icon: <Clock className="w-4 h-4" />,
        onClick: () => void disarmPublish(),
        tone: 'neutral' as const,
        disabled: busy,
      }
    : {
        label: linked ? 'Push automatically' : 'Queue MR',
        // An adopted PR says whose it is and that it will ask first, so the menu
        // itself carries the warning rather than springing the dialog unannounced.
        description: adoptedPR
          ? "Pushes each new commit to this PR on its own, once tests pass. It isn't yours, so this asks first."
          : linked
            ? `Pushes each new commit to the ${mrNoun} on its own, once tests pass.`
            : 'Opens a draft MR on its own once tests pass, then keeps it up to date.',
        icon: <Clock className="w-4 h-4" />,
        onClick: adoptedPR ? confirmArmAdoptedPublish : () => void armPublish(),
        tone: 'emerald' as const,
        disabled: busy || publishing,
      }
  // A read-only PR can't be pushed to at all, by hand or automatically, so it gets
  // no arm toggle - the lock note above already says why. Disarming stays offered
  // whatever the head is, so a stale arm can always be cleared.
  const publishWhenGreenItems = readOnlyPR && !agent.publish_when_green ? [] : [syncWhenGreenItem]
  const respondItem = {
    label: 'Respond to review comments',
    description: 'Ask the agent to fetch and address the unresolved review comments.',
    icon: <MessageSquare className="w-4 h-4" />,
    onClick: () => void respondToReview(),
    tone: 'neutral' as const,
    disabled: busy,
  }
  const publishAction: AgentTopBarAction = publishing
    ? { label: 'Publishing...', icon: <LoaderCircle className="w-4 h-4 animate-spin" />, onClick: () => {}, variant: 'muted' }
    : linked
      ? {
          label: leadWithPush ? `Push to ${mrNoun}` : `View ${mrNoun}`,
          count: leadWithPush ? ahead : undefined,
          icon: leadWithPush ? <Upload className="w-4 h-4" /> : <ProviderIcon provider={agent.review?.provider} className="w-4 h-4" />,
          onClick: leadWithPush ? () => void handlePushToMR() : () => window.open(agent.review!.url, '_blank', 'noreferrer'),
          variant: leadWithPush ? 'blue' : 'segment',
          disabled: busy || publishing,
          menu: [
            ...(leadWithPush ? [viewMRItem] : []),
            ...(readOnlyPR
              ? [{ label: 'Read-only PR (no push access)', description: 'The author has not enabled maintainer edits, so commits cannot be pushed to this PR.', icon: <Lock className="w-4 h-4" />, onClick: () => {}, tone: 'neutral' as const, disabled: true }]
              : leadWithPush
                ? []
                : [{ label: `Push to ${mrNoun}`, description: 'Push the local head branch again (idempotent).', icon: <Upload className="w-4 h-4" />, onClick: () => void handlePushToMR(), tone: 'emerald' as const, disabled: busy || publishing }]),
            ...(behind > 0 ? [pullItem] : []),
            ...publishWhenGreenItems,
            ...((agent.review?.state?.unresolved_discussions ?? 0) > 0 ? [respondItem] : []),
          ] as AgentTopBarMenuItem[],
        }
      : {
          label: 'Create MR',
          icon: <MRIcon linked={false} className="w-4 h-4" />,
          onClick: () => void openCreateMR(),
          variant: 'blue',
          disabled: busy || publishing,
          menu: [syncWhenGreenItem] as AgentTopBarMenuItem[],
        }
  // Create MR (blue) always leads, to the left of Merge; once linked it becomes
  // the View-MR button, still first.
  const mrFirst = true

  // The agent's slice of the global top bar (portalled into __root's slot,
  // after the project selector + "/"): a status dot, the name (clicking it
  // renames inline) and the adaptive action toolbar. The status pill and test
  // verdict live in the metadata row.
  const agentTopBar = (
    <TopBarPortal>
      <AgentTopBarContent
        title={agent.title || agent.id}
        statusDot={
          <span className={`block w-2.5 h-2.5 rounded-full ${agentDotClass(agent)} ${agentDotAnimate(agent)}`} />
        }
        rename={{
          editing: editingTitle,
          draft: titleDraft,
          saving: savingTitle,
          generating: generatingTitle,
          onStart: startEditingTitle,
          onChange: setTitleDraft,
          onSave: saveTitle,
          onCancel: () => setEditingTitle(false),
          onGenerate: generateTitle,
        }}
        actions={[
          ...(mrFirst ? [publishAction, mergeAction] : [mergeAction, publishAction]),
          { label: 'Mark as unread', icon: <Mail className="w-4 h-4" />, onClick: handleMarkUnread, variant: 'segment', shortcut: SHORTCUT_MARK_UNREAD },
          { label: 'Rename', icon: <Pencil className="w-4 h-4" />, onClick: startEditingTitle, variant: 'segment', shortcut: SHORTCUT_RENAME },
          { label: 'Restart', icon: <RotateCcw className="w-4 h-4" />, onClick: handleRestart, variant: 'segment', disabled: merging || killing || restarting },
          { label: 'Kill', icon: <Trash2 className="w-4 h-4" />, onClick: handleKill, variant: 'danger', disabled: merging || killing, shortcut: SHORTCUT_KILL },
        ]}
      />
    </TopBarPortal>
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
      {/* Portals into the global top bar - renders nothing in place. */}
      {agentTopBar}
      {isWide ? (
        // ── Two-pane split ──────────────────────────────────────────────────
        // Left: a pane toolbar (metadata + hide-chat toggle) then collapsible
        // prompt + terminal/chat filling the height. Right: the inspector pane
        // (diff / tests / previews). A hand-rolled divider between them, plus
        // the three collapse states from paneCollapse. The panes' widths
        // animate (width transition) so collapsing/expanding either side
        // glides; the transition is suppressed mid-drag so resizing stays
        // snappy. The working pane stays mounted in every state: while it
        // collapses its INNER content keeps a fixed pixel width (clipped by
        // the outer overflow-hidden), so the terminal never relayouts at a
        // transient width and the swap is a real slide, not a jump.
        <div ref={panesRef} className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
          <div
            className="flex min-h-0 overflow-hidden shrink-0"
            style={{
              width:
                paneCollapse === 'working'
                  ? 0
                  : paneCollapse === 'inspector'
                    ? '100%'
                    : `calc(${(splitRatio * 100).toFixed(4)}% - 6px)`,
              transition: paneTransition,
            }}
          >
            {/* Inner content pinned to a fixed pixel width while the pane
                collapses/reveals, so the width tween clips it instead of
                reflowing the terminal (same trick as the sidebar collapse). */}
            <div
              className="flex flex-col min-h-0 h-full shrink-0"
              style={{
                width:
                  paneCollapse === 'working' || workingRevealing
                    ? Math.max(0, panesW * splitRatio - 6)
                    : '100%',
              }}
            >
              {/* Pane toolbar: flush at the pane top, min-h matching the
                  inspector's Changes bar so the two collapse toggles line up. */}
              <div className="shrink-0 min-h-12 px-3 sm:px-4 py-2.5 flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
                <div className="flex-1 min-w-0">
                  <AgentMetaRow
                    agent={agent}
                    projectId={projectId}
                    agentTypeClass={agentTypeClass}
                    branches={branches}
                    savingBase={savingBase}
                    savingChatMode={savingChatMode}
                    savingDownstream={savingDownstream}
                    publishing={publishing}
                    onSaveBase={onSaveBase}
                    onRefreshBranches={refreshBranches}
                    onSaveChatMode={onSaveChatMode}
                    onSaveDownstream={onSaveDownstream}
                    onPushToMR={onPushToMR}
                    onPullFromMR={onPullFromMR}
                  />
                </div>
                {/* self-start pins the toggle to the toolbar's first line even
                    when the chips wrap, so it stays level with the inspector
                    bar's toggle across the divider. */}
                <div className="shrink-0 self-start">{workingTopButton}</div>
              </div>
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden px-3 sm:px-4 pt-3 pb-4 gap-3">
                {/* Prompt collapsed by default (terminal mode only) - chat heads
                    replay the task as the first chat message. */}
                {agent.prompt && agent.chat_mode !== true && (
                  <CollapsiblePrompt prompt={agent.prompt} projectId={projectId} agentId={agent.id} />
                )}
                <AgentTerminal
                  agentId={agent.id}
                  agentType={agent.agent_type}
                  projectId={projectId}
                  isEphemeral={agent.ephemeral}
                  chatMode={agent.chat_mode === true}
                  fill
                  reconnectSignal={restartSignal}
                  onRefresh={onRefresh}
                  onDiffRefresh={handleDiffRefresh}
                  onSelectCommit={handleSelectCommit}
                />
              </div>
            </div>
          </div>
          {/* Draggable divider - kept mounted but width-collapsed off the full
              split so the pane widths add up cleanly and animate. */}
          <div
            onPointerDown={paneCollapse === 'none' ? handleSplitResizeStart : undefined}
            className={`group/resize shrink-0 flex items-center justify-center overflow-hidden ${paneCollapse === 'none' ? 'cursor-ew-resize touch-none border-x-1 border-gray-200 dark:border-gray-800' : ''}`}
            style={{ width: paneCollapse === 'none' ? 12 : 0, transition: paneTransition }}
            title={paneCollapse === 'none' ? 'Drag to resize' : undefined}
          >
            <ResizeGrip orientation="vertical" />
          </div>
          <div
            className="flex flex-col min-w-0 min-h-0 overflow-hidden shrink-0"
            style={{
              width: paneCollapse === 'inspector' ? '0px' : paneCollapse === 'working' ? '100%' : `calc(${((1 - splitRatio) * 100).toFixed(4)}% - 6px)`,
              transition: paneTransition,
            }}
          >
            <InspectorPane
              agent={agent}
              projectId={projectId}
              externalRefreshTrigger={diffRefreshTrigger}
              externalArtifactRefresh={artifactRefreshTrigger}
              externalCommitSelect={commitSelect}
              changesLeading={changesLeadingButton}
            />
          </div>
          {/* Transparent overlay during the divider drag so the pointer isn't
              swallowed by the xterm/iframe (gotcha #5). */}
          {splitResizing && <div className="fixed inset-0 z-[200] cursor-col-resize" />}
        </div>
      ) : (
        // ── Narrow single-pane "screen stack" (no room for two panes) ────────
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
              {/* Metadata as a slim, horizontally scrollable chip strip - one
                  line, swipe sideways for the tail (AgentMetaRow scrolls) -
                  with the show-diff button pinned after it (outside the
                  scroll). No hide counterpart: the diff screen's own back
                  chevron returns to the chat. */}
              <div className="shrink-0 px-3 py-2 border-b border-gray-100 dark:border-gray-700/60 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <AgentMetaRow
                    agent={agent}
                    projectId={projectId}
                    agentTypeClass={agentTypeClass}
                    branches={branches}
                    savingBase={savingBase}
                    savingChatMode={savingChatMode}
                    savingDownstream={savingDownstream}
                    publishing={publishing}
                    onSaveBase={onSaveBase}
                    onRefreshBranches={refreshBranches}
                    onSaveChatMode={onSaveChatMode}
                    onSaveDownstream={onSaveDownstream}
                    onPushToMR={onPushToMR}
                    onPullFromMR={onPullFromMR}
                  />
                </div>
                <Tooltip content={`Show diff (${SHORTCUT_DIFF_SIDEBAR})`}>
                  <button className={PANE_TOGGLE_CLS} aria-label="Show diff" onClick={toggleDiffSidebar}>
                    <FileDiff className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
              {/* No padding around the chat/terminal on mobile - it fills the
                  screen edge-to-edge; only the prompt keeps a small inset. */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {agent.prompt && agent.chat_mode !== true && (
                <div className="shrink-0 px-3 pt-2 pb-1">
                  <CollapsiblePrompt prompt={agent.prompt} projectId={projectId} agentId={agent.id} />
                </div>
              )}
              <AgentTerminal
                agentId={agent.id}
                agentType={agent.agent_type}
                projectId={projectId}
                isEphemeral={agent.ephemeral}
                chatMode={agent.chat_mode === true}
                fill
                reconnectSignal={restartSignal}
                onRefresh={onRefresh}
                onDiffRefresh={handleDiffRefresh}
                onSelectCommit={handleSelectCommit}
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
                externalCommitSelect={commitSelect}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
