import { useRef, useState, type ReactNode } from 'react'
import type { AgentConfig, McpServer, NetworkConfig, PolicyConfig, ProjectInfo, SandboxCacheConfig, SandboxConfig } from '../../api'
import { X, Plus, Globe, FolderOpen, EyeOff, Eye, Layers, Terminal, Maximize2, Puzzle, TriangleAlert, Lock, KeyRound, Database } from 'lucide-react'
import { InfoTooltip } from '../InfoTooltip'
import { Tooltip } from '../Tooltip'
import { ShellEditor } from '../ShellEditor'
import { Markdown } from '../../lib/MarkdownRenderer'
import { HighlightedTextarea } from '../HighlightedTextarea'
import { HighlightedInput } from '../HighlightedInput'
import { HostName } from '../HostName'
import { ResizeHandle } from '../../lib/ResizeHandle'

// The four egress postures, mirroring sandbox.NetworkMode on the backend.
type NetworkMode = 'off' | 'unrestricted' | 'advisory' | 'hard'

// Segment order (safest -> most open, then fully off) and the short pill labels.
const NETWORK_MODES: NetworkMode[] = ['hard', 'advisory', 'unrestricted', 'off']
const NETWORK_MODE_LABELS: Record<NetworkMode, string> = {
  hard: 'Hard',
  advisory: 'Advisory',
  unrestricted: 'Unrestricted',
  off: 'Off',
}

// Amber caution shown below the selector for any non-default posture. Hard (the
// secure default) needs none; the other three each weaken or drop the boundary.
const NETWORK_MODE_WARNINGS: Partial<Record<NetworkMode, string>> = {
  advisory: 'Advisory filtering is enforced only by the per-head proxy - a determined process can bypass it. Not an inescapable boundary.',
  unrestricted: 'No filtering: the agent can reach any host on the network. Only use for fully trusted work.',
  off: 'No network access at all - tools that fetch dependencies or call APIs will fail.',
}

// The two git-isolation modes, mirroring sandbox.GitIsolationMode on the backend.
// (Ordered gentlest -> strictest, like the network control.)
type GitIsolation = 'off' | 'readonly'
const GIT_ISOLATION_MODES: GitIsolation[] = ['off', 'readonly']
const GIT_ISOLATION_LABELS: Record<GitIsolation, string> = {
  off: 'Off',
  readonly: 'Read-only .git',
}

