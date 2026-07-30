import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse, SpawnAgentRequest, RepositoryBranch } from '../api'
import { BranchSelector } from './BranchSelector'
import { SettingsPopover, SettingsGroupLabel, SettingsSelect } from './SettingsPopover'
import { formatError } from '../api/format_error'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { Zap, LoaderCircle, Paperclip, Check, MessageSquare, SquareTerminal, GitBranch, X, Lock } from 'lucide-react'
import { AgentTypeIcon } from './AgentTypeIcon'
import { AGENT_ACCENT } from '../lib/agentTypeMeta'
import { Tooltip } from './Tooltip'
import { Lightbox } from './Lightbox'
import { AttachmentChips } from './AttachmentChips'
import { StorageKeys, promptDraftKey, promptScrollKey, readLocal, writeLocal } from '../lib/storage'
import { HighlightedTextarea } from './HighlightedTextarea'
import { spawnGeometry } from '../lib/terminalGeometry'
import { type Attachment, spawnDraftKey, loadAttachments, saveAttachments, isGenericImageName, nextGenericImageNumber } from '../lib/spawnDrafts'
import { nextAttachmentId } from '../lib/draftAttachments'
import { attachmentLightboxItems, openableAttachments } from '../lib/attachmentLightbox'
import { getClipboardText, isLargePaste, detectCodeLanguage, fenceCode, pastedTextExtension, extensionMime, pasteMarkerText, stripPasteMarker } from '../lib/pastedText'
import { usePasteMarkersStore } from '../lib/composerPrefs'
import { ResizeGrip } from './ResizeGrip'
import { useComposerHistory, makeSnapshot } from '../lib/composerHistory'
import { useProjectStore } from '../stores/projectStore'
import { PRPicker } from './PRPicker'
import { Badge } from './Badge'
import type { ReviewRef } from '../api/models/ReviewRef'
import { type AgentTypeOption, readModelMap, readDefaultAgentType, readDefaultChatMode } from '../lib/spawnDefaults'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

// Selectable agent types with their display label. The AgentTypeOption ids line
// up with AgentTypeIcon's names, so the icon and its brand accent colour
// (AGENT_ACCENT) can both be rendered directly from the id.
const AGENT_TYPES: { id: AgentTypeOption; label: string; color: string }[] = [
  { id: 'claude', label: 'Claude', color: AGENT_ACCENT.claude },
  { id: 'codex', label: 'Codex', color: AGENT_ACCENT.codex },
  { id: 'gemini', label: 'Gemini', color: AGENT_ACCENT.gemini },
  { id: 'copilot', label: 'Copilot', color: AGENT_ACCENT.copilot },
]

