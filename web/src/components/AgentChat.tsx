import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FilePen,
  FileText,
  Globe,
  ListEnd,
  LoaderCircle,
  Plus,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import { AgentStatus } from '../api'
import { useAgentStore } from '../stores/agentStore'
import { renderMarkdown, renderMarkdownBlocks } from '../lib/markdown'
import hljs from '../lib/hljs'
import { closeWebSocket } from '../lib/ws'
import { getWsUrl } from '../lib/terminalWs'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { formatError } from '../api/format_error'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { Tooltip } from './Tooltip'
import { type Attachment, nextAttachmentId } from '../lib/spawnDrafts'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'

// ChatPane renders a chat-mode head (CHAT_MODE.md): it speaks the chat framing
// on the same terminal WebSocket - {"type":"claude_event"} frames carrying
// verbatim Claude stream-json events out, {"type":"user_message"|"interrupt"|
// "set_model"} frames in - and reduces the event stream into a message list.
// On (re)connect the backend replays the whole conversation from the session's
// scrollback ring (--replay-user-messages includes user turns), so the reducer
// always starts from scratch. Unlike the terminal panel it FOLLOWS the app
// theme, with Claude-app-inspired light (cream) and dark (warm gray) surfaces.

interface ChatProps {
  agentId: string
  projectId: string | null
  active: boolean
  reconnectAttempt: number
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: (headMoved: boolean) => void
}

// Omit that distributes over a union (plain Omit collapses ChatItem to its
// common properties, losing each variant's own fields).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

type ChatItem =
  | { kind: 'user'; id: number; text: string }
  // A slash command echoed back by the CLI (<command-name>/<command-args>).
  | { kind: 'command'; id: number; name: string; args: string }
  // A local command's output echoed back as <local-command-stdout>.
  | { kind: 'cmdout'; id: number; text: string }
  | { kind: 'interrupted'; id: number }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'thinking'; id: number; text: string }
  | { kind: 'tool'; id: number; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }
  // A native AskUserQuestion tool call. requestId arrives with the paired
  // can_use_tool control_request (the channel the answer goes back on);
  // result is the tool_result once answered.
  | { kind: 'question'; id: number; toolUseId: string; input: unknown; specs: QuestionSpec[]; requestId?: string; result?: string }
  | { kind: 'result'; id: number; isError: boolean; durationMs?: number; costUsd?: number; errorText?: string }

// A message handed to the socket but not yet echoed back by the CLI
// (--replay-user-messages echoes a user turn when it is *processed*, so a
// message sent mid-turn stays here - visibly queued - until the turn ends).
interface PendingSend {
  id: number
  text: string
  queued: boolean
}

// Minimal shapes of the stream-json events the reducer consumes. Everything
// else in the events is intentionally ignored (unknown types are skipped).
interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
interface ClaudeEvent {
  type: string
  subtype?: string
  message?: { id?: string; content?: ClaudeContentBlock[] | string }
  duration_ms?: number
  total_cost_usd?: number
  result?: string
  is_error?: boolean
  // system:init fields the pane cares about.
  model?: string
  slash_commands?: string[]
  // "none" when the CLI is authed with an OAuth subscription - then
  // total_cost_usd is a notional API-rate figure, not money actually billed,
  // and the per-turn footer hides it.
  apiKeySource?: string
  // Raw API event carried by stream_event lines (--include-partial-messages).
  event?: {
    type?: string
    content_block?: { type?: string }
    delta?: { type?: string; text?: string; thinking?: string }
  }
  // control_request fields (--permission-prompt-tool stdio): the CLI asks the
  // client to approve a tool call - in practice only AskUserQuestion, since
  // --dangerously-skip-permissions auto-allows everything that doesn't
  // require user interaction.
  request_id?: string
  request?: { subtype?: string; tool_name?: string; input?: unknown; tool_use_id?: string }
}

// closeOpenFence appends a virtual closing fence when a streaming text ends
// inside an open ``` block, so the partial code renders as a code block
// instead of raw backticks until the real fence arrives.
function closeOpenFence(text: string): string {
  const opens = (text.match(/^```/gm) ?? []).length
  return opens % 2 === 1 ? text + '\n```' : text
}

// stripToolUseError unwraps the <tool_use_error>...</tool_use_error> envelope
// the CLI puts around tool failures, leaving just the readable error - the
// card is already tinted as an error, the tag adds nothing.
function stripToolUseError(text: string): string {
  const m = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(text)
  return m ? m[1].trim() : text
}

// toolResultText flattens a tool_result block's content (string, or an array
// of text blocks) into displayable text.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return stripToolUseError(content)
  if (Array.isArray(content)) {
    return stripToolUseError(
      content
        .map((c) => (typeof c === 'string' ? c : typeof (c as ClaudeContentBlock).text === 'string' ? (c as ClaudeContentBlock).text : ''))
        .filter(Boolean)
        .join('\n'),
    )
  }
  return ''
}

// trimWorktreePaths rewrites absolute paths under the head's worktree to
// worktree-relative ones for display - tool summaries and expanded inputs are
// dominated by long /home/.../worktrees/<id>/ prefixes otherwise. The Raw
// view keeps the untouched JSON.
function trimWorktreePaths(text: string, worktree: string | null): string {
  if (!worktree) return text
  const prefix = worktree.endsWith('/') ? worktree : worktree + '/'
  return text.split(prefix).join('').split(worktree).join('.')
}

// summarizeToolInput produces the one-line preview shown on a collapsed tool
// card, favouring the fields agent tools actually carry.
function summarizeToolInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
  }
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

// --- Claude-app-ish shared styles -------------------------------------------

// The user's message bubble: borderless, a shade off the pane background.
const USER_BUBBLE_CLASS =
  'max-w-[85%] rounded-2xl rounded-br-md bg-[#f0eee6] dark:bg-[#31302c] px-3.5 py-2 whitespace-pre-wrap break-words'

// Quiet code/output panels inside tool cards.
const PANEL_CLASS =
  'rounded-md border border-stone-200 dark:border-white/[0.06] bg-[#fdfcf9] dark:bg-[#1d1c1a]'

// The send button's terracotta accent.
const ACCENT_BG = 'bg-[#c96442] hover:bg-[#b55535]'

// Claude model aliases offered by the in-chat model dropdown. Sent verbatim to
// the CLI's set_model control request, so these must be aliases it accepts.
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
]

// modelDisplayLabel shortens a full model id ("claude-fable-5") to its alias
// label ("Fable") for the dropdown trigger.
function modelDisplayLabel(model: string): string {
  if (!model) return 'Model'
  const lower = model.toLowerCase()
  for (const m of CLAUDE_MODELS) {
    if (lower.includes(m.id)) return m.label
  }
  return model.replace(/^claude-/, '')
}