// Animated segmented control: a single "thumb" slides under the active pill
// (transform-based so it's GPU-cheap and honours reduced-motion via the CSS
// class); the labels themselves just cross-fade their colour. Shared by the
// network-egress and git-isolation selectors.
function SegmentedControl<T extends string>({ options, labels, value, onChange }: {
  options: T[]
  labels: Record<T, string>
  value: T
  onChange: (m: T) => void
}) {
  const activeIndex = Math.max(0, options.indexOf(value))
  return (
    <div className="relative flex w-full rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
      <div
        aria-hidden
        className="pointer-events-none absolute top-1 bottom-1 left-1 rounded-md bg-white dark:bg-gray-700 shadow-sm ring-1 ring-black/[0.03] dark:ring-white/5 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width: `calc((100% - 0.5rem) / ${options.length})`, transform: `translateX(${activeIndex * 100}%)` }}
      />
      {options.map((m) => {
        const isActive = m === value
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={isActive}
            className={`relative z-10 flex-1 px-2 py-1.5 rounded-md text-2xs font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 ${
              isActive
                ? 'text-gray-900 dark:text-gray-100'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {labels[m]}
          </button>
        )
      })}
    </div>
  )
}

// ── PathListEditor ──────────────────────────────────────────────────────────────
// Edits a list of filesystem paths (writable / masked / restore-RO / allowed hosts).
// The row's box model, shared by the plain input and - when an entry is
// highlighted - by both layers of the HighlightedInput, which only line up if
// their padding and font metrics are identical.
const LIST_ROW_TEXT = 'text-sm px-3 py-2 font-mono'
// The chrome around it. On the highlighted variant this moves to the wrapper
// (as focus-within:), since the input itself is transparent and sits ON TOP of
// the backdrop - a focus ring drawn there would frame the text from above.
const LIST_ROW_CHROME =
  'rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-inner transition-all'
const LIST_ROW_PLACEHOLDER = 'placeholder-gray-300 dark:placeholder-gray-600'

// An allow/block-list entry, lowlit like every other host Hydra shows: the
// subdomain labels fade (as does a leading `*.` wildcard marker) and the
// registrable domain stays. Reading an entry off this list is the same job as
// reading a host off an approval card - where the domain ends is the whole
// content of the line, and it is exactly what a lookalike hides.
const renderHostEntry = (value: string) => <HostName host={value} />

export function PathListEditor({
  paths,
  onChange,
  placeholder,
  addLabel,
  renderValue,
}: {
  paths: string[]
  onChange: (paths: string[] | null) => void
  placeholder?: string
  addLabel?: string
  // Optional highlighting for each entry, rendered behind a transparent input
  // (see HighlightedInput). Used for the host allow/block lists; the path lists
  // have nothing to highlight and stay plain inputs.
  renderValue?: (value: string) => ReactNode
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const addAfter = (index: number) => {
    const next = [...paths]
    next.splice(index + 1, 0, '')
    onChange(next)
    requestAnimationFrame(() => inputRefs.current[index + 1]?.focus())
  }
  return (
    <div className="space-y-2 pt-0.5">
      {paths.map((p, index) => (
        <div key={index} className="flex items-center gap-2">
          {renderValue ? (
            <HighlightedInput
              ref={(el) => { inputRefs.current[index] = el }}
              value={p}
              onChange={(e) => {
                const next = [...paths]
                next[index] = e.target.value
                onChange(next)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                addAfter(index)
              }}
              placeholder={placeholder}
              spellCheck={false}
              renderContent={renderValue}
              textClassName={`${LIST_ROW_TEXT} ${LIST_ROW_PLACEHOLDER}`}
              wrapperClassName={`flex-1 ${LIST_ROW_CHROME} focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500`}
            />
          ) : (
            <input
              ref={(el) => { inputRefs.current[index] = el }}
              type="text"
              value={p}
              onChange={(e) => {
                const next = [...paths]
                next[index] = e.target.value
                onChange(next)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                addAfter(index)
              }}
              placeholder={placeholder}
              spellCheck={false}
              className={`flex-1 ${LIST_ROW_TEXT} ${LIST_ROW_CHROME} ${LIST_ROW_PLACEHOLDER} text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500`}
            />
          )}
          <button
            onClick={() => {
              const next = paths.filter((_, i) => i !== index)
              onChange(next.length > 0 ? next : null)
            }}
            className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...paths, ''])}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
        {addLabel ?? 'Add Path'}
      </button>
    </div>
  )
}

export function CacheListEditor({
  caches,
  inheritedCaches,
  onChange,
}: {
  caches: Record<string, SandboxCacheConfig>
  inheritedCaches?: Record<string, SandboxCacheConfig>
  onChange: (caches: Record<string, SandboxCacheConfig> | null) => void
}) {
  const entries = Object.entries(caches).sort(([a], [b]) => a.localeCompare(b))
  const update = (oldKey: string, nextKey: string, entry: SandboxCacheConfig) => {
    const next = { ...caches }
    delete next[oldKey]
    next[nextKey] = entry
    onChange(next)
  }
  const add = () => {
    let index = 1
    while (`cache_${index}` in caches) index++
    onChange({ ...caches, [`cache_${index}`]: { env: '' } })
  }
  return (
    <div className="space-y-2 pt-0.5">
      {inheritedCaches && Object.keys(inheritedCaches).length > 0 && (
        <p className="text-2xs text-gray-400 dark:text-gray-500 italic ml-0.5">
          Inherited: <span className="font-mono">{Object.keys(inheritedCaches).sort().join(', ')}</span>
        </p>
      )}
      {entries.map(([key, entry]) => {
        const kind = entry.path != null ? 'path' : 'env'
        const target = kind === 'path' ? entry.path ?? '' : entry.env ?? ''
        return (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,1.25fr)_1.75rem] items-center gap-2">
            <CacheKeyInput
              cacheKey={key}
              cacheKeys={Object.keys(caches)}
              onRename={(nextKey) => update(key, nextKey, entry)}
            />
            <select
              aria-label={`Cache type for ${key}`}
              value={kind}
              onChange={(e) => update(key, key, e.target.value === 'path' ? { path: target } : { env: target })}
              className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-2 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            >
              <option value="env">Env</option>
              <option value="path">Path</option>
            </select>
            <input
              aria-label={`Cache target for ${key}`}
              value={target}
              onChange={(e) => update(key, key, kind === 'path' ? { path: e.target.value } : { env: e.target.value })}
              placeholder={kind === 'path' ? 'e.g. build/cache' : 'e.g. GOCACHE'}
              spellCheck={false}
              className={`${LIST_ROW_TEXT} ${LIST_ROW_CHROME} ${LIST_ROW_PLACEHOLDER} min-w-0 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500`}
            />
            <button
              type="button"
              aria-label={`Remove cache ${key}`}
              onClick={() => {
                const next = { ...caches }
                delete next[key]
                onChange(Object.keys(next).length > 0 ? next : null)
              }}
              className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )
      })}
      <button type="button" onClick={add} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer">
        <Plus className="w-3.5 h-3.5" /> Add cache
      </button>
    </div>
  )
}

function CacheKeyInput({
  cacheKey,
  cacheKeys,
  onRename,
}: {
  cacheKey: string
  cacheKeys: string[]
  onRename: (nextKey: string) => void
}) {
  // Keep the name as a draft until commit. Using the live map key as both the
  // input value and React row key remounts the row after every keystroke, which
  // drops focus; committing a duplicate immediately also overwrites its entry.
  const [draft, setDraft] = useState(cacheKey)
  const [error, setError] = useState('')

  const commit = () => {
    if (draft === cacheKey) return
    if (!/^[A-Za-z0-9_-]+$/.test(draft) || draft === '.' || draft === '..') {
      setError("Use letters, numbers, '_' or '-'.")
      return
    }
    if (cacheKeys.includes(draft)) {
      setError('A cache with this name already exists.')
      return
    }
    setError('')
    onRename(draft)
  }

  return (
    <div className="relative min-w-0">
      <input
        aria-label={`Cache name for ${cacheKey}`}
        aria-invalid={error !== ''}
        aria-describedby={error ? `cache-key-error-${cacheKey}` : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError('')
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(cacheKey)
            setError('')
          }
        }}
        placeholder="cache_key"
        spellCheck={false}
        className={`${LIST_ROW_TEXT} ${LIST_ROW_CHROME} ${LIST_ROW_PLACEHOLDER} w-full min-w-0 pr-9 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 aria-invalid:border-red-400 dark:aria-invalid:border-red-600`}
      />
      {error && (
        <Tooltip content={error} className="absolute right-2 top-1/2 -translate-y-1/2 text-red-500 dark:text-red-400">
          <span
            id={`cache-key-error-${cacheKey}`}
            role="alert"
            tabIndex={0}
            aria-label={`Cache name error: ${error}`}
            className="inline-flex outline-none"
          >
            <TriangleAlert className="w-4 h-4" />
          </span>
        </Tooltip>
      )}
    </div>
  )
}

// PortListEditor edits a list of TCP ports (network.allowed_loopback_ports).
// Kept as numbers on the wire; number inputs so a partial edit can't corrupt the
// list. A row being typed (empty/0) is held as 0 and dropped by the backend's
// out-of-range filter.
export function PortListEditor({
  ports,
  onChange,
  placeholder,
  addLabel,
}: {
  ports: number[]
  onChange: (ports: number[] | null) => void
  placeholder?: string
  addLabel?: string
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const addAfter = (index: number) => {
    const next = [...ports]
    next.splice(index + 1, 0, 0)
    onChange(next)
    requestAnimationFrame(() => inputRefs.current[index + 1]?.focus())
  }
  return (
    <div className="space-y-2 pt-0.5">
      {ports.map((p, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            ref={(el) => { inputRefs.current[index] = el }}
            type="number"
            min={1}
            max={65535}
            value={p || ''}
            onChange={(e) => {
              const next = [...ports]
              next[index] = e.target.valueAsNumber || 0
              onChange(next)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addAfter(index)
            }}
            placeholder={placeholder}
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <button
            onClick={() => {
              const next = ports.filter((_, i) => i !== index)
              onChange(next.length > 0 ? next : null)
            }}
            className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...ports, 0])}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
        {addLabel ?? 'Add Port'}
      </button>
    </div>
  )
}

// SandboxPathSection renders a labelled path-list editor with an icon + tooltip.
function SandboxPathSection({
  icon,
  label,
  tooltipTitle,
  tooltip,
  paths,
  inheritedPaths,
  onChange,
  placeholder,
  addLabel,
}: {
  icon: ReactNode
  label: string
  tooltipTitle: string
  tooltip: ReactNode
  paths: string[]
  inheritedPaths?: string[]
  onChange: (paths: string[] | null) => void
  placeholder?: string
  addLabel?: string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
          {label}
        </label>
        <InfoTooltip title={tooltipTitle}>{tooltip}</InfoTooltip>
      </div>
      {inheritedPaths && inheritedPaths.length > 0 && (
        <p className="text-2xs text-gray-400 dark:text-gray-500 italic ml-0.5">
          Inherited: <span className="font-mono">{inheritedPaths.join(', ')}</span>
        </p>
      )}
      <PathListEditor paths={paths} onChange={onChange} placeholder={placeholder} addLabel={addLabel} />
    </div>
  )
}

// ── ConfigForm ──────────────────────────────────────────────────────────────────
export function ConfigForm({
  value,
  onChange,
  inherited,
  agentType,
  defaultPrePrompt,
  allAgentsPrePrompt,
  mcpServers,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType?: string
  selectedProject?: ProjectInfo
  defaultPrePrompt?: string
  allAgentsPrePrompt?: string | null
  mcpServers?: McpServer[]
}) {
  const prePromptBoxRef = useRef<HTMLDivElement>(null)
  const [mcpInput, setMcpInput] = useState('')
  const sandbox: SandboxConfig = value.sandbox ?? {}
  const network: NetworkConfig = sandbox.network ?? {}
  // Effective egress mode for display. Explicit `mode` wins; otherwise derive it
  // from the legacy enabled/filter_enabled booleans, defaulting to "hard" (the
  // backend default). Selecting a mode writes it explicitly and clears the legacy
  // booleans so the emitted config is unambiguous.
  const mode: NetworkMode =
    (network.mode as NetworkMode | null | undefined) ??
    (network.enabled === false ? 'off' : network.filter_enabled === false ? 'unrestricted' : 'hard')
  const showHosts = mode === 'advisory' || mode === 'hard'

  function updateSandbox(patch: Partial<SandboxConfig>) {
    const next: SandboxConfig = { ...sandbox, ...patch }
    const empty =
      !next.writable_paths?.length &&
      !next.readable_paths?.length &&
      !next.masked_paths?.length &&
      !next.cow_paths?.length &&
      !Object.keys(next.cache ?? {}).length &&
      !next.inherit_env?.length &&
      !next.pre_spawn_script &&
      !next.pre_exit_script &&
      !next.network
    onChange({ ...value, sandbox: empty ? null : next })
  }

  function updateNetwork(patch: Partial<NetworkConfig>) {
    updateSandbox({ network: { ...network, ...patch } })
  }

  // Set the egress mode explicitly and clear the legacy booleans so `mode` is the
  // single source of truth in the emitted config.
  function setMode(next: NetworkMode) {
    updateNetwork({ mode: next as NetworkConfig['mode'], enabled: null, filter_enabled: null })
  }

  // ── MCP server allow-list (policy.mcp_allowed) ──
  const policy: PolicyConfig = value.policy ?? {}
  const mcpAllowed = policy.mcp_allowed ?? []
  // The picker's rows: every discovered server, plus any allow-listed name that
  // is no longer discovered (so it can be un-checked rather than silently kept).
  const discovered = mcpServers ?? []
  const extraAllowed = mcpAllowed.filter((n) => !discovered.some((s) => s.name === n))

  function updatePolicy(patch: Partial<PolicyConfig>) {
    const next: PolicyConfig = { ...policy, ...patch }
    const empty =
      next.gate_enabled == null &&
      next.git_isolation == null &&
      next.mcp_auto_allow_read == null &&
      next.strict_mcp == null &&
      next.agent_messaging == null &&
      !next.mcp_allowed?.length &&
      !next.mcp_tools_allowed?.length &&
      !next.mcp_blocked?.length &&
      !next.mcp_tools_blocked?.length &&
      !next.known_tools?.length
    onChange({ ...value, policy: empty ? null : next })
  }

  // Git-isolation default. nil = readonly (the backend default), so selecting
  // Read-only writes null to keep the emitted config minimal; Off - the opt-out
  // from the protective default - is written explicitly.
  const gitIsolation: GitIsolation = (policy.git_isolation as GitIsolation | null | undefined) ?? 'readonly'
  function setGitIsolation(next: GitIsolation) {
    updatePolicy({ git_isolation: next === 'readonly' ? null : next })
  }

  function toggleMcp(name: string, on: boolean) {
    const set = new Set(mcpAllowed)
    if (on) set.add(name)
    else set.delete(name)
    updatePolicy({ mcp_allowed: [...set] })
  }

  const inheritedSandbox = inherited?.sandbox ?? null

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
          System Pre-Prompt
        </label>
        {defaultPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-2xs text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;default pre-prompt&gt;</span>
            <InfoTooltip title="Default Pre-Prompt">
              <p className="mb-1.5">This built-in pre-prompt is always prepended before any configured pre-prompts:</p>
              <Markdown text={defaultPrePrompt} className="text-3xs leading-relaxed text-gray-200 bg-gray-800 rounded p-1.5 max-h-48 overflow-y-auto" />
              <p className="mt-1.5 text-gray-400 italic">{'<branch>'} and {'<base-branch>'} are substituted at spawn time.</p>
            </InfoTooltip>
          </div>
        )}
        {allAgentsPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-2xs text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;all agents pre-prompt&gt;</span>
            <InfoTooltip title="All Agents Pre-Prompt">
              {allAgentsPrePrompt ? (
                <>
                  <p className="mb-1.5">The "All Agents" pre-prompt is prepended before this agent's pre-prompt:</p>
                  <Markdown text={allAgentsPrePrompt} className="text-3xs leading-relaxed text-gray-200 bg-gray-800 rounded p-1.5 max-h-32 overflow-y-auto" />
                </>
              ) : (
                <p>No "All Agents" pre-prompt is configured. Set one in the <strong>All Agents</strong> tab to have it prepended here.</p>
              )}
              <p className="mt-1.5 text-gray-400 italic">Pre-prompts are merged in order: default → all agents → agent-specific. User-config and project-config values combine too (project appended after user), so setting one here does not replace the other scope's.</p>
            </InfoTooltip>
          </div>
        )}
        <div>
          {/* The box carries the border/background/focus ring; the inner
              HighlightedTextarea is transparent and live-highlights markdown.
              The box height is what the grip drags (the textarea fills it), so
              the transition must name only the focus-ring properties - a blanket
              `transition-all` also animates `height` and makes the drag lag
              behind the pointer and then jump. */}
          <div
            ref={prePromptBoxRef}
            className="relative h-28 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-inner overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-[border-color,box-shadow]"
          >
            <HighlightedTextarea
              value={value.pre_prompt || ''}
              onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
              placeholder={inherited?.pre_prompt || 'You are a helpful assistant...'}
              wrapperClassName="w-full h-full"
              textClassName="px-3 py-2 text-sm leading-relaxed placeholder-gray-300 dark:placeholder-gray-600"
            />
          </div>
          <ResizeHandle targetRef={prePromptBoxRef} minHeight={80} />
        </div>
      </div>

      {/* Fullscreen rendering - Claude only. Off by default so the web terminal keeps
          its native scrollbar + select-to-copy and Claude skips the alt-screen opt-in. */}
      {agentType === 'claude' && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Maximize2 className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Fullscreen Rendering
            </label>
            <InfoTooltip title="Fullscreen Rendering">
              <p>Claude Code's fullscreen renderer is flicker-free with flat memory in long conversations, but it draws on the terminal's <strong>alternate screen buffer</strong> and captures the mouse.</p>
              <p className="mt-1.5">Off (the default), Hydra forces the classic renderer so this web terminal keeps its <strong>native scrollbar and select-to-copy</strong>, and Claude won't show the one-time opt-in prompt that can collide with the resume nudge.</p>
              <p className="mt-1.5">On, Hydra enables fullscreen explicitly (it overrides any saved <code className="text-blue-300">tui</code> setting). Mouse/scroll/copy then run inside Claude.</p>
              <p className="mt-1.5 text-gray-400 italic">Only applies to Claude.</p>
            </InfoTooltip>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={value.fullscreen === true}
              onChange={(e) => onChange({ ...value, fullscreen: e.target.checked ? true : null })}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20 p-4 space-y-5">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Sandbox Policy</h3>
          <InfoTooltip title="OS Sandbox">
            <p>Agents run on the host inside an OS sandbox (bubblewrap on Linux, sandbox-exec on macOS). These settings are <strong>added on top of</strong> the baked-in defaults.</p>
            <p className="mt-1.5 text-gray-400 italic">Paths support <code className="text-blue-300">~</code> (home) and <code className="text-blue-300">$VARS</code>.</p>
          </InfoTooltip>
        </div>

        {/* Network */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Network Egress
            </label>
            <InfoTooltip title="Network Egress">
              <p><strong>Hard</strong> (default): outbound access limited to the allow-list, enforced by an <strong>inescapable</strong> network-namespace boundary (pasta + nft). When the host can't build the boundary, the head <strong>fails closed</strong> (no network) - hard never degrades to a weaker posture.</p>
              <p className="mt-1.5"><strong>Advisory</strong>: the same allow-list, but enforced only via the per-head egress proxy - every honest client is filtered, though a determined process can bypass it.</p>
              <p className="mt-1.5"><strong>Unrestricted</strong>: network on, every host reachable. <strong>Off</strong>: no network at all.</p>
              <p className="mt-1.5 text-gray-400 italic">Filtered modes start from a built-in default allow-list (AI-provider APIs, package registries, git hosts). Your allowed hosts are added on top; blocked hosts override both.</p>
            </InfoTooltip>
          </div>
          <SegmentedControl options={NETWORK_MODES} labels={NETWORK_MODE_LABELS} value={mode} onChange={setMode} />
          {NETWORK_MODE_WARNINGS[mode] && (
            <div className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5 motion-safe:animate-egress-warn-in">
              <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>{NETWORK_MODE_WARNINGS[mode]}</span>
            </div>
          )}
          {showHosts && (
            <div className="space-y-3 ml-0.5">
              <div className="space-y-1">
                <p className="text-2xs text-gray-400 dark:text-gray-500">Allowed hosts <span className="text-gray-400 dark:text-gray-600">(added to the built-in defaults)</span></p>
                <PathListEditor
                  paths={network.allowed_hosts ?? []}
                  onChange={(allowed_hosts) => updateNetwork({ allowed_hosts })}
                  placeholder="e.g. api.internal.example.com"
                  addLabel="Add Host"
                  renderValue={renderHostEntry}
                />
              </div>
              <div className="space-y-1">
                <p className="text-2xs text-gray-400 dark:text-gray-500">Blocked hosts <span className="text-gray-400 dark:text-gray-600">(override allowed + defaults)</span></p>
                <PathListEditor
                  paths={network.blocked_hosts ?? []}
                  onChange={(blocked_hosts) => updateNetwork({ blocked_hosts })}
                  placeholder="e.g. *.tracker.io"
                  addLabel="Block Host"
                  renderValue={renderHostEntry}
                />
              </div>
              {mode === 'hard' && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-2xs text-gray-400 dark:text-gray-500">Allowed loopback ports</p>
                    <InfoTooltip title="Allowed loopback ports">
                      <p>Host-loopback TCP ports the sandbox may still reach at <code className="text-blue-300">127.0.0.1</code> under hard mode, whose network namespace otherwise cuts off every host-local daemon.</p>
                      <p className="mt-1.5">For tools that hardcode loopback - e.g. adb's server: <code className="text-blue-300">5037</code> lets a sandboxed <code className="text-blue-300">adb</code> see the host's emulators.</p>
                      <p className="mt-1.5 text-gray-400 italic">The other modes share the host loopback already, so this only applies to hard mode.</p>
                    </InfoTooltip>
                  </div>
                  <PortListEditor
                    ports={network.allowed_loopback_ports ?? []}
                    onChange={(allowed_loopback_ports) => updateNetwork({ allowed_loopback_ports })}
                    placeholder="e.g. 5037"
                    addLabel="Add Port"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Git isolation */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Git isolation
            </label>
            <InfoTooltip title="Git isolation">
              <p><strong>Read-only .git</strong> (default): the whole <code className="text-blue-300">.git</code> is bound read-only, so a rogue agent cannot write it at all - no wrong-branch commit, no destroying the shared object store. Commits are staged and made host-side via the <code className="text-blue-300">git_commit</code> tool onto the head's own branch.</p>
              <p className="mt-1.5"><strong>Off</strong>: the repo's shared <code className="text-blue-300">.git</code> is writable in the sandbox, guarded only by the decision gate. The agent commits in-sandbox onto its own branch.</p>
              <p className="mt-1.5 text-gray-400 italic">Read-only disables in-sandbox <code className="text-blue-300">git add -p</code> / <code className="text-blue-300">stash</code> / <code className="text-blue-300">rebase -i</code> and setup-time .git writers (husky / git-lfs / submodules); use host-run for those. See docs/git-isolation.md.</p>
            </InfoTooltip>
          </div>
          <SegmentedControl options={GIT_ISOLATION_MODES} labels={GIT_ISOLATION_LABELS} value={gitIsolation} onChange={setGitIsolation} />
          {gitIsolation === 'readonly' && (
            <div className="flex items-start gap-1.5 text-2xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 rounded-lg px-2.5 py-1.5">
              <Lock className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>Commits run host-side via the git_commit tool. In-sandbox <code className="text-3xs">git add -p</code> / <code className="text-3xs">rebase</code> and husky/LFS/submodule setup won't work - use host-run for those.</span>
            </div>
          )}
        </div>

        <SandboxPathSection
          icon={<Eye className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />}
          label="Writable Paths"
          tooltipTitle="Writable Paths"
          tooltip={<p>Paths the agent may write to (in addition to its worktree and the default developer caches).</p>}
          paths={sandbox.writable_paths ?? []}
          inheritedPaths={inheritedSandbox?.writable_paths ?? undefined}
          onChange={(writable_paths) => updateSandbox({ writable_paths })}
          placeholder="e.g. ~/.gradle"
        />

        <SandboxPathSection
          icon={<Eye className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />}
          label="Readable paths"
          tooltipTitle="Readable paths"
          tooltip={<p>Extra host paths the agent may read. The worktree, system runtimes, developer toolchains, and writable paths are already included. Credential masks always take precedence.</p>}
          paths={sandbox.readable_paths ?? []}
          inheritedPaths={inheritedSandbox?.readable_paths ?? undefined}
          onChange={(readable_paths) => updateSandbox({ readable_paths })}
          placeholder="e.g. ~/.config/go"
        />

        <SandboxPathSection
          icon={<EyeOff className="w-3.5 h-3.5 text-red-500 dark:text-red-400" />}
          label="Masked paths"
          tooltipTitle="Masked paths"
          tooltip={<p>Defense-in-depth denies for credential or secret paths. Masks are applied after every read and write allowance, so they always win.</p>}
          paths={sandbox.masked_paths ?? []}
          inheritedPaths={inheritedSandbox?.masked_paths ?? undefined}
          onChange={(masked_paths) => updateSandbox({ masked_paths })}
          placeholder="e.g. ~/.vault-token"
        />

        <SandboxPathSection
          icon={<Layers className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />}
          label="Copy-on-Write Paths"
          tooltipTitle="Copy-on-Write Paths"
          tooltip={
            <>
              <p>Paths mounted copy-on-write. The agent sees the real files and may <strong>overwrite</strong> them, but writes are kept in a per-head layer and <strong>never touch the source</strong>.</p>
              <p className="mt-1.5">Entries follow the same convention as the other path lists. A <strong>worktree-relative</strong> path (e.g. <code className="text-blue-300">pipeline/out</code>) is mirrored from the project root into the worktree - ideal for large gitignored build inputs/outputs too big to copy. A <strong>home or absolute</strong> path (e.g. <code className="text-blue-300">~/.gradle</code>, <code className="text-blue-300">/opt/cache</code>) is overlaid in place and supersedes any default writable bind on it, so per-head builds share the real cache read-only but keep their writes and lock files private (no cross-head lock contention).</p>
              <p className="mt-1.5">Nothing is copied up front - reads come straight from the source; only files the agent modifies cost space.</p>
              <p className="mt-1.5 text-gray-400 italic">Linux uses overlayfs, macOS an APFS clone (home/absolute overlays are a Linux feature; on macOS such paths keep their shared-writable behavior). Bash shells get read-only access to the same paths.</p>
              <p className="mt-1.5 text-gray-400 italic">Overlay needs an overlay-capable bwrap; some distros (e.g. Ubuntu) ship it without. Point the daemon at one with <code className="text-blue-300">HYDRA_BWRAP=/path/to/bwrap</code> - otherwise COW falls back to read-only.</p>
            </>
          }
          paths={sandbox.cow_paths ?? []}
          inheritedPaths={inheritedSandbox?.cow_paths ?? undefined}
          onChange={(cow_paths) => updateSandbox({ cow_paths })}
          placeholder="e.g. pipeline/out or ~/.gradle"
        />

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">Shared caches</label>
            <InfoTooltip title="Shared caches">
              <p>Project-scoped writable caches reused by all heads and sandboxed runners. Each key maps to a stable directory in Hydra's project state.</p>
              <p className="mt-1.5"><strong>Env</strong> redirects a cache environment variable such as <code className="text-blue-300">GOCACHE</code>. <strong>Path</strong> links a worktree-relative, gitignored path to the cache.</p>
              <p className="mt-1.5">A cache with the same name replaces the inherited definition at this layer. Removing that override reveals the inherited definition again.</p>
              <p className="mt-1.5 text-amber-300">Caches are mutable shared state. Use them only for disposable data, never credentials, source files, <code className="text-blue-300">GOBIN</code>, or <code className="text-blue-300">node_modules</code>.</p>
            </InfoTooltip>
          </div>
          <CacheListEditor
            caches={sandbox.cache ?? {}}
            inheritedCaches={inheritedSandbox?.cache ?? undefined}
            onChange={(cache) => updateSandbox({ cache })}
          />
        </div>

        <SandboxPathSection
          icon={<KeyRound className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />}
          label="Inherited environment"
          tooltipTitle="Inherited environment"
          tooltip={
            <>
              <p>Names of additional variables copied from the Hydra daemon into this agent. Values are resolved when the head launches and are never stored in config or logs.</p>
              <p className="mt-1.5">Heads otherwise receive only a fixed baseline and authentication variables for their selected provider. Use this for deliberate project requirements such as <code className="text-blue-300">ANDROID_HOME</code>, <code className="text-blue-300">SSH_AUTH_SOCK</code>, or a private registry credential.</p>
              <p className="mt-1.5 text-gray-400 italic">Hydra-owned names, including every <code className="text-blue-300">HYDRA_*</code> variable, cannot be inherited.</p>
            </>
          }
          paths={sandbox.inherit_env ?? []}
          inheritedPaths={inheritedSandbox?.inherit_env ?? undefined}
          onChange={(inherit_env) => updateSandbox({ inherit_env })}
          placeholder="e.g. ANDROID_HOME"
          addLabel="Add variable"
        />

        {/* Pre-spawn script */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Pre-Spawn Script
            </label>
            <InfoTooltip title="Pre-Spawn Script">
              <p>A shell script run <strong>inside the sandbox</strong> before <strong>every agent launch</strong> - both spawn and resume - in its worktree with the same environment and confinement. Because it runs on every launch it must be <strong>idempotent</strong>. It does <strong>not</strong> run for the web bash shells.</p>
              <p className="mt-1.5">Runs under the script's <code className="text-blue-300">#!</code> shebang if present (e.g. <code className="text-blue-300">#!/bin/zsh</code>), otherwise <code className="text-blue-300">/bin/bash</code> - so <code className="text-blue-300">set -o pipefail</code> and other bashisms work.</p>
              <p className="mt-1.5">Useful for one-off setup such as <code className="text-blue-300">mise trust</code>. The agent launches after the script falls through; an explicit <code className="text-blue-300">exit 1</code> aborts the launch.</p>
              <p className="mt-1.5">These environment variables describe the head and are available to the script:</p>
              <ul className="mt-1 space-y-0.5 list-none">
                <li><code className="text-blue-300">HYDRA_HEAD_ID</code> - the head's ID</li>
                <li><code className="text-blue-300">HYDRA_AGENT_TYPE</code> - <code className="text-blue-300">claude</code>, <code className="text-blue-300">gemini</code>, <code className="text-blue-300">copilot</code>, <code className="text-blue-300">codex</code> or <code className="text-blue-300">bash</code></li>
                <li><code className="text-blue-300">HYDRA_WORKTREE</code> - worktree path (the working directory)</li>
                <li><code className="text-blue-300">HYDRA_PROJECT_ROOT</code> - the main repository root</li>
                <li><code className="text-blue-300">HYDRA_BRANCH</code> - the head's git branch</li>
                <li><code className="text-blue-300">HYDRA_BASE_BRANCH</code> - the branch it targets</li>
              </ul>
              <p className="mt-1.5">To set <strong>environment variables for the agent</strong>, append <code className="text-blue-300">KEY=value</code> lines to the file at <code className="text-blue-300">$HYDRA_ENV</code> (the GitHub Actions <code className="text-blue-300">$GITHUB_ENV</code> model):</p>
              <pre className="mt-1 text-2xs whitespace-pre-wrap"><code className="text-blue-300">{'echo "GRADLE_USER_HOME=/tmp/gradle-iso" >> "$HYDRA_ENV"'}</code></pre>
              <p className="mt-1.5">Each line is exported into the agent and every command it runs, overriding any inherited value. It re-applies on resume (the script re-runs). Values are taken literally - no shell evaluation - and one <code className="text-blue-300">KEY=value</code> per line.</p>
              <p className="mt-1.5">These vars are also injected into the head's <strong>sandboxed</strong> bash shells (the terminal <code className="text-blue-300">+</code> tabs), so a shell shares the agent's environment - the script itself is not re-run there. The non-sandboxed "Regular shell" is left out (its paths differ from the sandbox's).</p>
            </InfoTooltip>
          </div>
          {inheritedSandbox?.pre_spawn_script && (
            <p className="text-2xs text-gray-400 dark:text-gray-500 italic ml-0.5">
              Inherited: <span className="font-mono">{inheritedSandbox.pre_spawn_script}</span>
            </p>
          )}
          <ShellEditor
            value={sandbox.pre_spawn_script ?? ''}
            onChange={(val) => updateSandbox({ pre_spawn_script: val || null })}
            placeholder={'# e.g. mise trust'}
            rows={8}
          />
        </div>

        {/* Pre-exit script */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
            <label className="text-xs font-semibold text-gray-400 dark:text-gray-500">
              Pre-Exit Script
            </label>
            <InfoTooltip title="Pre-Exit Script">
              <p>A shell script run <strong>inside a sandbox</strong> when a head <strong>ends</strong> (kill, merge, or restart) - after its agent session is killed but <strong>before</strong> the worktree is removed.</p>
              <p className="mt-1.5">It runs in a fresh sandbox with this agent's policy, with the <strong>worktree as the working directory</strong> (still present), so it can read e.g. <code className="text-blue-300">.hydra/emu.env</code>. Use it for per-head teardown the agent didn't do itself - e.g. releasing a claimed emulator slot. Best-effort (failures are logged, never block the kill) and bounded by a 30s timeout.</p>
              <p className="mt-1.5">Being sandboxed it <strong>cannot</strong> reach host-only resources (the host adb server, <code className="text-blue-300">/dev/kvm</code>); those belong to a host-side service pool.</p>
              <p className="mt-1.5">It receives the same <code className="text-blue-300">HYDRA_*</code> head-context variables as the agent, plus:</p>
              <ul className="mt-1 space-y-0.5 list-none">
                <li><code className="text-blue-300">HYDRA_END_STATE</code> - <code className="text-blue-300">killed</code>, <code className="text-blue-300">merged</code>, or empty</li>
              </ul>
            </InfoTooltip>
          </div>
          {inheritedSandbox?.pre_exit_script && (
            <p className="text-2xs text-gray-400 dark:text-gray-500 italic ml-0.5">
              Inherited: <span className="font-mono">{inheritedSandbox.pre_exit_script}</span>
            </p>
          )}
          <ShellEditor
            value={sandbox.pre_exit_script ?? ''}
            onChange={(val) => updateSandbox({ pre_exit_script: val || null })}
            placeholder={'# e.g. source "$HYDRA_WORKTREE/.hydra/emu.env" && release-slot'}
            rows={6}
          />
        </div>
      </div>

      {/* MCP servers allow-list (policy.mcp_allowed) */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">MCP Servers</h3>
          <InfoTooltip title="MCP Servers">
            <p>Model Context Protocol servers give the agent extra tools. Only the servers you allow here can be used - <strong>deny-by-default</strong>: any others are stripped from the config before the agent launches, so they never even run.</p>
            <p className="mt-1.5">The list is discovered from your <code className="text-blue-300">~/.claude.json</code> and this project's <code className="text-blue-300">.mcp.json</code>.</p>
            <p className="mt-1.5 text-gray-400 italic">MCP servers are loaded at launch, so a change applies on the agent's <strong>next launch or resume</strong>, not to a running session.</p>
          </InfoTooltip>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Strict config</label>
            <InfoTooltip title="Strict config">
              <p>Launch the agent with <strong>only</strong> the servers allowed here: Hydra writes them to its own config file and starts Claude with <code className="text-blue-300">--strict-mcp-config</code>, so your <code className="text-blue-300">~/.claude.json</code> and the branch's <code className="text-blue-300">.mcp.json</code> are ignored outright.</p>
              <p className="mt-1.5">Turning this off falls back to filtering a seeded copy of your config instead. That copy is a bind mount over the real file, and anything on the host that rewrites <code className="text-blue-300">~/.claude.json</code> silently detaches it - after which the agent sees your unfiltered config. Only strict actually holds.</p>
              <p className="mt-1.5 text-amber-300">Cost: your <strong>claude.ai connectors</strong> (Gmail, Calendar, Drive) also go away, in every head using this agent. They can't be re-declared here - they authenticate through your account, not a config entry. Turn this off for an agent that needs them.</p>
            </InfoTooltip>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={policy.strict_mcp !== false}
              onChange={(e) => updatePolicy({ strict_mcp: e.target.checked ? null : false })}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>
        {policy.strict_mcp === false && (
          <p className="text-2xs text-amber-600 dark:text-amber-400 italic">
            Not strict: allow-listed servers are filtered out of a seeded copy of your config, which the host can silently detach. The runtime gate still denies non-allow-listed tool calls.
          </p>
        )}
        {discovered.length === 0 && extraAllowed.length === 0 ? (
          <p className="text-2xs text-gray-400 dark:text-gray-500 italic">No MCP servers found in <span className="font-mono">~/.claude.json</span> or <span className="font-mono">.mcp.json</span>. Add one by name below to pre-authorise it.</p>
        ) : (
          <div className="space-y-1">
            {discovered.map((s) => (
              <label key={s.name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500/30"
                  checked={mcpAllowed.includes(s.name)}
                  onChange={(e) => toggleMcp(s.name, e.target.checked)}
                />
                <span className="text-sm font-mono text-gray-700 dark:text-gray-200">{s.name}</span>
                <span className="text-3xs tracking-wide text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded px-1 py-px">{s.source}</span>
              </label>
            ))}
            {extraAllowed.map((name) => (
              <label key={name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500/30"
                  checked
                  onChange={() => toggleMcp(name, false)}
                />
                <span className="text-sm font-mono text-gray-700 dark:text-gray-200">{name}</span>
                <span className="text-3xs tracking-wide text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900 rounded px-1 py-px">not found</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={mcpInput}
            onChange={(e) => setMcpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mcpInput.trim()) {
                e.preventDefault()
                toggleMcp(mcpInput.trim(), true)
                setMcpInput('')
              }
            }}
            placeholder="Allow a server by name..."
            className="flex-1 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => {
              if (mcpInput.trim()) {
                toggleMcp(mcpInput.trim(), true)
                setMcpInput('')
              }
            }}
            className="inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Plus className="w-3.5 h-3.5" /> Allow
          </button>
        </div>

        {/* Per-tool grants + read/write auto-allow */}
        <div className="pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-1.5 pt-1">
            <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Allowed individual tools</label>
            <InfoTooltip title="Per-tool grants">
              <p>Allow specific tools of a server that is <em>not</em> fully allow-listed, as <code className="text-blue-300">server__tool</code> (e.g. <code className="text-blue-300">linear__create_issue</code>). The server is kept so those tools work; its other tools are parked for your approval when first used.</p>
            </InfoTooltip>
          </div>
          <PathListEditor
            paths={policy.mcp_tools_allowed ?? []}
            onChange={(mcp_tools_allowed) => updatePolicy({ mcp_tools_allowed })}
            placeholder="e.g. linear__create_issue"
            addLabel="Add Tool"
          />
          <div className="flex items-center gap-1.5 pt-1">
            <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Blocked servers</label>
            <InfoTooltip title="Blocked servers">
              <p>Servers refused outright: stripped before launch and <strong>denied</strong> at runtime - never parked for approval. Block overrides allow.</p>
              <p className="mt-1.5">The allow-lists combine across the user, project and local config layers, so blocking here is how this layer removes a server a broader layer granted.</p>
            </InfoTooltip>
          </div>
          <PathListEditor
            paths={policy.mcp_blocked ?? []}
            onChange={(mcp_blocked) => updatePolicy({ mcp_blocked })}
            placeholder="e.g. playwright"
            addLabel="Block Server"
          />
          <div className="flex items-center gap-1.5 pt-1">
            <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Blocked individual tools</label>
            <InfoTooltip title="Blocked individual tools">
              <p>Deny specific tools as <code className="text-blue-300">server__tool</code> (e.g. <code className="text-blue-300">github__delete_repo</code>), even when their server is allowed. Block overrides allow.</p>
            </InfoTooltip>
          </div>
          <PathListEditor
            paths={policy.mcp_tools_blocked ?? []}
            onChange={(mcp_tools_blocked) => updatePolicy({ mcp_tools_blocked })}
            placeholder="e.g. github__delete_repo"
            addLabel="Block Tool"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Auto-allow read-only tools</label>
              <InfoTooltip title="Auto-allow read-only tools">
                <p>Automatically allow MCP tools that look read-only (by name - <code className="text-blue-300">get_*</code>, <code className="text-blue-300">list_*</code>, <code className="text-blue-300">search_*</code>...), parking only writes and unrecognised tools for approval.</p>
                <p className="mt-1.5 text-gray-400 italic">This is a best-effort heuristic, not a guarantee - a server can mislabel a destructive tool. Off by default.</p>
              </InfoTooltip>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={policy.mcp_auto_allow_read === true}
                onChange={(e) => updatePolicy({ mcp_auto_allow_read: e.target.checked ? true : null })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <label className="text-2xs font-semibold text-gray-400 dark:text-gray-500">Agent messaging</label>
              <InfoTooltip title="Agent messaging">
                <p>Allow this agent to send attributed messages to other live agents in the same project. Hydra rate-limits conversations and prevents unbounded reply loops.</p>
                <p className="mt-1.5 text-gray-400 italic">Off by default. Read-only agent discovery remains available.</p>
              </InfoTooltip>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={policy.agent_messaging === true}
                onChange={(e) => updatePolicy({ agent_messaging: e.target.checked ? true : null })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