// Curated model aliases per agent type, shown as a sub-list under each agent in
// the picker. Every agent also gets an implicit "Default" row (model '') meaning
// "don't pass --model" so the CLI uses its own default. Claude, Codex and
// Gemini expose a small curated set; Copilot stays on its CLI-managed default.
const AGENT_MODELS: Record<AgentTypeOption, { id: string; label: string }[]> = {
  claude: [
    { id: 'fable', label: 'Fable' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  ],
  copilot: [],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
}

// Short label for the currently-selected model, shown next to the brand icon on
// the picker trigger. Empty when on the CLI default (keeps the trigger to just
// the icon in the common case).
function modelLabel(agent: AgentTypeOption, model: string): string {
  if (!model) return ''
  return AGENT_MODELS[agent].find((m) => m.id === model)?.label ?? model
}

// AgentModelPicker is a compact trigger (brand icon + optional model label) that
// opens a dropdown grouping every agent type with its curated models nested
// underneath, so agent AND model are chosen in one gesture. Used in both
// SpawnForm layouts. The menu is `fixed`-positioned + anchored to the trigger's
// rect because the spawn cards clip their content (overflow-hidden for the
// rounded gradient border).
// memo: the composer re-renders per keystroke; agent/model/onChange are stable
// across typing, so the picker (and its dropdown) skip those renders.
const AgentModelPicker = memo(function AgentModelPicker({
  agent,
  model,
  onChange,
  size = 'md',
}: {
  agent: AgentTypeOption
  model: string
  onChange: (agent: AgentTypeOption, model: string) => void
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setCoords({ left: r.left, top: r.bottom + 4 })
  }, [])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    // Keep the menu pinned to the trigger if the page scrolls or resizes.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  const active = AGENT_TYPES.find((a) => a.id === agent) ?? AGENT_TYPES[0]
  const label = modelLabel(agent, model)
  // Both sizes are h-7: the trigger sits in a row of h-7 controls either way, and
  // `sm` differs in the icon and the pill's width, not in how tall it is.
  const trigger = 'h-7'
  const iconWrap = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'
  const iconCls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'

  // One selectable row: an agent + a specific model (or Default when model '').
  const Row = ({ a, m }: { a: AgentTypeOption; m: { id: string; label: string } }) => {
    const selected = agent === a && model === m.id
    return (
      <button
        type="button"
        onClick={() => { onChange(a, m.id); setOpen(false) }}
        className="w-full flex items-center gap-2 pl-8 pr-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
      >
        <span className={m.id ? '' : 'italic text-gray-500 dark:text-gray-400'}>{m.label}</span>
        {selected && <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-blue-500" />}
      </button>
    )
  }

  return (
    // `flex` so the Tooltip's inline-flex wrapper is a flex item here and can't
    // add baseline/descender space under the trigger.
    <div ref={ref} className="relative flex shrink-0">
      <Tooltip content={`Agent: ${active.label}${label ? ` · ${label}` : ''}`} className="shrink-0">
        <button
          ref={btnRef}
          type="button"
          aria-label={`Agent and model: ${active.label}${label ? `, ${label}` : ''}`}
          // Measure the trigger before opening so the fixed-position menu lands in
          // the right spot on its first paint; scroll/resize keep it pinned after.
          onClick={() => { if (!open) place(); setOpen((o) => !o) }}
          className={`flex items-center gap-0.5 rounded-full border transition-colors cursor-pointer ${label ? 'pr-1.5' : 'w-7 justify-center'} ${trigger} ${
            open
              ? 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600'
              : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <span className={`flex items-center justify-center rounded-full ${iconWrap} ${active.color}`}>
            <AgentTypeIcon name={active.id} className={iconCls} />
          </span>
          {label && <span className="text-3xs font-medium text-gray-600 dark:text-gray-300 max-w-[4rem] truncate">{label}</span>}
        </button>
      </Tooltip>
      {open && coords && (
        <div
          style={{ position: 'fixed', left: coords.left, top: coords.top }}
          className="w-44 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
        >
          {AGENT_TYPES.map((a, i) => (
            <div key={a.id}>
              {i > 0 && <div className="my-1 border-t border-gray-100 dark:border-gray-700" />}
              <div className="flex items-center gap-2 px-3 py-1 text-2xs font-semibold text-gray-500 dark:text-gray-400">
                <AgentTypeIcon name={a.id} className={`w-3.5 h-3.5 shrink-0 ${a.color}`} />
                <span>{a.label}</span>
              </div>
              <Row a={a.id} m={{ id: '', label: 'Default' }} />
              {AGENT_MODELS[a.id].map((m) => <Row key={m.id} a={a.id} m={m} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

// The git-isolation choices offered in the spawn Options menu. '' means "use the
// project's configured policy default" (the request omits git_isolation). The
// rest are explicit per-head overrides. See docs/git-isolation.md.
// Agents that get the hydra git_* tools (needed to commit under readonly). Keep
// in sync with sandbox.AgentSupportsGitTools.
const GIT_TOOL_AGENTS = ['claude', 'codex', 'gemini']

const GIT_ISOLATION_OPTS: { id: string; label: string; desc: string }[] = [
  { id: '', label: 'Default', desc: "Project's policy default." },
  { id: 'off', label: 'Off', desc: 'Full .git access.' },
  { id: 'readonly', label: 'Read-only .git', desc: 'No .git writes; commit host-side.' },
]

// memo: the compact variant lives in the RootLayout sidebar, which re-renders
// whenever project/agent state refreshes; all four props are stable across
// those, so the whole composer (textarea, chips, pickers) skips them.
export const SpawnForm = memo(function SpawnForm({
  projectId,
  onSpawned,
  compact = false,
  disabled = false,
}: {
  projectId: string | null
  onSpawned?: (agent: AgentResponse) => void
  compact?: boolean
  disabled?: boolean
}) {
  const [agentType, setAgentType] = useState<AgentTypeOption>(readDefaultAgentType)
  // Model alias for the CLI's --model flag ('' = the CLI's own default). Seeded
  // from the remembered map for the initial agent type; the picker sets agent +
  // model together, and the effect below persists the pick per agent type.
  const [model, setModel] = useState<string>(() => readModelMap()[agentType] ?? '')
  // Chat mode: drive Claude or Codex via its structured protocol and
  // show a chat view instead of a terminal. Remembered like the agent/model;
  // defaults ON when the user has never touched the toggle (only 'false' opts out).
  const [chatMode, setChatMode] = useState(readDefaultChatMode)
  // Per-head git-isolation override ('' = use the project's policy default, so the
  // request omits git_isolation). See docs/git-isolation.md. Not persisted: a locked
  // .git is a deliberate per-spawn choice, defaulted to the project policy.
  const [gitIsolation, setGitIsolation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Base branch the new agent will be created from. Defaults to the project's
  // current branch; can be pointed at another agent's hydra/<id> branch to stack
  // agents on top of one another. `branches` is null until the list loads.
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const [baseBranch, setBaseBranch] = useState('')
  // The branch `baseBranch` was seeded with (the project's current branch). Kept
  // so the options cog can tell "still on the default" from "stacked on another
  // branch", and so Reset can put it back.
  const [defaultBranch, setDefaultBranch] = useState('')
  // When set, the spawn adopts an existing PR/MR instead of branching from a base
  // branch: the worktree is based on the PR head and the head is pre-linked to the
  // MR (docs/pr-adoption.md). The base-branch picker is hidden while adopting.
  const [adopt, setAdopt] = useState<ReviewRef | null>(null)
  // Undo/redo for the composer spans the typed prompt AND the attachment chips:
  // a paste that becomes a chip calls preventDefault, so native textarea undo
  // never sees it. `present` is the live composer state; `commit`/`undo`/`redo`/
  // `reconcile`/`resetHistory` drive the snapshot stack (see composerHistory).
  const { present, commit, reconcile, reset: resetHistory, undo, redo } = useComposerHistory(
    makeSnapshot('', [], 0, 0),
  )
  const prompt = present.prompt
  const attachments = present.attachments
  const [dragOver, setDragOver] = useState(false)
  // Every preview object URL minted this session. We can't revoke on remove (an
  // undo can bring the chip back) or on unmount (the attachments are stashed to
  // the cache and restored on return), so URLs live until a spawn consumes the
  // prompt - then we revoke them all at once (and otherwise until reload, like
  // the cache itself).
  const objectUrlsRef = useRef<Set<string>>(new Set())
  // Index into the image-only attachment list while the lightbox is open; null
  // when closed.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  // The chip the lightbox was opened from, so the picture flies out of it (and
  // back into it on close) rather than fading in over the form.
  const [lightboxOrigin, setLightboxOrigin] = useState<Element | null>(null)
  // Numbers generically-named pasted images (image.png, image.png, ...) as
  // image1.png, image2.png, ... so each can be referred to distinctly in the
  // prompt (see addFiles - the number is max(current) + 1, so it resets when the
  // box clears and fills gaps after a removal).
  // Numbers pasted-text attachments (pasted-text-1.txt, ...) so each large paste
  // gets a distinct, referenceable filename. Session-only, reset after a spawn.
  const pastedTextCounterRef = useRef(0)
  // The most recent large text paste that was turned into an attachment. An
  // immediate re-paste of the SAME text inlines it instead (dropping the chip),
  // fenced when `lang` is set. Cleared on a different paste, spawn, or project
  // switch so a stale block can't be "re-pasted" later.
  const lastPasteRef = useRef<{ text: string; attachmentId: number; filename: string; lang: string | null } | null>(null)
  // Set by a Ctrl/Cmd+Shift+V keystroke (the "paste as plain text" gesture, see
  // handleKeyDown) so the paste it triggers inserts literally instead of being
  // attached. Read-and-cleared by the next handlePaste; a timer clears it too in
  // case no paste follows (e.g. an empty clipboard), so it can't go stale.
  const literalPasteRef = useRef(false)
  // Whether pasting an attachment also inserts its "[filename]" marker (a
  // Browser preference, default on).
  const pasteMarkers = usePasteMarkersStore((s) => s.enabled)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Mirrors `attachments` into a ref so the project-switch effect can stash the
  // outgoing project's attachments without depending on (and re-running for)
  // every attachment change.
  const attachmentsRef = useRef<Attachment[]>([])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    writeLocal(StorageKeys.defaultAgentType, agentType)
  }, [agentType])

  useEffect(() => {
    writeLocal(StorageKeys.defaultChatMode, chatMode ? 'true' : 'false')
  }, [chatMode])

  // readonly needs the hydra git tools; if the agent is switched to one without
  // them while readonly is selected, drop back to the default (the server would
  // downgrade it anyway).
  useEffect(() => {
    if (gitIsolation === 'readonly' && !GIT_TOOL_AGENTS.includes(agentType)) setGitIsolation('')
  }, [agentType, gitIsolation])

  // Remember the chosen model per agent type so the next spawn of that agent
  // defaults to it (mirrors defaultAgentType).
  useEffect(() => {
    writeLocal(StorageKeys.defaultModel, JSON.stringify({ ...readModelMap(), [agentType]: model }))
  }, [agentType, model])

  // Load the project's branches for the base-branch selector. `defaultSelection`
  // also resets the chosen base to the current branch - done on the initial load
  // for a project, but NOT on the background refresh that fires when the dropdown
  // is opened (which must preserve whatever the user picked). The background
  // refresh keeps the cached list visible and just swaps in fresh branches, so a
  // newly-spawned agent branch becomes stackable without a page reload.
  // Built-in (scratch) projects drop the git chrome that has nothing to act on.
  // Selector, not a whole-store subscribe: this form re-renders on every
  // keystroke.
  const isBuiltinProject = useProjectStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.builtin,
  )

  // Guards against a slow request for an old project resolving after the user
  // switched projects: each call captures the project it was issued for and only
  // applies its result if that's still the active project.
  const branchReqProjectRef = useRef<string | null | undefined>(undefined)
  const refreshBranches = useCallback(async (defaultSelection: boolean) => {
    branchReqProjectRef.current = projectId
    if (!projectId) {
      setBranches(null)
      setBaseBranch('')
      setDefaultBranch('')
      return
    }
    try {
      const res = await api.default.getRepositoryBranches(projectId)
      if (branchReqProjectRef.current !== projectId) return
      setBranches(res.branches)
      // The default follows the project's current branch on every refresh (it
      // can move under us), but the user's pick is only overwritten on the
      // initial load for a project.
      setDefaultBranch(res.current || res.branches[0]?.name || '')
      if (defaultSelection) setBaseBranch(res.current || res.branches[0]?.name || '')
    } catch {
      if (branchReqProjectRef.current === projectId && defaultSelection) setBranches(null)
    }
  }, [projectId])

  useEffect(() => {
    void refreshBranches(true)
  }, [refreshBranches])

  // Stable handlers for the memo'd picker/selector children, so typing in the
  // textarea (which re-renders the form) doesn't re-render them too.
  const handleAgentModelChange = useCallback((a: AgentTypeOption, m: string) => {
    setAgentType(a)
    setModel(m)
  }, [])
  const handleBranchOpen = useCallback(() => {
    void refreshBranches(false)
  }, [refreshBranches])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The resizable element is the whole card (textarea + footer), so the drag
  // grip sits at the bottom-right of the entire box rather than just the
  // textarea. We persist/restore the card's height for compact mode.
  const cardRef = useRef<HTMLDivElement>(null)

  // Persist card height for compact mode
  useEffect(() => {
    if (!compact || !cardRef.current) return

    const card = cardRef.current
    const savedHeight = readLocal(StorageKeys.spawnHeight)
    if (savedHeight) {
      card.style.height = `${savedHeight}px`
    }

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = (entry.target as HTMLElement).offsetHeight
        if (height > 0) {
          clearTimeout(timer)
          timer = setTimeout(() => {
            writeLocal(StorageKeys.spawnHeight, String(height))
          }, 200)
        }
      }
    })

    observer.observe(card)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [compact])

  // Custom drag-to-resize handle for the spawn card. We use a styled grab bar
  // (matching the sidebar width resizer) rather than the native textarea resize
  // grip, which looked awkward poking out of the card's rounded gradient corner.
  // Dragging sets the card height directly; the ResizeObserver above persists it
  // for the compact box.
  // Pointer events (not mouse) so the drag works with touch + pen too, e.g. on
  // mobile. `touch-none` on the handle keeps the browser from hijacking the
  // gesture for scrolling.
  function handleCardResizeStart(e: React.PointerEvent) {
    e.preventDefault()
    const card = cardRef.current
    if (!card) return
    const startY = e.clientY
    const startHeight = card.offsetHeight
    const min = compact ? 128 : 180
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      card.style.height = `${Math.max(min, startHeight + ev.clientY - startY)}px`
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  // The grab bar rendered at the bottom of each spawn card.
  function renderResizeHandle() {
    return (
      <div
        onPointerDown={handleCardResizeStart}
        className="group/resize shrink-0 h-2 -mt-1.5 flex items-center justify-center cursor-ns-resize touch-none"
        title="Drag to resize"
      >
        <ResizeGrip orientation="horizontal" />
      </div>
    )
  }

  useEffect(() => {
    if (!compact) textareaRef.current?.focus()
  }, [compact])

  // Spawning blurs the composer: the textarea is disabled while the request is
  // in flight, and clicking the Spawn button put focus on the button (also
  // disabled) - so focus lands on <body> exactly when the user is ready to type
  // the next task. Put it back once the box is interactive again, so spawn after
  // spawn is pure typing. Only for the sidebar box; the full-page form unmounts
  // when the spawn navigates to the new agent (ref is null, so this is a no-op).
  const refocusRef = useRef(false)
  useEffect(() => {
    if (loading || !refocusRef.current) return
    refocusRef.current = false
    const ta = textareaRef.current
    if (!ta || ta.disabled) return
    // Don't steal focus if the user moved on during the spawn (clicked another
    // control, or a navigation focused something on the new agent's page).
    const active = document.activeElement
    if (active && active !== document.body && !cardRef.current?.contains(active)) return
    ta.focus()
  }, [loading])

  // Persist the in-progress prompt as a per-project draft so it survives page
  // reloads and project switches. The compact (sidebar) and full-page boxes use
  // distinct keys so their drafts never bleed into one another.
  const draftKey = projectId ? promptDraftKey(projectId, compact) : null
  const scrollKey = projectId ? promptScrollKey(projectId, compact) : null

  // Restore the project's saved scroll position on mount / project change. The
  // draft text itself is loaded alongside the attachments (and the history
  // baseline reset) in the effect below. The scroll offset is restored in a rAF
  // because the textarea's scrollable range only exists after that load commits
  // the new text to the DOM.
  useEffect(() => {
    const saved = scrollKey ? Number(readLocal(scrollKey)) || 0 : 0
    const raf = requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.scrollTop = saved
    })
    return () => cancelAnimationFrame(raf)
  }, [draftKey, scrollKey])

  // Apply a typed edit: one coalesced undo step per typing burst. Captures the
  // post-edit caret so undo/redo can restore it, and mirrors the draft to
  // localStorage like before.
  function handlePromptChange(value: string) {
    const ta = textareaRef.current
    const selStart = ta?.selectionStart ?? value.length
    const selEnd = ta?.selectionEnd ?? value.length
    commit((prev) => makeSnapshot(value, prev.attachments, selStart, selEnd), true)
    if (draftKey) writeLocal(draftKey, value || null)
  }

  // Persist the textarea's scroll offset so it travels with the draft when
  // switching projects (saved live on scroll; restored by the load effect above).
  function handlePromptScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    if (scrollKey) writeLocal(scrollKey, String(e.currentTarget.scrollTop))
  }

  // Per-project attachments + image counter, swapped in/out as the project (or
  // layout) changes so each box keeps its own - just like the text draft. See
  // spawnDrafts for the two tiers behind load/saveAttachments: a live cache that
  // carries object URLs and in-flight uploads across a project switch, over a
  // localStorage mirror of the settled uploads' paths that survives a reload.
  const storeKey = projectId ? spawnDraftKey(projectId, compact) : null
  // The box the cache calls below belong to, remembered because they run when
  // it is already the OUTGOING one (a project switch, or unmount).
  const prevStoreRef = useRef<{ key: string; projectId: string; compact: boolean } | null>(null)

  useEffect(() => {
    const prev = prevStoreRef.current
    if ((prev?.key ?? null) === storeKey) return
    // Stash the outgoing project's attachments before loading the new one's.
    if (prev) saveAttachments(prev.projectId, prev.compact, attachmentsRef.current)
    // A pasted block stashed for one box can't be "re-pasted" into another, and
    // undo history doesn't carry across a project switch.
    lastPasteRef.current = null
    pastedTextCounterRef.current = 0
    const loadedPrompt = draftKey ? (readLocal(draftKey) ?? '') : ''
    resetHistory(makeSnapshot(loadedPrompt, projectId ? loadAttachments(projectId, compact) : [], 0, 0))
    prevStoreRef.current = storeKey && projectId ? { key: storeKey, projectId, compact } : null
  }, [storeKey, draftKey, projectId, compact, resetHistory])

  // Mirror the attachments to the caches on every change, not only when the box
  // goes away: a page RELOAD runs no unmount, so a save deferred to teardown is
  // exactly the save that never happens - which is how a draft's attachments
  // used to vanish while its text came back. Cheap (a short list of paths), and
  // it keeps the durable tier in step with each upload as it settles.
  //
  // The first pass for a given box writes nothing: the load effect above hands
  // the hydrated list to resetHistory, so on that commit `attachments` is still
  // the OUTGOING box's (or the initial empty one) and saving it here would wipe
  // the very draft being restored. The following render carries the real list
  // and writes it back unchanged.
  const mirroredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId || !storeKey) return
    if (mirroredKeyRef.current !== storeKey) {
      mirroredKeyRef.current = storeKey
      return
    }
    saveAttachments(projectId, compact, attachments)
  }, [attachments, projectId, compact, storeKey])

  // Persist the current box's attachments on unmount too (the full-page form
  // remounts when navigating between projects), so an edit made in the same tick
  // as the teardown isn't lost.
  useEffect(() => {
    return () => {
      const prev = prevStoreRef.current
      if (prev) saveAttachments(prev.projectId, prev.compact, attachmentsRef.current)
    }
  }, [])

  // Clipboard screenshots all arrive named "image.png", so a multi-image prompt
  // ends up with several indistinguishable attachments. Rename those generic
  // (or unnamed) images to image1.png, image2.png, ... so the on-disk path - and
  // therefore the reference the user can type in the prompt - is unique. Files
  // Track one file as an uploading attachment chip, returning its id. The
  // uploaded path is appended to the prompt on submit (and so wired through to
  // the agent).
  function uploadAttachment(file: File): number {
    const id = nextAttachmentId()
    // One object URL per file, whatever it is: it backs the lightbox for every
    // attachment, and doubles as the thumbnail source for the images.
    const objectUrl = URL.createObjectURL(file)
    objectUrlsRef.current.add(objectUrl)
    const chip: Attachment = { id, filename: file.name || 'pasted-image', path: null, url: objectUrl, previewUrl: isImageFile(file) ? objectUrl : undefined, size: file.size, uploading: true }
    // Adding a chip is its own undo step.
    commit((prev) => makeSnapshot(prev.prompt, [...prev.attachments, chip], prev.selStart, prev.selEnd), false)
    // The upload resolving isn't a user action, so patch this chip across the
    // whole timeline (reconcile) instead of pushing a new undo step - undoing to
    // an earlier snapshot still sees the settled path, not a stale "uploading...".
    uploadFile(projectId, file)
      .then((res) => reconcile(id, { path: res.path, uploading: false }))
      .catch((err) => reconcile(id, { uploading: false, error: formatError(err) }))
    return id
  }

  // Upload each file as an attachment chip. Generically-named images are
  // renamed image<N>.ext, N = max(current) + 1 (running within the batch).
  // Returns the final (possibly renamed) filenames, for the paste markers.
  function addFiles(rawFiles: File[]): string[] {
    let nextN = nextGenericImageNumber(attachments)
    const names: string[] = []
    for (const raw of rawFiles) {
      let file = raw
      if (isImageFile(raw) && isGenericImageName(raw.name)) {
        const ext = (raw.name.match(/\.([^.]+)$/)?.[1] || raw.type.split('/')[1] || 'png').toLowerCase()
        file = new File([raw], `image${nextN}.${ext}`, { type: raw.type, lastModified: raw.lastModified })
        nextN++
      }
      uploadAttachment(file)
      names.push(file.name || 'pasted-image')
    }
    return names
  }

  // Attach a large text paste as a numbered file so it rides along like any
  // other attachment instead of burying the task description. The extension
  // comes from the clipboard's declared language (markdown -> .md, code -> its
  // ext), falling back to .txt, so the agent gets a correctly-typed file.
  function attachPastedText(text: string, dt: DataTransfer | null): { id: number; filename: string } {
    const n = ++pastedTextCounterRef.current
    const ext = pastedTextExtension(dt)
    const filename = `pasted-text-${n}.${ext}`
    return { id: uploadAttachment(new File([text], filename, { type: extensionMime(ext) })), filename }
  }

  // Insert "[filename]" markers into the prompt at the caret, as their own undo
  // step. The text before the caret decides whether they need a leading space;
  // they never carry a trailing one, so the caret stays against the "]".
  function insertPasteMarkers(names: string[]) {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? prompt.length
    const end = ta?.selectionEnd ?? prompt.length
    const insert = pasteMarkerText(names, prompt.slice(0, start))
    const caret = start + insert.length
    const nextPrompt = prompt.slice(0, start) + insert + prompt.slice(end)
    commit(
      (prev) => makeSnapshot(prev.prompt.slice(0, start) + insert + prev.prompt.slice(end), prev.attachments, caret, caret),
      false,
    )
    if (draftKey) writeLocal(draftKey, nextPrompt || null)
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = ta.selectionEnd = caret
    })
  }

  // Stable (memo'd AttachmentChips takes it as a prop): `commit` never changes.
  const removeAttachment = useCallback((id: number) => {
    // Don't revoke the preview URL here - an undo can bring this chip back. URLs
    // are freed in bulk once a spawn consumes the prompt (see objectUrlsRef).
    commit(
      (prev) => makeSnapshot(prev.prompt, prev.attachments.filter((a) => a.id !== id), prev.selStart, prev.selEnd),
      false,
    )
  }, [commit])

  // Stable lightbox opener: resolves the clicked chip to its index in the
  // openable list at click time (via the attachments mirror ref), so the
  // callback identity survives every attachment/typing change.
  const openLightbox = useCallback((id: number, origin: Element) => {
    setLightboxOrigin(origin)
    setLightboxIndex(openableAttachments(attachmentsRef.current).findIndex((a) => a.id === id))
  }, [])

  function handlePaste(e: React.ClipboardEvent) {
    // Consume the "paste literally" flag a Ctrl/Cmd+Shift+V keystroke set, so
    // it never lingers for a later paste.
    const literal = literalPasteRef.current
    literalPasteRef.current = false

    // Pasted files (screenshots, copied files) keep their upload behavior -
    // plus, with the preference on, "[filename]" markers at the caret so the
    // prompt references them explicitly.
    const files = extractFiles(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault()
      const names = addFiles(files)
      if (pasteMarkers && names.length > 0) insertPasteMarkers(names)
      return
    }

    // A Shift-held paste means "paste for real" - let the browser insert the
    // text as-is, never attaching it.
    if (literal) return

    // Small pastes go straight into the box like normal.
    const text = getClipboardText(e.clipboardData)
    if (!isLargePaste(text)) return

    const last = lastPasteRef.current
    if (last && last.text === text) {
      // Second paste of the same block: the user wants it inline after all. Drop
      // the chip AND splice the text in (fenced if it's code) as ONE undo step,
      // so a single Ctrl+Z reverses the inline - putting the block back in a chip.
      // The chip's "[filename]" marker (if the markers preference inserted one)
      // is stripped too, with the caret adjusted when it sat before it.
      e.preventDefault()
      const insert = last.lang ? fenceCode(text, last.lang) : text
      const ta = textareaRef.current
      let start = ta?.selectionStart ?? prompt.length
      let end = ta?.selectionEnd ?? prompt.length
      const stripped = stripPasteMarker(prompt, last.filename)
      if (stripped) {
        if (stripped.index < start) start = Math.max(stripped.index, start - stripped.length)
        if (stripped.index < end) end = Math.max(stripped.index, end - stripped.length)
      }
      const base = stripped?.text ?? prompt
      const caret = start + insert.length
      const nextPrompt = base.slice(0, start) + insert + base.slice(end)
      commit(
        (prev) => {
          const prevBase = stripPasteMarker(prev.prompt, last.filename)?.text ?? prev.prompt
          return makeSnapshot(
            prevBase.slice(0, start) + insert + prevBase.slice(end),
            prev.attachments.filter((a) => a.id !== last.attachmentId),
            caret,
            caret,
          )
        },
        false,
      )
      if (draftKey) writeLocal(draftKey, nextPrompt || null)
      requestAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        ta.selectionStart = ta.selectionEnd = caret
      })
      lastPasteRef.current = null
      return
    }

    // First paste of a large block: attach it instead of dumping it in the box.
    e.preventDefault()
    const { id, filename } = attachPastedText(text, e.clipboardData)
    if (pasteMarkers) insertPasteMarkers([filename])
    lastPasteRef.current = { text, attachmentId: id, filename, lang: detectCodeLanguage(e.clipboardData) }
  }

  function handleDrop(e: React.DragEvent) {
    const files = extractFiles(e.dataTransfer)
    setDragOver(false)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const uploading = attachments.some((a) => a.uploading)
  const readyAttachments = attachments.filter((a) => a.path && !a.error)
  // Every attachment that has bytes behind it, in chip order - the lightbox
  // navigates this list, and each chip opens its own index here.
  const lightboxItems = attachmentLightboxItems(attachments)
  const canSubmit = (!!prompt.trim() || readyAttachments.length > 0) && !uploading

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setError(null)
    // Whatever the outcome, the composer gets focus back once it re-enables
    // (see the effect above) - on an error too, so the prompt can be edited and
    // retried without reaching for the mouse.
    refocusRef.current = true
    try {
      // Append uploaded file paths so the agent receives them as part of the
      // task. They sit on their own lines below the typed prompt.
      const paths = readyAttachments.map((a) => a.path).join('\n')
      const base = prompt.trim()
      const finalPrompt = paths ? (base ? `${base}\n\n${paths}` : paths) : base
      // Seed the new head's PTY at this browser's last terminal width and either
      // its last height or the user's configured default - so the agent renders
      // at the right size from its first paint instead of the 80x24 default (its
      // narrow-wrapped scrollback can't be re-flowed once a wide client attaches).
      const geom = spawnGeometry()
      const req: SpawnAgentRequest = {
        prompt: finalPrompt,
        agent_type: agentType,
        // No id: the server derives one from the prompt and uniquifies it, so a
        // repeated prompt can never collide with an existing head.
        ...(model ? { model } : {}),
        // Structured chat is available for Claude and Codex; send the choice
        // explicitly so turning the toggle off wins over the server-side
        // default-on, and a remembered value never leaks into another agent type.
        ...(agentType === 'claude' || agentType === 'codex' ? { chat_mode: chatMode } : {}),
        // Adopting a PR takes precedence over (and ignores) the base branch: the
        // server bases the head on the PR head and its target branch.
        ...(adopt ? { adopt_mr: { id: adopt.id } } : baseBranch ? { base_branch: baseBranch } : {}),
        // Omit git_isolation when '' so the server applies the project policy default.
        ...(gitIsolation ? { git_isolation: gitIsolation } : {}),
        ...(geom.cols ? { cols: geom.cols } : {}),
        rows: geom.rows,
      }
      const agent = await api.default.spawnAgent(projectId ?? '', req)
      if (draftKey) writeLocal(draftKey, null)
      if (scrollKey) writeLocal(scrollKey, null)
      // The prompt is sent - free every preview URL minted this session (including
      // ones only reachable via undo history) and clear the composer.
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
      resetHistory(makeSnapshot('', [], 0, 0))
      if (projectId) saveAttachments(projectId, compact, [])
      setLightboxIndex(null)
      pastedTextCounterRef.current = 0
      lastPasteRef.current = null
      setAdopt(null)
      onSpawned?.(agent)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setLoading(false)
    }
  }

  // Renders the attachment chips row (shared by both layout variants). Clicking
  // an image chip opens the lightbox at that image's index.
  function renderAttachments(size: 'sm' | 'md') {
    return (
      <AttachmentChips
        attachments={attachments}
        size={size}
        className={`mx-3 ${size === 'sm' ? 'mb-1.5' : 'mb-2'}`}
        onRemove={removeAttachment}
        onOpen={openLightbox}
      />
    )
  }

  // The "work on an existing PR" control, rendered as the first section of the
  // spawn-options popover: while a PR is selected it shows a chip (with a
  // read-only lock when the PR can't be pushed to) plus a clear button; otherwise
  // the PRPicker trigger. Hidden on the built-in scratch project, which has no
  // forge to adopt from. It lives in the popover rather than inline because the
  // chip + picker overflowed the composer's footer row; the Spawn button switches
  // to "Adopt PR #n" so the choice is still visible without opening the cog.
  function renderAdoptControl() {
    if (isBuiltinProject || !projectId) return null
    if (adopt) {
      return (
        <div className="flex items-center gap-1 min-w-0">
          <Tooltip content={`Adopting PR #${adopt.id}: ${adopt.title}${adopt.can_push === false ? ' (read-only - no push access)' : ''}`}>
            <Badge
              tone="blue"
              icon={adopt.can_push === false ? <Lock className="w-3 h-3" /> : <GitBranch className="w-3 h-3" />}
            >
              <span className="max-w-[11rem] truncate">PR #{adopt.id} {adopt.title}</span>
            </Badge>
          </Tooltip>
          <Tooltip content="Don't adopt a PR">
            <button
              type="button"
              onClick={() => setAdopt(null)}
              aria-label="Don't adopt a PR"
              className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </Tooltip>
        </div>
      )
    }
    return <PRPicker projectId={projectId} onSelect={setAdopt} />
  }

  // Put every control in the options popover back to its default: no PR adopted,
  // the project's current branch as the base, chat mode (which is what a user who
  // has never touched the toggle gets), and the project's git-isolation policy.
  // Resetting the run mode also re-persists it, like any other pick of it does.
  function resetSpawnOptions() {
    setAdopt(null)
    setBaseBranch(defaultBranch)
    setChatMode(true)
    setGitIsolation('')
  }

  // Both spawn layouts collapse the per-spawn options into a single settings cog,
  // styled like the per-section options popovers elsewhere. Ordered widest-effect
  // first: the PR to adopt (which decides the base branch for you), the base
  // branch, the run mode, then git isolation. Git isolation applies to every
  // head, so the cog always renders.
  function renderSpawnSettings() {
    const showChat = agentType === 'claude' || agentType === 'codex'
    const adoptControl = renderAdoptControl()
    // While adopting a PR the base branch is the PR's target, chosen server-side,
    // so the base-branch section is suppressed (mirrors renderAdoptControl).
    const showBranch = !!branches && branches.length > 0 && !isBuiltinProject && !adopt
    // What is set to something other than its default, in the popover's own
    // order. Everything in here is invisible once the panel closes, so the cog
    // wears the "on" look and this list becomes its tooltip - a spawn that
    // stacks on another branch, or unlocks .git, should never be a surprise.
    // Run mode counts even though the choice is remembered across spawns: it is
    // the one remembered pick with no representation outside this panel (the
    // agent and model both show on the picker trigger beside it).
    const nonDefaults: string[] = []
    if (adopt) nonDefaults.push(`Pull request: #${adopt.id}`)
    if (showBranch && baseBranch && defaultBranch && baseBranch !== defaultBranch) {
      nonDefaults.push(`Base branch: ${baseBranch}`)
    }
    if (showChat && !chatMode) nonDefaults.push('Run mode: terminal')
    if (gitIsolation) {
      nonDefaults.push(`Git isolation: ${GIT_ISOLATION_OPTS.find((o) => o.id === gitIsolation)?.label ?? gitIsolation}`)
    }
    // A two-option segmented control: a chat-mode head opens the web chat view,
    // otherwise the head runs in a terminal. `chatMode === false` selects the
    // terminal segment.
    const modeSegment = (active: boolean) =>
      `flex items-center gap-1.5 px-2.5 py-1 font-medium transition-colors cursor-pointer ${active
        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`
    return (
      <SettingsPopover
        label="Spawn options"
        width={260}
        align="left"
        fitContent
        active={nonDefaults.length > 0}
        tooltip={nonDefaults.length > 0 ? (
          <span className="block text-left">
            <span className="block font-semibold">Spawn options</span>
            {nonDefaults.map((d) => <span key={d} className="block">{d}</span>)}
          </span>
        ) : undefined}
        onReset={nonDefaults.length > 0 ? resetSpawnOptions : undefined}
        resetLabel="Reset spawn options to their defaults"
      >
        {adoptControl && (
          <>
            <SettingsGroupLabel className="mb-1.5">Pull request</SettingsGroupLabel>
            {adoptControl}
            <div className="my-2.5 border-t border-gray-100 dark:border-gray-700" />
          </>
        )}
        {showBranch && branches && (
          <>
            <SettingsGroupLabel className="mb-1.5">Base branch</SettingsGroupLabel>
            <BranchSelector
              branches={branches}
              activeRef={baseBranch}
              isKnownBranch={branches.some((b) => b.name === baseBranch)}
              onSelect={setBaseBranch}
              onOpen={handleBranchOpen}
              title="Base branch to create the agent from (pick an agent branch to stack on it)"
              fitContent
            />
            <div className="my-2.5 border-t border-gray-100 dark:border-gray-700" />
          </>
        )}
        {showChat && <SettingsGroupLabel className="mb-1.5">Run mode</SettingsGroupLabel>}
        {showChat && (
          <div className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs">
            <button type="button" aria-pressed={!chatMode} onClick={() => setChatMode(false)} className={modeSegment(!chatMode)}>
              <SquareTerminal className="w-3.5 h-3.5" />
              terminal
            </button>
            <button type="button" aria-pressed={chatMode} onClick={() => setChatMode(true)} className={`border-l border-gray-200 dark:border-gray-600 ${modeSegment(chatMode)}`}>
              <MessageSquare className="w-3.5 h-3.5" />
              chat
            </button>
          </div>
        )}
        {showChat && (
          <div className="my-2.5 border-t border-gray-100 dark:border-gray-700" />
        )}
        {/* Git isolation (per-head override; Default inherits the project policy,
            which is readonly unless the project sets otherwise). Last in the
            popover, as a dropdown: its options carry two-line explanations that
            crowded out the other controls when listed inline. See
            docs/git-isolation.md. */}
        <SettingsGroupLabel className="mb-1.5">Git isolation</SettingsGroupLabel>
        <SettingsSelect
          label="Git isolation"
          value={gitIsolation}
          onChange={setGitIsolation}
          options={GIT_ISOLATION_OPTS.map((o) => {
            // readonly commits go through the hydra git tools, which only claude/
            // codex/gemini get - disable it for others (the server downgrades to
            // off anyway).
            const disabled = o.id === 'readonly' && !GIT_TOOL_AGENTS.includes(agentType)
            return { ...o, disabled, desc: disabled ? `Not available for ${agentType} (no git tools).` : o.desc }
          })}
        />
      </SettingsPopover>
    )
  }

  // Restore a snapshot returned by undo/redo: re-mirror the draft and put the
  // caret back where it was when that snapshot was current (after the controlled
  // value commits to the DOM, hence the rAF).
  function restoreSnapshot(snap: ReturnType<typeof undo>) {
    if (!snap) return
    if (draftKey) writeLocal(draftKey, snap.prompt || null)
    const ta = textareaRef.current
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = snap.selStart
      ta.selectionEnd = snap.selEnd
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
    // Undo/redo over the composer's own history (text + attachments). Only on the
    // prompt textarea - the agent-id field keeps its native per-field undo. Our
    // stack drives these because pastes-turned-chips call preventDefault, so the
    // browser's textarea undo never recorded them. Cmd/Ctrl+Z undo, +Shift redo,
    // and Ctrl+Y redo (Windows convention).
    if (e.currentTarget === textareaRef.current && mod && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'z') {
        e.preventDefault()
        restoreSnapshot(e.shiftKey ? redo() : undo())
        return
      }
      if (key === 'y' && !e.shiftKey) {
        e.preventDefault()
        restoreSnapshot(redo())
        return
      }
    }
    // Ctrl/Cmd+Shift+V ("paste as plain text") should paste for real, not
    // attach. The paste event carries no modifier state, so flag it here on the
    // keystroke that triggers it (the flag is consumed by the paste that
    // follows; a timer clears it if none does, so it can't go stale).
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      literalPasteRef.current = true
      setTimeout(() => { literalPasteRef.current = false }, 1000)
    }
  }

  const submitHint = isMac ? '⌘↵ to spawn' : 'Ctrl+Enter to spawn'

  // Shared across both layout variants. The index can fall out of range if an
  // image is removed while open, so clamp it and close when there are none left.
  const lightbox =
    lightboxIndex !== null && lightboxItems.length > 0 ? (
      <Lightbox
        items={lightboxItems}
        index={Math.min(lightboxIndex, lightboxItems.length - 1)}
        origin={lightboxOrigin}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    ) : null

  if (compact) {
    return (
      <>
      <form onSubmit={handleSubmit} className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
        <div className={`relative rounded-xl p-[1.5px] transition-colors duration-200 ${disabled ? 'bg-gray-100 dark:bg-gray-700' : 'bg-gray-200 dark:bg-gray-600 focus-within:bg-gradient-to-br focus-within:from-blue-500 focus-within:via-indigo-500 focus-within:to-purple-600 focus-within:shadow-md focus-within:shadow-blue-500/20'}`}>
          <div ref={cardRef} className="rounded-[10px] bg-white dark:bg-gray-800 overflow-hidden flex flex-col min-h-[128px]">
            <HighlightedTextarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={handlePromptScroll}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              placeholder={disabled ? 'Select a project first...' : 'Describe a task...'}
              rows={3}
              disabled={loading || disabled}
              wrapperClassName={`w-full flex-1 min-h-0 ${dragOver ? 'ring-2 ring-blue-400 rounded' : ''}`}
              textClassName="px-3 pt-2.5 pb-1 text-xs leading-relaxed placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
            />
            {renderAttachments('sm')}
            <div className="flex items-center justify-between px-2 pb-2 gap-1.5 shrink-0">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <Tooltip content="Attach files" side="top">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading || disabled}
                    // h-7 w-7, not padding: every control on this row states
                    // the same height so they line up as one band. The icon
                    // stays small - the box grew, not the mark.
                    className="flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                  >
                    <Paperclip className="w-3 h-3" />
                  </button>
                </Tooltip>
                <AgentModelPicker agent={agentType} model={model} onChange={handleAgentModelChange} size="sm" />
              </div>
              {renderSpawnSettings()}
              <button
                type="submit"
                disabled={!canSubmit || loading || disabled}
                className="relative overflow-hidden flex h-7 items-center text-3xs font-semibold px-2.5 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
              >
                {loading ? '...' : adopt ? 'Adopt PR' : 'Spawn'}
              </button>
            </div>
            {renderResizeHandle()}
          </div>
        </div>
        {error && (
          <p className="mt-1.5 text-3xs text-red-500 leading-snug">{error}</p>
        )}
      </form>
      {lightbox}
      </>
    )
  }

  // Full-page (empty state) variant
  return (
    <>
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl min-w-0">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/30 mb-4">
            <Zap className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent animate-gradient">
            Spawn an Agent
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Describe what you need - and consider it done.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-2xl shadow-blue-500/20">
            <div ref={cardRef} className="rounded-[14px] bg-white dark:bg-gray-800 overflow-hidden flex flex-col min-h-[180px]">
              {/* Prompt textarea */}
              <HighlightedTextarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onScroll={handlePromptScroll}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                placeholder="Describe what you need..."
                rows={6}
                disabled={loading}
                wrapperClassName={`w-full flex-1 min-h-0 ${dragOver ? 'ring-2 ring-blue-400 rounded' : ''}`}
                textClassName="px-4 pt-4 pb-2 text-sm leading-relaxed placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
              />

              {renderAttachments('md')}

              {/* Footer bar - stacks the controls above the Spawn button on
                  narrow screens instead of overflowing the card */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-700 gap-3 shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-wrap sm:flex-1">
                  {/* Attach files */}
                  <Tooltip content="Attach files" side="top">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={loading}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                  </Tooltip>
                  {/* Agent + model picker (icon trigger + grouped dropdown) */}
                  <AgentModelPicker agent={agentType} model={model} onChange={handleAgentModelChange} />
                  {renderSpawnSettings()}
                </div>
                <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                  <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500">{submitHint}</span>
                  <button
                    type="submit"
                    disabled={!canSubmit || loading}
                    className="relative overflow-hidden flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 animate-gradient shadow-md shadow-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                        {adopt ? 'Adopting...' : 'Spawning...'}
                      </>
                    ) : adopt ? (
                      <>
                        <GitBranch className="w-3.5 h-3.5" />
                        Adopt PR #{adopt.id}
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        Spawn Agent
                      </>
                    )}
                  </button>
                </div>
              </div>
              {renderResizeHandle()}
            </div>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </form>
      </div>
    </div>
    {lightbox}
    </>
  )
})
