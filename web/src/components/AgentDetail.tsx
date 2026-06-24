import { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '../stores/apiClient'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatError } from '../api/format_error'
import type { AgentResponse, RepositoryBranch } from '../api'
import { AgentTerminal } from './AgentTerminal'
import { BranchSelector } from './BranchSelector'
import { SeparatedRow } from './SeparatedRow'
import { AgentTopBar } from './AgentTopBar'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { uploadBlobUrl } from '../api/uploads'
import type { Attachment } from '../lib/spawnDrafts'
import { DiffViewer } from '../DiffViewer'
import { formatStartedAgo, agentStatusBadge, archivedEndStateBadge, agentDotClass } from './AgentComponents'
import { LoaderCircle, Merge, Trash2, Tag, RotateCcw, Pencil, TerminalSquare, Mail } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { AgentTypeIcon, type AgentTypeIconName } from './AgentTypeIcon'
import { renderMarkdown } from '../lib/markdown'

import { useDialogStore } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { useAgentStore } from '../stores/agentStore'

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
  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
      : agent.agent_type === 'gemini'
        ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
        : agent.agent_type === 'copilot'
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
          : agent.agent_type === 'codex'
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

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
            <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              <AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />
              {agent.agent_type}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${endBadge.className}`}>
              {endBadge.label}
            </span>
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
        {agent.prompt && <PromptBlock key={agent.id} prompt={agent.prompt} projectId={projectId} />}

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
  // Restart was removed from the agent header (the action no longer surfaces in
  // the UI); the prop is retained so the route can keep wiring it for now.
  onRestarted?: (agent: AgentResponse) => void
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
  // static text.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    api.default.getRepositoryBranches(projectId)
      .then((r) => { if (!cancelled) setBranches(r.branches) })
      .catch(() => { if (!cancelled) setBranches([]) })
    return () => { cancelled = true }
  }, [projectId])

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

  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
      : agent.agent_type === 'gemini'
        ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
        : agent.agent_type === 'copilot'
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
          : agent.agent_type === 'codex'
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

  async function handleKill() {
    useDialogStore.getState().show({
      title: 'Kill Agent',
      message: `Are you sure you want to kill agent "${agent.id}"?\n\nThis will permanently stop the sandbox session, remove the git worktree, and delete the branch.`,
      type: 'confirm',
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
  }

  function handleMerge() {
    // If this agent is stacked on another agent (its base branch is another
    // agent's branch), the merge advances that parent agent's branch — name it,
    // and warn when the parent is still running since its working files will
    // shift underneath it.
    const parent = useAgentStore.getState().agents.find((a) => a.branch_name === agent.base_branch)
    const target = parent ? `agent "${parent.id}"'s branch (${agent.base_branch})` : `the base branch (${agent.base_branch})`
    const baseMessage = `Are you sure you want to merge agent "${agent.id}"?`
    const parentWarning = parent && parent.session_status === 'running'
      ? `\n\n⚠️ Parent agent "${parent.id}" is currently running — merging will change its working files while it works.`
      : ''
    const tail = `\n\nThis will merge the agent's branch into ${target}, then stop the sandbox session and clean up.`

    // Show the dialog immediately so it never lags behind a slow git query.
    // The uncommitted-changes check runs in the background and folds its
    // warning into the open dialog when it returns.
    useDialogStore.getState().show({
      title: 'Merge Agent',
      message: baseMessage + parentWarning + tail,
      type: parentWarning ? 'warning' : 'confirm',
      onConfirm: async () => {
        setMerging(true)
        // A persistent toast keeps the merge visible even after the dialog
        // closes and the agent is moved into the archived history.
        const toastId = useToastStore.getState().show({
          message: `Merging agent "${agent.id}"…`,
          type: 'info',
          duration: 0,
        })
        try {
          await api.default.mergeAgent(projectId ?? '', agent.id)
          useToastStore.getState().dismiss(toastId)
          useToastStore.getState().show({
            message: `Agent "${agent.id}" merged into ${agent.base_branch}`,
            type: 'success',
          })
          // Optimistically move the agent into the archived history so it appears
          // in the sidebar immediately, rather than vanishing until the next
          // archived-list refetch (which only happens on a project switch).
          useAgentStore.getState().upsertArchived({ ...agent, archived: true, end_state: 'merged', session_status: 'stopped', session_pid: 0 })
          onKilled(agent.id)
        } catch (err: any) {
          const errorData = (err.body && typeof err.body === 'object') ? err.body : err
          if (errorData.error === 'merge_conflict') {
            useDialogStore.getState().show({
              title: 'Merge Conflict',
              message: `CONFLICT: Merge failed due to git conflicts. Please resolve them manually or update from base.`,
              type: 'warning'
            })
          } else {
            useDialogStore.getState().show({
              title: 'Merge Failed',
              message: `Failed to merge agent: ${formatError(err)}`,
              type: 'error'
            })
          }
        } finally {
          useToastStore.getState().dismiss(toastId)
          setMerging(false)
        }
      }
    })

    // Background: warn about uncommitted changes that the merge would discard,
    // patched into the dialog if it's still open by the time the query returns.
    void (async () => {
      try {
        const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
        if (!d.uncommitted_changes) return
        const tracked = d.uncommitted_summary?.tracked_count ?? 0
        const untracked = d.uncommitted_summary?.untracked_count ?? 0
        const total = tracked + untracked
        const warning = `\n\n⚠️ This agent has ${total} uncommitted file change${total !== 1 ? 's' : ''} that will be lost when merging.`
        const dialog = useDialogStore.getState()
        if (dialog.title === 'Merge Agent') {
          dialog.update({ message: baseMessage + parentWarning + warning + tail, type: 'warning' })
        }
      } catch { /* ignore — proceed without warning */ }
    })()
  }

  // Mark the agent unread and deselect it: lights the sidebar unread dot and
  // navigates back to the project page. We deselect because the auto-clear-on-
  // open effect (__root.tsx) would otherwise immediately mark the still-open
  // agent read again. Optimistic locally + a fire-and-forget POST.
  function handleMarkUnread() {
    useAgentStore.getState().markUnread(agent.id)
    onUnselect?.()
    if (projectId) {
      api.default.markAgentUnread(projectId, agent.id).catch(() => {})
    }
  }

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
    try {
      const updated = await api.default.updateAgent(projectId ?? '', agent.id, { title: next })
      updateAgentInStore(updated)
      setEditingTitle(false)
    } catch (err) {
      useToastStore.getState().show({ message: `Failed to rename agent: ${formatError(err)}`, type: 'error' })
    } finally {
      setSavingTitle(false)
    }
  }

  // Changing the base branch is metadata-only: it updates what update-from-base
  // merges in and what the diff compares against, but does NOT rebase existing
  // commits (the user can do that with git if they want). The backend validates
  // the ref exists and returns a 400 we surface as a toast.
  async function saveBase(next: string) {
    if (!next || next === (agent.base_branch || '')) return
    setSavingBase(true)
    try {
      const updated = await api.default.updateAgent(projectId ?? '', agent.id, { base_branch: next })
      updateAgentInStore(updated)
      useToastStore.getState().show({ message: `Base branch set to ${next} (commits not moved)`, type: 'success' })
    } catch (err) {
      useToastStore.getState().show({ message: `Failed to set base branch: ${formatError(err)}`, type: 'error' })
    } finally {
      setSavingBase(false)
    }
  }

  // Archived agents are read-only: render the history view instead of the live
  // terminal/diff. Placed after all hooks above so hook order stays stable when
  // the same mounted component switches between a live and an archived agent.
  if (agent.archived) {
    return <ArchivedAgentDetail agent={agent} projectId={projectId} onPurged={onKilled} />
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
        statusDot={<span className={`block w-2.5 h-2.5 rounded-full ${agentDotClass(agent)}`} />}
        rename={{
          editing: editingTitle,
          draft: titleDraft,
          saving: savingTitle,
          onStart: startEditingTitle,
          onChange: setTitleDraft,
          onSave: saveTitle,
          onCancel: () => setEditingTitle(false),
        }}
        inlineActions={[
          {
            label: 'Merge',
            icon: merging ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Merge className="w-4 h-4" />,
            onClick: handleMerge,
            disabled: merging || killing,
          },
        ]}
        actions={[
          { label: 'Rename', icon: <Pencil className="w-4 h-4" />, onClick: startEditingTitle },
          { label: 'Mark as unread', icon: <Mail className="w-4 h-4" />, onClick: handleMarkUnread },
          { label: 'Kill', icon: <Trash2 className="w-4 h-4" />, onClick: handleKill, danger: true, disabled: merging || killing },
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
            <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              <AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />
              {agent.agent_type}
            </span>
            {agent.agent_status && (
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${agentStatusBadge(agent.agent_status.status).className}`}>
                {agentStatusBadge(agent.agent_status.status).label}
              </span>
            )}
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
                  branches={branches}
                  activeRef={agent.base_branch || ''}
                  isKnownBranch={branches.some((b) => b.name === agent.base_branch)}
                  onSelect={(name) => void saveBase(name)}
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
        {agent.prompt && <PromptBlock key={agent.id} prompt={agent.prompt} projectId={projectId} />}

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