// splitBashChains inserts a newline after each top-level `;`, `&&` and `||` so
// a chained one-liner reads as separate steps in the expanded Bash card. It is
// deliberately optimistic: it only tracks quotes and backslash escapes, not
// the full shell grammar, and a command that already contains newlines is left
// exactly as written.
function splitBashChains(cmd: string): string {
  if (cmd.includes('\n')) return cmd
  let out = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    out += ch
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    // `;` splits (but not `;;`, a case terminator); `&&`/`||` split after the
    // second character. A single `|` (pipe) or `&` (background/redirect) does
    // not.
    const isChain = (ch === ';' && cmd[i + 1] !== ';') || ((ch === '&' || ch === '|') && cmd[i + 1] === ch)
    if (!isChain) continue
    if (ch !== ';') out += cmd[++i]
    while (cmd[i + 1] === ' ') i++
    if (i + 1 < cmd.length) out += '\n'
  }
  return out
}

// highlightHtml returns highlight.js token HTML, or null for plain rendering.
function highlightHtml(code: string, lang: string): string | null {
  if (!code || !hljs.getLanguage(lang)) return null
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

// useDelayedUnmount keeps collapsed disclosure content mounted just long
// enough for the closing height animation to play, then drops it from the
// tree (so a long conversation isn't paying for every collapsed tool output).
function useDelayedUnmount(open: boolean, ms = 250): boolean {
  const [mounted, setMounted] = useState(open)
  // Render-phase adjustment (the React-endorsed alternative to a setState
  // effect): opening mounts the content in the same render.
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open) return
    const t = setTimeout(() => setMounted(false), ms)
    return () => clearTimeout(t)
  }, [open, ms])
  return open || mounted
}

// Expandable animates its child open/closed via the grid-rows 0fr/1fr trick
// (see .chat-expandable in index.css) - height animates to the content's
// intrinsic size without any JS measuring.
function Expandable({ open, children }: { open: boolean; children: ReactNode }) {
  const mounted = useDelayedUnmount(open)
  return (
    <div className={`chat-expandable ${open ? 'chat-expandable-open' : ''}`}>
      <div>{mounted ? children : null}</div>
    </div>
  )
}

