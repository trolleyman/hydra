import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse, SpawnAgentRequest, RepositoryBranch } from '../api'
import { formatError } from '../api/format_error'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { Zap, LoaderCircle, Paperclip, Check, GitBranch, MessageSquare, SlidersHorizontal, Shield, Bot } from 'lucide-react'
import { AgentTypeIcon } from './AgentTypeIcon'
import { AGENT_ACCENT } from '../lib/agentTypeMeta'
import { Tooltip } from './Tooltip'
import { ImageLightbox } from './ImageLightbox'
import { AttachmentChips } from './AttachmentChips'
import { StorageKeys, promptDraftKey, promptScrollKey, readLocal, writeLocal } from '../lib/storage'
import { HighlightedTextarea } from './HighlightedTextarea'
import { spawnGeometry } from '../lib/terminalGeometry'
import { type Attachment, spawnDraftKey, loadAttachments, saveAttachments, nextAttachmentId, isGenericImageName, nextGenericImageNumber } from '../lib/spawnDrafts'
import { getClipboardText, isLargePaste, detectCodeLanguage, fenceCode, pastedTextExtension, extensionMime, pasteMarkerText, stripPasteMarker } from '../lib/pastedText'
import { usePasteMarkersStore } from '../lib/composerPrefs'
import { ResizeGrip } from './ResizeGrip'
import { useComposerHistory, makeSnapshot } from '../lib/composerHistory'
import { useProjectStore } from '../stores/projectStore'

type AgentTypeOption = 'claude' | 'gemini' | 'copilot' | 'codex'

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

