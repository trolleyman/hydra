import { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '../stores/apiClient'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatError } from '../api/format_error'
import type { AgentResponse } from '../api'
import { AgentTerminal } from './AgentTerminal'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { uploadBlobUrl } from '../api/uploads'
import type { Attachment } from '../lib/spawnDrafts'
import { DiffViewer } from '../DiffViewer'
import { formatStartedAgo, agentStatusBadge, archivedEndStateBadge } from './AgentComponents'
import { LoaderCircle, Merge, Trash2, Tag, RotateCcw, FolderSync, Copy, Check, Pencil, Archive, TerminalSquare } from 'lucide-react'
import { Tooltip } from './Tooltip'
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
  const [copied, setCopied] = useState(false)
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
          : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

  return (
    <div className="flex-1 flex flex-col overflow-auto p-6 min-w-0 min-h-0" data-main-scroll>
      <div className="w-full">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Archive className="w-5 h-5 text-gray-400 dark:text-gray-500 shrink-0" />
            <h1 className="text-2xl font-bold text-gray-600 dark:text-gray-300 truncate" title={agent.id}>
              {agent.title || agent.id}
            </h1>
            <Tooltip content="Copy ID">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(agent.id)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="w-6 h-6 flex items-center justify-center rounded-md border border-gray-200 text-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 transition-colors cursor-pointer shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3 h-3" />}
              </button>
            </Tooltip>
          </div>

          {/* Metadata row */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              {agent.agent_type}
            </span>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${endBadge.className}`}>
              {endBadge.label}
            </span>
            {agent.branch_name && (
              <>
                <span className="text-gray-300 dark:text-gray-600">|</span>
                <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5" />
                  {agent.branch_name}
                </span>
              </>
            )}
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <>
                <span className="text-gray-300 dark:text-gray-600">|</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  created {formatStartedAgo(agent.created_at)}
                </span>
              </>
            )}
          </div>
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
  )
}

export function AgentDetail({
  agent,
  projectId,
  onKilled,
  onRestarted,
  onRefresh,
}: {
  agent: AgentResponse
  projectId: string | null
  onKilled: (id: string) => void
  onRestarted: (agent: AgentResponse) => void
  onRefresh?: () => void
}) {
  const [killing, setKilling] = useState(false)
  const [merging, setMerging] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)
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

  async function handleMerge() {
    // Check for uncommitted changes before showing the confirm dialog.
    let uncommittedWarning = ''
    try {
      const d = await api.default.getAgentDiffFiles(projectId ?? '', agent.id, undefined, undefined, true)
      if (d.uncommitted_changes) {
        const tracked = d.uncommitted_summary?.tracked_count ?? 0
        const untracked = d.uncommitted_summary?.untracked_count ?? 0
        const total = tracked + untracked
        uncommittedWarning = `\n\n⚠️ This agent has ${total} uncommitted file change${total !== 1 ? 's' : ''} that will be lost when merging.`
      }
    } catch { /* ignore — proceed without warning */ }

    useDialogStore.getState().show({
      title: 'Merge Agent',
      message: `Are you sure you want to merge agent "${agent.id}"?${uncommittedWarning}\n\nThis will merge the agent's branch into the base branch, then stop the sandbox session and clean up.`,
      type: uncommittedWarning ? 'warning' : 'confirm',
      onConfirm: async () => {
        setMerging(true)
        try {
          await api.default.mergeAgent(projectId ?? '', agent.id)
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
          setMerging(false)
        }
      }
    })
  }

  async function handleUpdateFromBase() {
    useDialogStore.getState().show({
      title: 'Update from Base',
      message: `Update "${agent.branch_name}" from "${agent.base_branch}"?\n\nThis will attempt to merge "${agent.base_branch}" into your agent branch.`,
      type: 'confirm',
      onConfirm: async () => {
        setUpdating(true)
        try {
          await api.default.updateAgentFromBase(projectId ?? '', agent.id)
          if (onRefresh) onRefresh()
        } catch (err: any) {
          const errorData = (err.body && typeof err.body === 'object') ? err.body : err
          if (errorData.error === 'merge_conflict') {
            useDialogStore.getState().show({
              title: 'Update Conflict',
              message: `CONFLICT: Update failed due to git conflicts. You may need to resolve them manually in the worktree.`,
              type: 'warning'
            })
          } else {
            useDialogStore.getState().show({
              title: 'Update Failed',
              message: `Failed to update from base: ${formatError(err)}`,
              type: 'error'
            })
          }
        } finally {
          setUpdating(false)
        }
      }
    })
  }

  async function handleRestart() {
    useDialogStore.getState().show({
      title: 'Restart Agent',
      message: `Are you sure you want to restart agent "${agent.id}"?\n\nThis will discard all progress (session, worktree, branch) and restart with the same prompt.`,
      type: 'confirm',
      onConfirm: async () => {
        setRestarting(true)
        try {
          const newAgent = await api.default.restartAgent(projectId ?? '', agent.id)
          onRestarted(newAgent)
        } catch (err) {
          useDialogStore.getState().show({
            title: 'Restart Failed',
            message: `Failed to restart agent: ${formatError(err)}`,
            type: 'error'
          })
        } finally {
          setRestarting(false)
        }
      }
    })
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

  // Archived agents are read-only: render the history view instead of the live
  // terminal/diff. Placed after all hooks above so hook order stays stable when
  // the same mounted component switches between a live and an archived agent.
  if (agent.archived) {
    return <ArchivedAgentDetail agent={agent} projectId={projectId} onPurged={onKilled} />
  }

  return (
    <div ref={scrollRef} className="flex-1 flex flex-col overflow-auto p-6 min-w-0 min-h-0" data-main-scroll>
      <div className="w-full">
        {/* Header */}
        <div className="mb-6">
          {/* Title row */}
          <div className="flex items-center gap-2 mb-2">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                disabled={savingTitle}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void saveTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingTitle(false)
                  }
                }}
                className="text-2xl font-bold text-gray-900 dark:text-gray-100 bg-transparent border-b border-blue-400 focus:outline-none min-w-0 flex-1 disabled:opacity-50"
              />
            ) : (
              <h1
                onDoubleClick={startEditingTitle}
                className="text-2xl font-bold text-gray-900 dark:text-gray-100 truncate"
                title={agent.id}
              >
                {agent.title || agent.id}
              </h1>
            )}
            {!editingTitle && (
              <Tooltip content="Rename agent">
                <button
                  onClick={startEditingTitle}
                  className="w-6 h-6 flex items-center justify-center rounded-md border border-gray-200 text-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 transition-colors cursor-pointer shrink-0"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </Tooltip>
            )}
            <Tooltip content="Copy ID">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(agent.id)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="w-6 h-6 flex items-center justify-center rounded-md border border-gray-200 text-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 transition-colors cursor-pointer shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3 h-3" />}
              </button>
            </Tooltip>
            <Tooltip content="Merge agent">
              <button
                onClick={handleMerge}
                disabled={merging || killing || restarting || updating}
                className="ml-2 w-6 h-6 flex items-center justify-center rounded-md border border-green-200 text-green-600 hover:bg-green-50 dark:border-green-900/30 dark:text-green-400 dark:hover:bg-green-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {merging ? (
                  <LoaderCircle className="w-3 h-3 animate-spin" />
                ) : (
                  <Merge className="w-3.5 h-3.5" />
                )}
              </button>
            </Tooltip>
            <Tooltip content="Update from base branch">
              <button
                onClick={handleUpdateFromBase}
                disabled={merging || killing || restarting || updating}
                className="w-6 h-6 flex items-center justify-center rounded-md border border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {updating ? (
                  <LoaderCircle className="w-3 h-3 animate-spin" />
                ) : (
                  <FolderSync className="w-3.5 h-3.5" />
                )}
              </button>
            </Tooltip>
            <Tooltip content="Restart agent">
              <button
                onClick={handleRestart}
                disabled={merging || killing || restarting || updating}
                className="w-6 h-6 flex items-center justify-center rounded-md border border-blue-200 text-blue-600 hover:bg-blue-50 dark:border-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {restarting ? (
                  <LoaderCircle className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5" />
                )}
              </button>
            </Tooltip>
            <Tooltip content="Kill agent">
              <button
                onClick={handleKill}
                disabled={merging || killing || restarting}
                className="w-6 h-6 flex items-center justify-center rounded-md border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/30 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {killing ? (
                  <LoaderCircle className="w-3 h-3 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </button>
            </Tooltip>
          </div>

          {/* Metadata row */}
          <div className="flex items-center gap-3">
            <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              {agent.agent_type}
            </span>
            {agent.agent_status && (
              <>
                <span className="text-gray-300 dark:text-gray-600">|</span>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${agentStatusBadge(agent.agent_status.status).className}`}>
                  {agentStatusBadge(agent.agent_status.status).label}
                </span>
              </>
            )}
            <span className="text-gray-300 dark:text-gray-600">|</span>
            {agent.branch_name && (
              <span className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                {agent.branch_name}
              </span>
            )}
            <span className="text-gray-300 dark:text-gray-600">|</span>
            {agent.created_at !== 0 && agent.created_at !== undefined && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                created {formatStartedAgo(agent.created_at)}
              </span>
            )}
          </div>

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
  )
}