// CodePanel renders a block of code (a Bash command, JSON input) syntax
// highlighted on the shared quiet panel.
function CodePanel({ code, lang }: { code: string; lang: string }) {
  const html = useMemo(() => highlightHtml(code, lang), [code, lang])
  const cls = `${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-y-auto px-2.5 py-1.5 text-stone-800 dark:text-stone-200`
  if (html != null) {
    return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre className={cls}>{code}</pre>
}

// Per-tool icons for the card header; anything unlisted gets the wrench.
const TOOL_ICONS: Record<string, typeof Wrench> = {
  Bash: SquareTerminal,
  Read: FileText,
  Edit: FilePen,
  Write: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
  Agent: Bot,
}

function ToolCard({ item, worktree }: { item: Extract<ChatItem, { kind: 'tool' }>; worktree: string | null }) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const pending = item.result === undefined
  const input = (typeof item.input === 'object' && item.input !== null ? item.input : null) as
    | Record<string, unknown>
    | null
  const command = typeof input?.command === 'string' ? (input.command as string) : ''
  const isBash = item.name === 'Bash' && command !== ''
  const description = isBash && typeof input?.description === 'string' ? (input.description as string) : ''
  // A Bash header shows the human description when the agent provided one (the
  // script itself lives in the expanded card); other tools show their primary
  // argument, worktree-relative.
  const summary = trimWorktreePaths(isBash ? description || command : summarizeToolInput(item.input), worktree)
  const summaryMono = !(isBash && description)
  const Icon = TOOL_ICONS[item.name] ?? Wrench

  const rawJson = useMemo(() => {
    if (!showRaw) return ''
    const raw: Record<string, unknown> = { input: item.input }
    if (item.result !== undefined) raw.result = item.result
    return JSON.stringify(raw, null, 2)
  }, [showRaw, item.input, item.result])

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        item.isError
          ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
          : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left cursor-pointer text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
        <Icon className={`w-3 h-3 shrink-0 ${item.isError ? 'text-red-500 dark:text-red-400' : 'text-stone-400 dark:text-stone-500'}`} />
        <span className="font-medium shrink-0">{item.name}</span>
        <span className={`truncate ${summaryMono ? 'font-mono' : ''} text-stone-400 dark:text-stone-500`}>{summary}</span>
        {pending && (
          <span className="ml-auto shrink-0 text-[10px] text-amber-600 dark:text-amber-400/90 animate-pulse">running</span>
        )}
      </button>
      <Expandable open={open}>
        <div className="px-2.5 pb-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 select-none">
              {showRaw ? 'Raw' : isBash ? 'Command' : 'Input'}
            </span>
            <button
              onClick={() => setShowRaw((r) => !r)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
                showRaw
                  ? 'bg-stone-200 text-stone-700 dark:bg-white/10 dark:text-stone-200'
                  : 'text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300'
              }`}
              title="Toggle the raw tool-call JSON"
            >
              Raw
            </button>
          </div>
          {showRaw ? (
            <CodePanel code={rawJson} lang="json" />
          ) : (
            <>
              {isBash ? (
                <CodePanel code={trimWorktreePaths(splitBashChains(command), worktree)} lang="bash" />
              ) : (
                <CodePanel code={trimWorktreePaths(JSON.stringify(item.input, null, 2) ?? '', worktree)} lang="json" />
              )}
              {item.result !== undefined && (
                <div>
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 select-none">
                    Output
                  </div>
                  <pre
                    className={`${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-y-auto px-2.5 py-1.5 ${
                      item.isError ? 'text-red-600 dark:text-red-300' : 'text-stone-600 dark:text-stone-300'
                    }`}
                  >
                    {item.result || '(no output)'}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </Expandable>
    </div>
  )
}

// ThinkingCard is the Claude-app-style thought disclosure: a shimmering
// "Thinking..." label with a live tail while tokens stream, a quiet one-line
// snippet once settled. Clicking expands inline on desktop (clamped, with a
// Show more escape hatch) and opens a bottom sheet on small screens.
function ThinkingCard({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [clipped, setClipped] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const trimmed = text.trim()
  const snippet = trimmed.split('\n')[0] ?? ''
  // The live tail shown under the shimmer label while collapsed: the last
  // couple of lines of the thought so far, auto-updating as tokens arrive.
  const tailLines = trimmed.split('\n').filter((l) => l.trim() !== '')
  const tail = tailLines.slice(-2).join('\n')

  // Only offer "Show more" when the clamped body actually overflows.
  useEffect(() => {
    if (!open || showAll) return
    const el = bodyRef.current
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [open, showAll, text])

  function toggle() {
    // On phones an inline expansion is cramped; pop the thought up from the
    // bottom instead.
    if (window.matchMedia('(max-width: 639px)').matches) {
      setSheet(true)
      return
    }
    setOpen((o) => !o)
  }

  return (
    <div className="text-xs">
      <button onClick={toggle} className="group flex w-full items-center gap-1.5 text-left cursor-pointer">
        {streaming ? (
          <span className="chat-text-shimmer font-medium shrink-0 text-stone-500">Thinking...</span>
        ) : (
          <span className="shrink-0 font-medium text-stone-400 dark:text-stone-500 group-hover:text-stone-600 dark:group-hover:text-stone-300 transition-colors">
            Thinking
          </span>
        )}
        {!streaming && !open && snippet && (
          <span className="truncate italic text-stone-400/80 dark:text-stone-500/80">{snippet}</span>
        )}
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-stone-400/70 dark:text-stone-500/70 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {streaming && !open && tail && (
        <div className="mt-1 italic text-stone-400 dark:text-stone-500 whitespace-pre-wrap break-words line-clamp-2">
          {tail}
        </div>
      )}
      <Expandable open={open}>
        <div className="pt-1.5">
          <div
            ref={bodyRef}
            className={`border-l-2 border-stone-200 dark:border-white/10 pl-2.5 italic text-stone-500 dark:text-stone-400 whitespace-pre-wrap break-words ${
              showAll ? '' : 'max-h-44 overflow-hidden'
            }`}
          >
            {text}
          </div>
          {clipped && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-1 text-[11px] font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 transition-colors cursor-pointer"
            >
              Show more
            </button>
          )}
          {showAll && (
            <button
              onClick={() => setShowAll(false)}
              className="mt-1 text-[11px] font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 transition-colors cursor-pointer"
            >
              Show less
            </button>
          )}
        </div>
      </Expandable>
      {sheet && (
        <div className="fixed inset-0 z-50" role="dialog" aria-label="Thinking">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSheet(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[75vh] flex flex-col rounded-t-2xl border-t border-stone-200 dark:border-white/10 bg-[#faf9f5] dark:bg-[#2b2b28] shadow-2xl animate-chat-sheet-up">
            <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
              <span className="text-xs font-semibold text-stone-500 dark:text-stone-400">
                {streaming ? 'Thinking...' : 'Thinking'}
              </span>
              <button
                onClick={() => setSheet(false)}
                className="p-1 rounded text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 pb-6 overflow-y-auto text-xs italic text-stone-500 dark:text-stone-400 whitespace-pre-wrap break-words">
              {text}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Question cards (AskUserQuestion) ----------------------------------------
//
// Chat-mode heads launch with --permission-prompt-tool stdio, which is what
// makes the CLI expose the AskUserQuestion tool headless: the tool call
// arrives as a normal tool_use block plus a paired can_use_tool
// control_request, and the answer goes back as a control_response whose
// updatedInput carries an answers map (question text -> chosen labels;
// spike-verified). The pane renders the call as an interactive card - radio /
// checkbox options with primary+secondary text, an "Other" free text, one
// submit for all questions.
//
// The same card also renders a fenced ```question JSON block emitted in
// assistant prose (a fallback shape that needs no protocol support); there the
// answers are sent as a plain user message. Anything that fails to parse
// falls back to a code block.

interface QuestionOption {
  label: string
  description?: string
}
interface QuestionSpec {
  question: string
  header?: string
  multiSelect: boolean
  options: QuestionOption[]
}

// parseQuestionSpecs validates a {questions: [...]} value (a native
// AskUserQuestion input, or a fenced block's parsed JSON), returning null for
// anything malformed.
function parseQuestionSpecs(value: unknown): QuestionSpec[] | null {
  if (typeof value !== 'object' || value === null) return null
  const questions = (value as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const specs: QuestionSpec[] = []
  for (const q of questions) {
    const obj = q as Record<string, unknown>
    if (typeof obj.question !== 'string' || !Array.isArray(obj.options) || obj.options.length === 0) return null
    const options: QuestionOption[] = []
    for (const o of obj.options) {
      const oo = o as Record<string, unknown>
      if (typeof oo.label !== 'string') return null
      options.push({ label: oo.label, description: typeof oo.description === 'string' ? oo.description : undefined })
    }
    specs.push({
      question: obj.question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    })
  }
  return specs
}

// parseQuestionBlock validates a ```question fence's JSON payload.
function parseQuestionBlock(src: string): QuestionSpec[] | null {
  try {
    return parseQuestionSpecs(JSON.parse(src))
  } catch {
    return null
  }
}

function QuestionCard({
  specs,
  disabled,
  answeredText,
  onSubmit,
}: {
  specs: QuestionSpec[]
  disabled: boolean
  // Set once the head has recorded an answer (the tool_result text) - renders
  // the card settled even across a reconnect, where local state is lost.
  answeredText?: string
  // Returns true when the answers were actually handed to the socket.
  onSubmit: (answers: Record<string, string>) => boolean
}) {
  const [selected, setSelected] = useState<Set<number>[]>(() => specs.map(() => new Set<number>()))
  const [other, setOther] = useState<string[]>(() => specs.map(() => ''))
  const [submitted, setSubmitted] = useState(false)
  const answered = submitted || answeredText != null

  function toggleOption(qi: number, oi: number) {
    if (answered) return
    setSelected((prev) =>
      prev.map((s, i) => {
        if (i !== qi) return s
        const next = new Set(s)
        if (specs[qi].multiSelect) {
          if (next.has(oi)) next.delete(oi)
          else next.add(oi)
        } else {
          next.clear()
          next.add(oi)
        }
        return next
      }),
    )
  }

  const complete = specs.every((_, i) => selected[i].size > 0 || other[i].trim() !== '')

  function submit() {
    if (!complete || answered || disabled) return
    const answers: Record<string, string> = {}
    for (const [i, q] of specs.entries()) {
      const labels = [...selected[i]].sort((a, b) => a - b).map((oi) => q.options[oi].label)
      if (other[i].trim()) labels.push(other[i].trim())
      answers[q.question] = labels.join(', ')
    }
    if (onSubmit(answers)) setSubmitted(true)
  }

  return (
    <div className="max-w-xl rounded-xl border border-stone-200 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] p-3 space-y-3">
      {specs.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <div className="flex items-baseline gap-1.5">
            {q.header && (
              <span className="shrink-0 rounded bg-[#c96442]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#a8522f] dark:text-[#e0a184]">
                {q.header}
              </span>
            )}
            <span className="font-medium">{q.question}</span>
          </div>
          <div className="space-y-1">
            {q.options.map((o, oi) => {
              const isSel = selected[qi].has(oi)
              return (
                <button
                  key={oi}
                  onClick={() => toggleOption(qi, oi)}
                  disabled={answered}
                  className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                    answered ? 'cursor-default' : 'cursor-pointer'
                  } ${
                    isSel
                      ? 'border-[#c96442]/60 bg-[#c96442]/[0.07]'
                      : 'border-stone-200 dark:border-white/[0.07] hover:border-stone-300 dark:hover:border-white/[0.15]'
                  } ${answered && !isSel ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                      q.multiSelect ? 'rounded' : 'rounded-full'
                    } ${isSel ? 'border-[#c96442] bg-[#c96442]' : 'border-stone-300 dark:border-stone-500'}`}
                  >
                    {isSel && <Check className="h-2.5 w-2.5 text-white" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{o.label}</span>
                    {o.description && (
                      <span className="block text-[11px] text-stone-500 dark:text-stone-400">{o.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
            <input
              type="text"
              value={other[qi]}
              onChange={(e) => setOther((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
              disabled={answered}
              placeholder="Other..."
              className="w-full rounded-lg border border-stone-200 dark:border-white/[0.07] bg-transparent px-2.5 py-1.5 text-xs placeholder-stone-400 dark:placeholder-stone-500 outline-none focus:border-[#c96442]/60 disabled:opacity-50"
            />
          </div>
        </div>
      ))}
      <div className="flex items-center justify-end gap-2">
        {answeredText != null && (
          <span className="min-w-0 truncate text-[11px] italic text-stone-400 dark:text-stone-500">{answeredText}</span>
        )}
        <button
          onClick={submit}
          disabled={!complete || answered || disabled}
          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            answered
              ? 'bg-stone-100 text-stone-400 dark:bg-white/[0.06] dark:text-stone-500 cursor-default'
              : complete && !disabled
                ? `${ACCENT_BG} text-white cursor-pointer`
                : 'bg-stone-200 text-stone-400 dark:bg-white/10 dark:text-stone-500 cursor-default'
          }`}
        >
          {answered ? 'Answered' : specs.length > 1 ? 'Submit all' : 'Submit'}
        </button>
      </div>
    </div>
  )
}

export function ChatPane({ agentId, projectId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh }: ChatProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  // The in-flight streamed content block (token streaming via stream_event
  // deltas), rendered live below the settled items and superseded by the
  // complete assistant event that follows it.
  const [stream, setStream] = useState<{ kind: 'assistant' | 'thinking'; text: string } | null>(null)
  const [replayDone, setReplayDone] = useState(false)
  // Item ids >= this animate in (they arrived live); replayed history commits
  // in one batch without the entrance animation. null while replaying.
  const [liveFromId, setLiveFromId] = useState<number | null>(null)
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  // Messages handed to the socket, awaiting their --replay-user-messages echo
  // (see PendingSend). Rendered pinned under the settled items.
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])
  const sendSeqRef = useRef(1)
  // Composer attachments (same upload flow as the spawn box).
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Current model (from system:init / set_model confirmations) and the slash
  // commands the CLI advertises, both fed by the event stream.
  const [model, setModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [slashCommands, setSlashCommands] = useState<string[]>([])
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // The user-dragged minimum composer height, in whole rows (item 9): content
  // grows the box line by line up to MAX_ROWS regardless. Persisted per agent
  // like the terminal height (item 23).
  const [minRows, setMinRows] = useState(() => {
    const saved = loadAgentViewPrefs(projectId, agentId).chatComposerRows
    return saved && saved >= 1 && saved <= 10 ? Math.round(saved) : 1
  })
  const composerDragRef = useRef<{ startY: number; startRows: number; lineHeight: number } | null>(null)
  // Whether this head's usage is actually billed in dollars (API-key auth).
  // Subscription heads (init apiKeySource == "none") draw from usage limits,
  // so showing the CLI's notional total_cost_usd as money would be wrong.
  const [costBilled, setCostBilled] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Pin-to-bottom: keep auto-scrolling while the user is at (or near) the
  // bottom; stop once they scroll up to read history. The ref is the live
  // value the socket/scroll handlers read; the state mirror drives the
  // jump-to-bottom button.
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)
  // Latest scroll offset + pin, mirrored on every scroll so deactivation (the
  // pane going display:none loses its scroll geometry) and unmount can persist
  // it (item 20).
  const lastScrollRef = useRef({ top: 0, pinned: true })

  const status = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.agent_status?.status)
  const isTurnRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  // The head's worktree, for trimming absolute paths in tool cards (item 19).
  // Falls back to the archived list for a finished head.
  const worktreePath = useAgentStore(
    (s) => (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.worktree_path ?? null,
  )

  const onStatusUpdateRef = useRef(onStatusUpdate)
  const onDiffRefreshRef = useRef(onDiffRefresh)
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate
    onDiffRefreshRef.current = onDiffRefresh
  })

  useEffect(() => {
    setItems([])
    setStream(null)
    setReplayDone(false)
    setLiveFromId(null)
    // Anything still pending was written to the CLI's stdin; its echo will be
    // part of the replay this new connection delivers, so keeping the pending
    // copy would double it.
    setPendingSends([])
    pinnedRef.current = true

    let nextId = 1
    // Until replay_done, everything arriving is history (transcript backfill +
    // ring replay, possibly thousands of events): buffer it all and commit ONE
    // state update, instead of a render per event. Live events after that
    // flush per microtask batch.
    let replaying = true
    // Assistant events arrive one content block per event but share the API
    // message id; if a CLI version ever re-emits blocks cumulatively, this
    // per-message seen-set keeps the reducer idempotent.
    const seenBlocks = new Map<string, Set<string>>()
    const pending: ChatItem[] = []
    let flushScheduled = false
    const flush = () => {
      flushScheduled = false
      if (pending.length === 0) return
      const batch = pending.splice(0, pending.length)
      setItems((prev) => [...prev, ...batch])
    }
    const push = (item: DistributiveOmit<ChatItem, 'id'>) => {
      pending.push({ ...item, id: nextId++ } as ChatItem)
      if (!replaying && !flushScheduled) {
        flushScheduled = true
        queueMicrotask(flush)
      }
    }

    // Token-streaming buffer. Deltas can arrive far faster than 60fps, so they
    // accumulate here and the visible state is refreshed on a short timer;
    // each refresh re-renders (and re-parses the markdown of) only the one
    // in-flight block, which stays small.
    let streamBuf: { kind: 'assistant' | 'thinking'; text: string } | null = null
    let streamTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleStreamFlush = () => {
      if (streamTimer != null) return
      streamTimer = setTimeout(() => {
        streamTimer = null
        setStream(streamBuf ? { ...streamBuf } : null)
      }, 40)
    }
    const clearStream = () => {
      streamBuf = null
      if (streamTimer != null) {
        clearTimeout(streamTimer)
        streamTimer = null
      }
      setStream(null)
    }
    const patchTool = (toolUseId: string, result: string, isError: boolean) => {
      // The tool/question card may still be in the un-flushed batch or already
      // rendered.
      const inPending = pending.find(
        (it) => (it.kind === 'tool' || it.kind === 'question') && it.toolUseId === toolUseId,
      )
      if (inPending && inPending.kind === 'tool') {
        inPending.result = result
        inPending.isError = isError
        return
      }
      if (inPending && inPending.kind === 'question') {
        inPending.result = result
        return
      }
      setItems((prev) =>
        prev.map((it) => {
          if (it.kind === 'tool' && it.toolUseId === toolUseId) return { ...it, result, isError }
          if (it.kind === 'question' && it.toolUseId === toolUseId) return { ...it, result }
          return it
        }),
      )
    }

    // The can_use_tool control_request paired with an AskUserQuestion tool_use
    // carries the request_id the answer must quote; attach it to the question
    // card (which normally arrived just before, via the assistant event).
    const patchQuestionRequest = (toolUseId: string, requestId: string, input: unknown) => {
      const inPending = pending.find((it) => it.kind === 'question' && it.toolUseId === toolUseId)
      if (inPending && inPending.kind === 'question') {
        inPending.requestId = requestId
        return
      }
      setItems((prev) => {
        if (prev.some((it) => it.kind === 'question' && it.toolUseId === toolUseId)) {
          return prev.map((it) =>
            it.kind === 'question' && it.toolUseId === toolUseId ? { ...it, requestId } : it,
          )
        }
        // A request whose tool_use we never saw (shouldn't happen, but the
        // protocol doesn't guarantee it) still gets a card.
        const specs = parseQuestionSpecs(input)
        if (!specs) return prev
        return [...prev, { kind: 'question', id: nextId++, toolUseId, input, specs, requestId }]
      })
    }

    // The CLI echoed a processed user turn back: the matching optimistic
    // pending bubble (if any) is superseded by the real item.
    const settlePendingSend = (text: string) => {
      setPendingSends((prev) => {
        const i = prev.findIndex((p) => p.text === text)
        return i < 0 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1)]
      })
    }

    // routeUserText classifies one user-turn text: slash-command echoes and
    // local command output arrive wrapped in pseudo-XML tags, interrupts as a
    // bracketed marker, everything else is a real user message.
    const routeUserText = (text: string) => {
      const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
      if (cmd) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
        push({ kind: 'command', name: cmd[1].trim(), args })
        return
      }
      const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
      if (stdout) {
        const body = stdout[1].trim()
        // "Set model to sonnet (claude-sonnet-5)" - the CLI's confirmation is
        // the source of truth for the dropdown.
        const m = /^Set model to\s+(\S+)/.exec(body)
        if (m) setModel(m[1])
        if (body) push({ kind: 'cmdout', text: body })
        return
      }
      if (text.startsWith('[Request interrupted by user')) {
        push({ kind: 'interrupted' })
        return
      }
      settlePendingSend(text)
      push({ kind: 'user', text })
    }

    const handleClaudeEvent = (ev: ClaudeEvent) => {
      switch (ev.type) {
        case 'system': {
          if (ev.subtype === 'init') {
            if (typeof ev.model === 'string' && ev.model) setModel(ev.model)
            if (Array.isArray(ev.slash_commands)) {
              setSlashCommands(ev.slash_commands.filter((c): c is string => typeof c === 'string'))
            }
            if (typeof ev.apiKeySource === 'string') setCostBilled(ev.apiKeySource !== 'none')
          }
          return
        }
        case 'control_request': {
          const req = ev.request
          if (
            req?.subtype === 'can_use_tool' &&
            req.tool_name === 'AskUserQuestion' &&
            typeof req.tool_use_id === 'string' &&
            typeof ev.request_id === 'string'
          ) {
            patchQuestionRequest(req.tool_use_id, ev.request_id, req.input)
          }
          // Other can_use_tool requests don't occur: --dangerously-skip-permissions
          // auto-allows everything that doesn't require user interaction.
          return
        }
        case 'user': {
          const content = ev.message?.content
          if (typeof content === 'string') {
            if (content.trim()) routeUserText(content)
            return
          }
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              routeUserText(block.text)
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              patchTool(block.tool_use_id, toolResultText(block.content), block.is_error === true)
            }
          }
          return
        }
        case 'assistant': {
          const content = ev.message?.content
          if (!Array.isArray(content)) return
          const msgId = ev.message?.id ?? ''
          let seen = seenBlocks.get(msgId)
          if (!seen) {
            seen = new Set()
            seenBlocks.set(msgId, seen)
          }
          for (const block of content) {
            const key = `${block.type}:${block.id ?? ''}:${block.text ?? block.thinking ?? ''}`
            if (msgId && seen.has(key)) continue
            if (msgId) seen.add(key)
            if (block.type === 'text' && block.text?.trim()) {
              push({ kind: 'assistant', text: block.text })
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              push({ kind: 'thinking', text: block.thinking })
            } else if (block.type === 'tool_use' && block.id) {
              // AskUserQuestion renders as an interactive question card, not a
              // tool card; its answer channel arrives with the paired
              // control_request (patchQuestionRequest).
              const specs = block.name === 'AskUserQuestion' ? parseQuestionSpecs(block.input) : null
              if (specs) {
                push({ kind: 'question', toolUseId: block.id, input: block.input, specs })
              } else {
                push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
              }
            }
          }
          // The complete event supersedes any in-flight streamed block (finals
          // always follow their own deltas). Cleared in the same batch as the
          // push above, so the text swaps without a flash.
          clearStream()
          return
        }
        case 'stream_event': {
          const e = ev.event
          if (!e) return
          if (e.type === 'content_block_start') {
            const bt = e.content_block?.type
            // tool_use input streaming (input_json_delta) is not rendered; the
            // tool card appears with the complete assistant event.
            streamBuf = bt === 'text' ? { kind: 'assistant', text: '' } : bt === 'thinking' ? { kind: 'thinking', text: '' } : null
            scheduleStreamFlush()
          } else if (e.type === 'content_block_delta' && streamBuf) {
            const d = e.delta
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              streamBuf.text += d.text
              scheduleStreamFlush()
            } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
              streamBuf.text += d.thinking
              scheduleStreamFlush()
            }
          } else if (e.type === 'message_stop') {
            clearStream()
          }
          return
        }
        case 'result': {
          push({
            kind: 'result',
            isError: ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success'),
            durationMs: ev.duration_ms,
            costUsd: ev.total_cost_usd,
            errorText: ev.is_error ? ev.result : undefined,
          })
          clearStream()
          return
        }
        default:
          // control_response, rate_limit_event, future kinds: not rendered
          // (yet), deliberately not an error.
          return
      }
    }

    const ws = new WebSocket(getWsUrl(agentId, projectId))
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      let msg: { type?: string; status?: string; head_moved?: boolean; event?: ClaudeEvent }
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'status':
          if (msg.status) onStatusUpdateRef.current?.(msg.status.toLowerCase())
          return
        case 'diff_refresh':
          onDiffRefreshRef.current?.(msg.head_moved ?? false)
          return
        case 'claude_event':
          if (msg.event) handleClaudeEvent(msg.event)
          return
        case 'replay_done':
          replaying = false
          flush()
          setLiveFromId(nextId)
          setReplayDone(true)
          return
      }
    }
    ws.onclose = () => {
      setConnected(false)
      onStatusUpdateRef.current?.('stopped')
    }

    return () => {
      if (streamTimer != null) clearTimeout(streamTimer)
      closeWebSocket(ws)
      wsRef.current = null
      setConnected(false)
    }
  }, [agentId, projectId, reconnectAttempt])

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  // Auto-scroll to the bottom on new content while pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items, stream, replayDone, pendingSends])

  // Restore the remembered per-agent scroll offset once the replayed history
  // has rendered (item 20). A saved offset only exists when the user had
  // scrolled away from the bottom, so un-pin and put them back there;
  // otherwise the auto-scroll effect has already pinned to the bottom.
  useEffect(() => {
    if (!replayDone) return
    const saved = loadAgentViewPrefs(projectId, agentId).chatScrollTop
    if (saved == null) return
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = false
    setPinned(false)
    // After paint, when the replayed items have laid out.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = saved
      lastScrollRef.current = { top: saved, pinned: false }
    })
    return () => cancelAnimationFrame(raf)
  }, [replayDone, projectId, agentId])

  // The pane going display:none loses its scroll geometry; on re-activation
  // re-apply the last known offset (or re-pin to the bottom).
  useEffect(() => {
    if (!active) return
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      if (lastScrollRef.current.pinned) el.scrollTop = el.scrollHeight
      else el.scrollTop = lastScrollRef.current.top
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  // Persist the offset (debounced) so it survives leaving the page entirely;
  // pinned-to-bottom clears it (the natural state needs no memory).
  const persistScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (persistScrollTimer.current) clearTimeout(persistScrollTimer.current)
      const last = lastScrollRef.current
      patchAgentViewPrefs(projectId, agentId, { chatScrollTop: last.pinned ? undefined : last.top })
    },
    [projectId, agentId],
  )

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    pinnedRef.current = nearBottom
    setPinned(nearBottom)
    // A hidden pane has no geometry; don't let a stray 0-measurement clobber
    // the remembered offset.
    if (!active || el.clientHeight === 0) return
    lastScrollRef.current = { top: el.scrollTop, pinned: nearBottom }
    if (persistScrollTimer.current) clearTimeout(persistScrollTimer.current)
    persistScrollTimer.current = setTimeout(() => {
      const last = lastScrollRef.current
      patchAgentViewPrefs(projectId, agentId, { chatScrollTop: last.pinned ? undefined : last.top })
    }, 250)
  }

  // --- Composer: attachments ------------------------------------------------

  const attachmentsRef = useRef<Attachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  // Free preview object URLs when the pane goes away.
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    },
    [],
  )

  function patchAttachment(id: number, patch: Partial<Attachment>) {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  function addFiles(files: File[]) {
    for (const file of files) {
      const id = nextAttachmentId()
      const previewUrl = isImageFile(file) ? URL.createObjectURL(file) : undefined
      setAttachments((prev) => [
        ...prev,
        { id, filename: file.name || 'pasted-image', path: null, previewUrl, size: file.size, uploading: true },
      ])
      uploadFile(projectId, file)
        .then((res) => patchAttachment(id, { path: res.path, uploading: false }))
        .catch((err) => patchAttachment(id, { uploading: false, error: formatError(err) }))
    }
  }

  function removeAttachment(id: number) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = extractFiles(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const isFileDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

  const uploading = attachments.some((a) => a.uploading)
  const readyAttachments = attachments.filter((a) => a.path && !a.error)
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  const canSend = connected && !uploading && (!!input.trim() || readyAttachments.length > 0)

  // --- Composer: slash commands ----------------------------------------------

  // The popup only engages while the input is a single beginning-of-message
  // "/token" (the moment a space is typed the command is committed).
  const slashQuery = useMemo(() => /^\/([\w:-]*)$/.exec(input)?.[1] ?? null, [input])
  const slashMatches = useMemo(() => {
    if (slashQuery == null || slashDismissed || slashCommands.length === 0) return []
    const q = slashQuery.toLowerCase()
    return slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8)
  }, [slashQuery, slashDismissed, slashCommands])
  useEffect(() => setSlashSel(0), [slashQuery])

  function acceptSlash(cmd: string) {
    setInput('/' + cmd + ' ')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // --- Composer: sizing (item 9) ---------------------------------------------

  const MAX_ROWS = 10

  // Grow/shrink the textarea one whole line at a time with its content,
  // respecting the user-dragged minimum.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const cs = getComputedStyle(ta)
    const lineHeight = parseFloat(cs.lineHeight) || 20
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    ta.style.height = 'auto'
    const contentRows = Math.max(1, Math.round((ta.scrollHeight - pad) / lineHeight))
    const rows = Math.min(MAX_ROWS, Math.max(minRows, contentRows))
    ta.style.height = `${rows * lineHeight + pad}px`
    ta.style.overflowY = contentRows > rows ? 'auto' : 'hidden'
  }, [input, minRows])

  function onComposerResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const ta = textareaRef.current
    if (!ta) return
    const cs = getComputedStyle(ta)
    const lineHeight = parseFloat(cs.lineHeight) || 20
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const displayedRows = Math.max(1, Math.round((ta.clientHeight - pad) / lineHeight))
    composerDragRef.current = { startY: e.clientY, startRows: displayedRows, lineHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onComposerResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = composerDragRef.current
    if (!d) return
    // Dragging up enlarges; snapped to whole rows.
    const rows = Math.min(MAX_ROWS, Math.max(1, d.startRows + Math.round((d.startY - e.clientY) / d.lineHeight)))
    setMinRows(rows)
  }

  function onComposerResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!composerDragRef.current) return
    composerDragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    patchAgentViewPrefs(projectId, agentId, { chatComposerRows: minRows })
  }

  // --- Sending ----------------------------------------------------------------

  // sendUserText hands one user turn to the socket and tracks it as an
  // optimistic pending bubble until the CLI's echo supersedes it. Returns
  // false when the socket isn't usable.
  function sendUserText(text: string): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'user_message', content: [{ type: 'text', text }] }))
    // Optimistic: the bubble appears immediately, marked queued when a turn is
    // in flight (the CLI holds it until the turn ends). The pending copy is
    // replaced by the CLI's echo of the processed turn (routeUserText).
    setPendingSends((prev) => [...prev, { id: sendSeqRef.current++, text, queued: isTurnRunning }])
    pinnedRef.current = true
    setPinned(true)
    // Status is nudged optimistically exactly like the terminal's Enter
    // handling - but not while the agent is asking a question (needs_input).
    if (status !== AgentStatus.NEEDS_INPUT) {
      useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
      onStatusUpdateRef.current?.(AgentStatus.RUNNING)
    }
    return true
  }

  function send() {
    if (uploading) return
    const text = input.trim()
    const paths = readyAttachments.map((a) => a.path as string)
    // Attachment paths ride below the typed text, same as the spawn box - the
    // agent reads the uploaded files from inside its sandbox.
    const finalText = paths.length > 0 ? (text ? `${text}\n\n${paths.join('\n')}` : paths.join('\n')) : text
    if (!finalText || !sendUserText(finalText)) return
    setInput('')
    setSlashDismissed(false)
    for (const a of attachments) if (a.previewUrl && !readyAttachments.includes(a)) URL.revokeObjectURL(a.previewUrl)
    setAttachments([])
    setLightboxIndex(null)
  }

  // answerQuestion replies to a native AskUserQuestion via the control channel
  // (control_response with the answers merged into updatedInput).
  function answerQuestion(item: Extract<ChatItem, { kind: 'question' }>, answers: Record<string, string>): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !item.requestId) return false
    const input = typeof item.input === 'object' && item.input !== null ? (item.input as Record<string, unknown>) : {}
    ws.send(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: item.requestId,
          response: { behavior: 'allow', updatedInput: { ...input, answers } },
        },
      }),
    )
    return true
  }

  // answersAsText renders an answers map as the plain-text reply used by the
  // fenced ```question fallback (one "<question>: <labels>" line each).
  function sendAnswersAsText(answers: Record<string, string>): boolean {
    const lines = Object.entries(answers).map(([q, a]) => `${q}: ${a}`)
    return sendUserText(lines.join('\n'))
  }

  function interrupt() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  function changeModel(id: string) {
    const ws = wsRef.current
    setModelMenuOpen(false)
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'set_model', model: id }))
    // Optimistic; the CLI's "Set model to ..." confirmation re-syncs it.
    setModel(id)
  }

  // --- Keyboard ----------------------------------------------------------------

  function insertNewline(ta: HTMLTextAreaElement) {
    const start = ta.selectionStart ?? input.length
    const end = ta.selectionEnd ?? input.length
    setInput(input.slice(0, start) + '\n' + input.slice(end))
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 1
    })
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSel((s) => (s + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSel((s) => (s - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      // Tab always completes; Enter completes too unless the command is
      // already fully typed (then it falls through and sends).
      const exact = slashMatches.length === 1 && slashQuery === slashMatches[0]
      if (e.key === 'Tab' || (e.key === 'Enter' && !exact && !e.shiftKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault()
        acceptSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)])
        return
      }
    }
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      // Shift+Enter is the browser's native newline; Ctrl+Enter and Alt+Enter
      // insert one too (item 7) - they'd otherwise do nothing.
      if (e.altKey || (e.ctrlKey && !e.metaKey)) {
        e.preventDefault()
        insertNewline(e.currentTarget)
        return
      }
      if (!e.shiftKey && !e.metaKey) {
        e.preventDefault()
        send()
      }
    }
  }

  // hasTextSelection reports whether any text is selected - in the focused
  // textarea (window.getSelection doesn't see textarea selections everywhere)
  // or in the transcript itself.
  function hasTextSelection(): boolean {
    const ae = document.activeElement
    if (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement) {
      if ((ae.selectionEnd ?? 0) > (ae.selectionStart ?? 0)) return true
    }
    return !!window.getSelection()?.toString()
  }

  // Ctrl+C with nothing selected interrupts the running turn (item 11); with a
  // selection it stays the copy shortcut. Ctrl+End jumps to the bottom (item
  // 14, Claude Code parity) - but only while scrolled up, so the caret's
  // native end-of-text shortcut still works in a pinned chat.
  function onPaneKeyDown(e: React.KeyboardEvent) {
    if (
      e.key.toLowerCase() === 'c' &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      isTurnRunning &&
      !hasTextSelection()
    ) {
      e.preventDefault()
      interrupt()
      return
    }
    if (e.key === 'End' && e.ctrlKey && !e.metaKey && !e.altKey && !pinnedRef.current) {
      e.preventDefault()
      scrollToBottom(true)
    }
  }

  // --- Rendering ----------------------------------------------------------------

  // renderAssistantText renders assistant prose, lifting any fenced
  // ```question blocks out as interactive question cards (the fallback shape;
  // native AskUserQuestion arrives as its own item). Malformed blocks fall
  // through to the normal code-block rendering.
  function renderAssistantText(text: string): ReactNode {
    const fence = /```question[ \t]*\n([\s\S]*?)\n```/
    const parts: ReactNode[] = []
    let rest = text
    let key = 0
    for (;;) {
      const m = fence.exec(rest)
      if (!m) break
      const before = rest.slice(0, m.index)
      if (before.trim()) parts.push(<div key={key++}>{renderMarkdownBlocks(before)}</div>)
      const specs = parseQuestionBlock(m[1])
      if (specs) {
        parts.push(
          <div key={key++} className="my-1.5">
            <QuestionCard specs={specs} disabled={!connected} onSubmit={sendAnswersAsText} />
          </div>,
        )
      } else {
        parts.push(<div key={key++}>{renderMarkdownBlocks(m[0])}</div>)
      }
      rest = rest.slice(m.index + m[0].length)
    }
    if (parts.length === 0) return renderMarkdownBlocks(text)
    if (rest.trim()) parts.push(<div key={key++}>{renderMarkdownBlocks(rest)}</div>)
    return parts
  }

  function renderChatItem(item: ChatItem): ReactNode {
    switch (item.kind) {
      case 'user':
        return (
          <div className="flex justify-end">
            <div className={USER_BUBBLE_CLASS}>{renderMarkdown(item.text)}</div>
          </div>
        )
      case 'command': {
        const name = item.name.startsWith('/') ? item.name : '/' + item.name
        return (
          <div className="flex justify-end">
            <div className={`${USER_BUBBLE_CLASS} font-mono text-xs text-stone-600 dark:text-stone-300`}>
              {name}
              {item.args ? ` ${item.args}` : ''}
            </div>
          </div>
        )
      }
      case 'cmdout':
        return (
          <pre
            className={`${PANEL_CLASS} max-w-[95%] whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[11px] leading-4 text-stone-500 dark:text-stone-400`}
          >
            {item.text}
          </pre>
        )
      case 'interrupted':
        return (
          <div className="flex justify-end">
            <div className="rounded-lg border border-red-300/60 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30 px-2.5 py-1 text-xs text-red-600 dark:text-red-300 select-none">
              Interrupted by user
            </div>
          </div>
        )
      case 'assistant':
        return <div className="max-w-[95%] leading-relaxed">{renderAssistantText(item.text)}</div>
      case 'thinking':
        return <ThinkingCard text={item.text} />
      case 'tool':
        return <ToolCard item={item} worktree={worktreePath} />
      case 'question':
        return (
          <QuestionCard
            specs={item.specs}
            // Interactive only while its control_request channel is live; a
            // question replayed from the transcript alone (the process has
            // since restarted, killing the pending turn) renders inert.
            disabled={!connected || item.requestId == null}
            answeredText={item.result}
            onSubmit={(answers) => answerQuestion(item, answers)}
          />
        )
      case 'result':
        if (item.isError) {
          return (
            <div className="rounded-lg border border-red-300/70 bg-red-50 dark:border-red-900/70 dark:bg-red-950/30 px-3 py-1.5 text-xs text-red-600 dark:text-red-300 whitespace-pre-wrap break-words">
              {item.errorText || 'The turn ended with an error.'}
            </div>
          )
        }
        return (
          <div className="text-center text-[10px] text-stone-400/80 dark:text-stone-500/80 select-none">
            {item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : ''}
            {/* total_cost_usd is a notional API-rate figure; only heads authed
                with a real API key are billed it, so only they show it
                (item 15 - subscription usage isn't money). */}
            {costBilled && item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
          </div>
        )
    }
  }

  const modelLabel = modelDisplayLabel(model)

  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col text-[13px] text-stone-800 dark:text-stone-100 bg-[#faf9f5] dark:bg-[#262624]"
      onKeyDown={onPaneKeyDown}
      onDragOver={(e) => {
        if (!isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragActive(true)
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
        setDragActive(false)
      }}
      onDrop={(e) => {
        setDragActive(false)
        if (!isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        addFiles(extractFiles(e.dataTransfer))
      }}
    >
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-3 flex flex-col gap-3">
          {!replayDone && items.length === 0 && (
            <div className="text-xs text-stone-400 dark:text-stone-500 italic py-2">
              {connected ? 'Loading conversation...' : 'Connecting...'}
            </div>
          )}
          {items.map((item) => (
            <div key={item.id} className={liveFromId != null && item.id >= liveFromId ? 'animate-chat-item-in' : undefined}>
              {renderChatItem(item)}
            </div>
          ))}
          {/* The in-flight streamed block: markdown-rendered live (with a
              virtual closing fence while inside a code block) plus a pulsing
              caret; streamed thinking uses the same collapsed card as settled
              thoughts, its preview auto-updating as tokens arrive. */}
          {stream && stream.kind === 'assistant' && (
            <div className="max-w-[95%] leading-relaxed">
              {renderMarkdownBlocks(closeOpenFence(stream.text))}
              <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 animate-pulse rounded-sm bg-[#c96442]/80" />
            </div>
          )}
          {stream && stream.kind === 'thinking' && <ThinkingCard text={stream.text} streaming />}
          {/* Optimistic sends: pinned under the transcript until the CLI echoes
              the processed turn back, visibly queued while a turn is running. */}
          {pendingSends.map((p) => (
            <div key={`pending-${p.id}`} className="flex flex-col items-end gap-1 animate-chat-item-in">
              <div className={`${USER_BUBBLE_CLASS} opacity-75`}>{renderMarkdown(p.text)}</div>
              <div className="flex items-center gap-1 pr-1 text-[10px] text-stone-400 dark:text-stone-500 select-none">
                {p.queued ? (
                  <>
                    <ListEnd className="w-3 h-3" />
                    Queued - sends when the current turn finishes
                  </>
                ) : (
                  <>
                    <LoaderCircle className="w-3 h-3 animate-spin" />
                    Sending...
                  </>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>
        {/* Jump to bottom (item 14): floats above the composer while the user
            is scrolled up, claude.ai style. */}
        {!pinned && replayDone && (
          <button
            onClick={() => scrollToBottom(true)}
            title="Jump to bottom (Ctrl+End)"
            aria-label="Jump to bottom"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] p-1.5 text-stone-500 dark:text-stone-300 shadow-md hover:text-stone-700 dark:hover:text-stone-100 hover:shadow-lg transition-all cursor-pointer animate-chat-item-in"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Composer (item 12): one rounded card - textarea on top, controls in a
          row underneath with no separator, per the Claude app layout. */}
      <div className="shrink-0 px-3 pb-3">
        {/* Drag bar: force the composer taller than its content, one whole row
            at a time (item 9). */}
        <div
          onPointerDown={onComposerResizeStart}
          onPointerMove={onComposerResizeMove}
          onPointerUp={onComposerResizeEnd}
          className="group flex h-2.5 cursor-ns-resize touch-none items-center justify-center"
          title="Drag to resize"
        >
          <div className="h-0.5 w-8 rounded-full bg-transparent transition-colors group-hover:bg-stone-300 dark:group-hover:bg-stone-600" />
        </div>
        <div className="relative mx-auto max-w-3xl">
          {slashMatches.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1.5 z-20 w-64 overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-lg py-1">
              {slashMatches.map((c, i) => (
                <button
                  key={c}
                  onClick={() => acceptSlash(c)}
                  onMouseEnter={() => setSlashSel(i)}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-xs font-mono cursor-pointer transition-colors ${
                    i === slashSel
                      ? 'bg-stone-100 text-stone-800 dark:bg-white/[0.07] dark:text-stone-100'
                      : 'text-stone-500 dark:text-stone-400'
                  }`}
                >
                  /{c}
                </button>
              ))}
            </div>
          )}
          <div
            className={`rounded-2xl border bg-white dark:bg-[#30302e] shadow-sm transition-colors ${
              dragActive
                ? 'border-[#c96442] ring-2 ring-[#c96442]/30'
                : 'border-stone-300/70 dark:border-white/[0.09] focus-within:border-stone-400/80 dark:focus-within:border-white/20'
            }`}
          >
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
            <AttachmentChips
              attachments={attachments}
              size="sm"
              className="px-3 pt-2.5"
              onRemove={removeAttachment}
              onOpenImage={(id) => setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))}
            />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setSlashDismissed(false)
              }}
              onKeyDown={onComposerKeyDown}
              onPaste={handlePaste}
              placeholder={connected ? 'Write a message...' : 'Disconnected'}
              disabled={!connected}
              rows={1}
              className="block w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[13px] leading-5 text-stone-800 dark:text-stone-100 placeholder-stone-400 dark:placeholder-stone-500 outline-none disabled:opacity-50"
            />
            <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
              <Tooltip content="Attach files" side="top">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!connected}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-40"
                  aria-label="Attach files"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </Tooltip>
              <div className="ml-auto flex items-center gap-1.5">
                {/* Item 6: surface what Enter will do only when it isn't the
                    obvious thing - i.e. the message will queue behind the
                    running turn; otherwise show nothing. */}
                {canSend && isTurnRunning && (
                  <span className="hidden sm:inline text-[10px] text-stone-400 dark:text-stone-500 select-none">
                    Enter to queue
                  </span>
                )}
                <div className="relative">
                  <button
                    onClick={() => setModelMenuOpen((o) => !o)}
                    disabled={!connected}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.06] hover:text-stone-700 dark:hover:text-stone-200 transition-colors cursor-pointer disabled:opacity-40"
                    title="Model"
                  >
                    {modelLabel}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {modelMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setModelMenuOpen(false)} />
                      <div className="absolute bottom-full right-0 mb-1 z-20 w-36 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-lg py-1">
                        {CLAUDE_MODELS.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => changeModel(m.id)}
                            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer"
                          >
                            {m.label}
                            {model.toLowerCase().includes(m.id) && (
                              <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-[#c96442]" />
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {isTurnRunning && (
                  <Tooltip content="Interrupt (Ctrl+C)" side="top">
                    <button
                      onClick={interrupt}
                      className="p-1.5 rounded-lg text-red-500/90 hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                      aria-label="Interrupt the running turn"
                    >
                      <CircleStop className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
                <Tooltip content={isTurnRunning ? 'Queue message (Enter)' : 'Send (Enter)'} side="top">
                  <button
                    onClick={send}
                    disabled={!canSend}
                    aria-label={isTurnRunning ? 'Queue message' : 'Send message'}
                    className={`p-1.5 rounded-full transition-colors ${
                      canSend
                        ? `${ACCENT_BG} text-white cursor-pointer`
                        : 'bg-stone-200 text-stone-400 dark:bg-white/10 dark:text-stone-500 cursor-default'
                    }`}
                  >
                    {isTurnRunning ? <ListEnd className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>

      {dragActive && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded border-2 border-dashed border-[#c96442] bg-[#c96442]/10 pointer-events-none">
          <div className="rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] px-3 py-1.5 text-xs shadow-lg">
            Drop files to attach
          </div>
        </div>
      )}

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