// The remembered-model map (agent type → model alias) persisted in localStorage,
// so picking a model seeds the next spawn of that same agent type.
function readModelMap(): Record<string, string> {
  try {
    const raw = readLocal(StorageKeys.defaultModel)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
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
  const trigger = size === 'sm' ? 'h-6' : 'h-7'
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
          className={`flex items-center gap-0.5 rounded-full border transition-colors cursor-pointer ${label ? 'pr-1.5' : size === 'sm' ? 'w-6 justify-center' : 'w-7 justify-center'} ${trigger} ${
            open
              ? 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600'
              : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <span className={`flex items-center justify-center rounded-full ${iconWrap} ${active.color}`}>
            <AgentTypeIcon name={active.id} className={iconCls} />
          </span>
          {label && <span className="text-[10px] font-medium text-gray-600 dark:text-gray-300 max-w-[4rem] truncate">{label}</span>}
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
              <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
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
// rest are explicit per-head overrides. See GIT_ISOLATION.md.
const GIT_ISOLATION_OPTS: { id: string; label: string; desc: string }[] = [
  { id: '', label: 'Default', desc: "Project's policy default." },
  { id: 'off', label: 'Off', desc: 'Full .git access.' },
  { id: 'refs', label: 'Refs read-only', desc: "No branch switch; commit via tool." },
  { id: 'readonly', label: 'Read-only .git', desc: 'No .git writes; commit host-side.' },
]

// SpawnOptionsMenu is the "..." kebab on the spawn box that groups the per-spawn
// options that don't warrant their own always-visible control: chat view (Claude
// only), git isolation, and the base branch. Mirrors AgentModelPicker's
// fixed-position dropdown (which escapes the card's overflow-hidden) and flips
// above the trigger when there isn't room below (the sidebar footer sits low).
const SpawnOptionsMenu = memo(function SpawnOptionsMenu({
  agentType, chatMode, setChatMode, gitIsolation, setGitIsolation,
  branches, baseBranch, setBaseBranch, onBranchOpen, isBuiltinProject, loading, disabled, size = 'md',
}: {
  agentType: AgentTypeOption
  chatMode: boolean
  setChatMode: (v: boolean) => void
  gitIsolation: string
  setGitIsolation: (v: string) => void
  branches: RepositoryBranch[] | null
  baseBranch: string
  setBaseBranch: (v: string) => void
  onBranchOpen: () => void
  isBuiltinProject: boolean
  loading: boolean
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const PANEL = 380
    const spaceBelow = window.innerHeight - r.bottom
    if (spaceBelow < PANEL && r.top > spaceBelow) {
      setCoords({ left: r.left, bottom: window.innerHeight - r.top + 4 })
    } else {
      setCoords({ left: r.left, top: r.bottom + 4 })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    onBranchOpen() // refresh the branch list on open, like BranchSelector
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place, onBranchOpen])

  // The kebab lights up when any option deviates from its default, so a
  // non-obvious choice (a locked .git, a stacked base branch) is visible at rest.
  const active = chatMode || gitIsolation !== '' || (baseBranch !== '' && !branches?.some((b) => b.name === baseBranch && b.is_current))
  const btn = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7'
  const icon = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'

  const current = branches?.find((b) => b.is_current)
  const agentBranches = branches?.filter((b) => b.is_agent && !b.is_current) ?? []
  const otherBranches = branches?.filter((b) => !b.is_agent && !b.is_current) ?? []

  // A plain render helper (not a nested component) so it can close over the
  // setters without tripping react/no-unstable-nested-components.
  const branchRow = (b: RepositoryBranch) => (
    <button
      key={b.name}
      type="button"
      onClick={() => { setBaseBranch(b.name); setOpen(false) }}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
    >
      {b.is_agent ? <Bot className="w-3.5 h-3.5 shrink-0 text-purple-500" /> : <GitBranch className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
      <span className="truncate font-mono">{b.name}</span>
      {b.is_current && <span className="ml-1 text-[9px] px-1 py-px rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 shrink-0">HEAD</span>}
      {b.name === baseBranch && <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-blue-500" />}
    </button>
  )

  return (
    <div ref={ref} className="relative shrink-0">
      <Tooltip content="Spawn options (chat, git isolation, base branch)" side="top">
        <button
          ref={btnRef}
          type="button"
          aria-label="Spawn options"
          onClick={() => { if (!open) place(); setOpen((o) => !o) }}
          disabled={loading || disabled}
          className={`flex items-center justify-center rounded-lg border transition-colors cursor-pointer disabled:opacity-40 shrink-0 ${btn} ${
            open || active
              ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
              : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <SlidersHorizontal className={icon} />
        </button>
      </Tooltip>
      {open && coords && (
        <div
          style={{ position: 'fixed', left: coords.left, top: coords.top, bottom: coords.bottom }}
          className="w-64 max-h-[380px] overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
        >
          {/* Git isolation */}
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            <span>Git isolation</span>
          </div>
          {GIT_ISOLATION_OPTS.map((o) => (
            <button
              key={o.id || 'default'}
              type="button"
              onClick={() => setGitIsolation(o.id)}
              className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
            >
              <span className="w-3.5 shrink-0 pt-0.5">{gitIsolation === o.id && <Check className="w-3.5 h-3.5 text-blue-500" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-gray-700 dark:text-gray-200">{o.label}</span>
                <span className="block text-[10px] text-gray-400 dark:text-gray-500 leading-snug break-words">{o.desc}</span>
              </span>
            </button>
          ))}

          {/* Chat view (Claude + Codex - CLIs with a structured transport) */}
          {(agentType === 'claude' || agentType === 'codex') && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
              <button
                type="button"
                onClick={() => setChatMode(!chatMode)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                <span className="text-xs text-gray-700 dark:text-gray-200">Chat view</span>
                <span className={`ml-auto text-[10px] px-1.5 py-px rounded ${chatMode ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-400'}`}>{chatMode ? 'On' : 'Off'}</span>
              </button>
            </>
          )}

          {/* Base branch. Hidden for the built-in scratch project, which has no
              work to stack on - picking a base there is just noise. */}
          {!isBuiltinProject && branches && branches.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
              <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
                <GitBranch className="w-3.5 h-3.5 shrink-0" />
                <span>Base branch</span>
              </div>
              {current && branchRow(current)}
              {agentBranches.length > 0 && (
                <>
                  <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold text-gray-400 dark:text-gray-500">Agent branches · {agentBranches.length}</p>
                  {agentBranches.map((b) => branchRow(b))}
                </>
              )}
              {otherBranches.length > 0 && (
                <>
                  <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold text-gray-400 dark:text-gray-500">Other branches · {otherBranches.length}</p>
                  {otherBranches.map((b) => branchRow(b))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

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
  const [agentType, setAgentType] = useState<AgentTypeOption>(() => {
    const saved = readLocal(StorageKeys.defaultAgentType)
    if (saved && (saved === 'claude' || saved === 'gemini' || saved === 'copilot' || saved === 'codex')) {
      return saved as AgentTypeOption
    }
    return 'claude'
  })
  // Model alias for the CLI's --model flag ('' = the CLI's own default). Seeded
  // from the remembered map for the initial agent type; the picker sets agent +
  // model together, and the effect below persists the pick per agent type.
  const [model, setModel] = useState<string>(() => readModelMap()[agentType] ?? '')
  // Chat mode: drive Claude or Codex via its structured protocol and
  // show a chat view instead of a terminal. Remembered like the agent/model.
  const [chatMode, setChatMode] = useState(() => readLocal(StorageKeys.defaultChatMode) === 'true')
  // Per-head git-isolation override ('' = use the project's policy default, so the
  // request omits git_isolation). See GIT_ISOLATION.md. Not persisted: a locked
  // .git is a deliberate per-spawn choice, defaulted to the project policy.
  const [gitIsolation, setGitIsolation] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Base branch the new agent will be created from. Defaults to the project's
  // current branch; can be pointed at another agent's hydra/<id> branch to stack
  // agents on top of one another. `branches` is null until the list loads.
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const [baseBranch, setBaseBranch] = useState('')
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
      return
    }
    try {
      const res = await api.default.getRepositoryBranches(projectId)
      if (branchReqProjectRef.current !== projectId) return
      setBranches(res.branches)
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
  // layout) changes so each box keeps its own - just like the text draft. The
  // attachments live in an in-session module cache (their thumbnails are object
  // URLs that can't be persisted); the counter is mirrored to localStorage.
  const storeKey = projectId ? spawnDraftKey(projectId, compact) : null
  const prevStoreKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const prev = prevStoreKeyRef.current
    if (prev === storeKey) return
    // Stash the outgoing project's attachments before loading the new one's.
    if (prev) saveAttachments(prev, attachmentsRef.current)
    // A pasted block stashed for one box can't be "re-pasted" into another, and
    // undo history doesn't carry across a project switch.
    lastPasteRef.current = null
    pastedTextCounterRef.current = 0
    const loadedPrompt = draftKey ? (readLocal(draftKey) ?? '') : ''
    resetHistory(makeSnapshot(loadedPrompt, storeKey ? loadAttachments(storeKey) : [], 0, 0))
    prevStoreKeyRef.current = storeKey
  }, [storeKey, draftKey, resetHistory])

  // Persist the current box's attachments to the cache on unmount (the
  // full-page form remounts when navigating between projects).
  useEffect(() => {
    return () => {
      const key = prevStoreKeyRef.current
      if (key) saveAttachments(key, attachmentsRef.current)
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
    const previewUrl = isImageFile(file) ? URL.createObjectURL(file) : undefined
    if (previewUrl) objectUrlsRef.current.add(previewUrl)
    const chip: Attachment = { id, filename: file.name || 'pasted-image', path: null, previewUrl, size: file.size, uploading: true }
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

  // Insert text into the prompt at the caret, as its own undo step - used for
  // the "[filename]" paste markers.
  function insertAtCaret(insert: string) {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? prompt.length
    const end = ta?.selectionEnd ?? prompt.length
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
  // image-only list at click time (via the attachments mirror ref), so the
  // callback identity survives every attachment/typing change.
  const openImageLightbox = useCallback((id: number) => {
    setLightboxIndex(attachmentsRef.current.filter((a) => a.previewUrl).findIndex((img) => img.id === id))
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
      if (pasteMarkers && names.length > 0) insertAtCaret(pasteMarkerText(names))
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
    if (pasteMarkers) insertAtCaret(pasteMarkerText([filename]))
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
  // Image attachments (those with a preview), in chip order - the lightbox
  // navigates this list, and each thumbnail opens its own index here.
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  const canSubmit = (!!prompt.trim() || readyAttachments.length > 0) && !uploading

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setError(null)
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
        // Structured chat is available for Claude and Codex; a remembered value
        // must not leak into another agent type's spawn.
        ...((agentType === 'claude' || agentType === 'codex') && chatMode ? { chat_mode: true } : {}),
        ...(baseBranch ? { base_branch: baseBranch } : {}),
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
      if (storeKey) saveAttachments(storeKey, [])
      setLightboxIndex(null)
      pastedTextCounterRef.current = 0
      lastPasteRef.current = null
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
        onOpenImage={openImageLightbox}
      />
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
    lightboxIndex !== null && lightboxImages.length > 0 ? (
      <ImageLightbox
        images={lightboxImages}
        index={Math.min(lightboxIndex, lightboxImages.length - 1)}
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
                    className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                  >
                    <Paperclip className="w-3 h-3" />
                  </button>
                </Tooltip>
                <AgentModelPicker agent={agentType} model={model} onChange={handleAgentModelChange} size="sm" />
                <SpawnOptionsMenu
                  agentType={agentType} chatMode={chatMode} setChatMode={setChatMode}
                  gitIsolation={gitIsolation} setGitIsolation={setGitIsolation}
                  branches={branches} baseBranch={baseBranch} setBaseBranch={setBaseBranch}
                  onBranchOpen={handleBranchOpen} isBuiltinProject={isBuiltinProject} loading={loading} disabled={disabled} size="sm"
                />
              </div>
              <button
                type="submit"
                disabled={!canSubmit || loading || disabled}
                className="relative overflow-hidden text-[10px] font-semibold px-2.5 py-1 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
              >
                {loading ? '...' : 'Spawn'}
              </button>
            </div>
            {renderResizeHandle()}
          </div>
        </div>
        {error && (
          <p className="mt-1.5 text-[10px] text-red-500 leading-snug">{error}</p>
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
                  <SpawnOptionsMenu
                    agentType={agentType} chatMode={chatMode} setChatMode={setChatMode}
                    gitIsolation={gitIsolation} setGitIsolation={setGitIsolation}
                    branches={branches} baseBranch={baseBranch} setBaseBranch={setBaseBranch}
                    onBranchOpen={handleBranchOpen} isBuiltinProject={isBuiltinProject} loading={loading} disabled={disabled}
                  />
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
                        Spawning...
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
