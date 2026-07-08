import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleStop,
  FilePen,
  FileText,
  Globe,
  ListChecks,
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
import { Markdown } from '../lib/MarkdownRenderer'
import { stripAnsi, hasAnsi, ansiToHtml } from '../lib/ansi'
import hljs from '../lib/hljs'
import { closeWebSocket } from '../lib/ws'
import { getWsUrl } from '../lib/terminalWs'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { formatError } from '../api/format_error'
import { AttachmentChips } from './AttachmentChips'
import { ImageLightbox } from './ImageLightbox'
import { Tooltip } from './Tooltip'
import { type Attachment, nextAttachmentId } from '../lib/spawnDrafts'
import { chatDraftKey, loadChatAttachments, saveChatAttachments } from '../lib/chatDrafts'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { useChatFontStore } from '../lib/chatPrefs'

// ChatPane renders a chat-mode head: it speaks the chat framing
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
  // sending marks a message shown optimistically in-flow (item 26): it appears
  // the instant it's sent - above the thinking/response it triggers - and the
  // flag clears when the CLI's echo confirms it (which can arrive after the
  // response, so we render our own copy rather than wait for it).
  | { kind: 'user'; id: number; text: string; sending?: boolean }
  // A slash command echoed back by the CLI (<command-name>/<command-args>).
  | { kind: 'command'; id: number; name: string; args: string }
  // A local command's output echoed back as <local-command-stdout>.
  | { kind: 'cmdout'; id: number; text: string }
  // A harness-injected system notice (e.g. a <task-notification> when a
  // background task finishes), rendered as a compact muted line, not raw XML.
  | { kind: 'notice'; id: number; text: string }
  | { kind: 'interrupted'; id: number }
  | { kind: 'assistant'; id: number; text: string }
  // durationMs is set for a thought whose streaming we timed live (item 11);
  // replayed history has no timing, so it renders as a plain "Thought".
  | { kind: 'thinking'; id: number; text: string; durationMs?: number }
  | { kind: 'tool'; id: number; toolUseId: string; name: string; input: unknown; result?: string; resultImages?: string[]; isError?: boolean }
  // A native AskUserQuestion tool call. requestId arrives with the paired
  // can_use_tool control_request (the channel the answer goes back on);
  // result is the tool_result once answered.
  | { kind: 'question'; id: number; toolUseId: string; input: unknown; specs: QuestionSpec[]; requestId?: string; result?: string }
  | { kind: 'result'; id: number; isError: boolean; durationMs?: number; costUsd?: number; errorText?: string }

// A message handed to the socket but not yet echoed back by the CLI
// (--replay-user-messages echoes a user turn when it is *processed*, so a
// message sent mid-turn stays here - visibly queued - until the turn ends).
// clientId is the id sent to the daemon so a queued message can be reconciled
// against the server's authoritative `queue` frame and targeted by a dequeue.
interface PendingSend {
  id: number
  clientId: string
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
  // The durable conversation-record id (transcript + stdout share it). Tracked
  // as the anchor for load-older history paging (item 25).
  uuid?: string
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
  // Set by the CLI on the synthesized assistant message it emits when a turn
  // fails mid-response ("API Error: ... The response above may be incomplete.").
  isApiErrorMessage?: boolean
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

// formatDuration renders a millisecond span compactly, rolling up into
// m/h/d past a minute so a long turn reads "10m 12s" not "612s" (item 19).
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

// contentText flattens a user_message content-block array (or plain string) to
// its display text, for rendering a queued message replayed by the daemon.
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
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

// stripLocalCommandCaveat removes the <local-command-caveat>...</local-command-
// caveat> block the CLI injects around local-command output (e.g. after a
// /model change) - it's a note to the model, not user-facing content, and would
// otherwise render as a raw-XML bubble (item 31).
function stripLocalCommandCaveat(text: string): string {
  return text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim()
}

// decodeEntities turns the handful of XML entities that appear in injected
// harness text (a <task-notification> summary) back into their characters.
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
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

// collapseHome rewrites an absolute home path (/home/<user>/..., /Users/<user>/
// ... on macOS) to ~/... for display (item 5) - the machine's home prefix is
// noise in a tool summary. Applied everywhere it appears in the string.
function collapseHome(text: string): string {
  return text.replace(/\/(?:home|Users)\/[^/\s"]+\//g, '~/')
}

// memoryName recognises a Claude auto-memory file
// (~/.claude/projects/<slug>/memory/<name>.md) and returns just <name>, so a
// Read of one renders as "memory <name>" instead of the long absolute path
// (item 5). Null for anything that isn't a memory file.
function memoryName(path: string): string | null {
  const m = /(?:^|\/)memory\/([^/]+?)\.md$/i.exec(path)
  return m ? m[1] : null
}

// readLineInfo turns a Read tool's offset/limit into a short "lines N-M" note
// shown after the filename in the card header (item 1), so the range is visible
// without expanding the (otherwise hidden) input.
function readLineInfo(input: Record<string, unknown> | null): string {
  if (!input) return ''
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  if (offset != null && limit != null) return `lines ${offset}-${offset + limit - 1}`
  if (offset != null) return `from line ${offset}`
  if (limit != null) return `first ${limit} lines`
  return ''
}

// LANG_BY_EXT maps a file extension to a highlight.js language, so a Read tool's
// output can be syntax highlighted by the file it read (item 3).
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', go: 'go', py: 'python',
  rb: 'ruby', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', md: 'markdown', markdown: 'markdown', html: 'xml',
  xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', lua: 'lua',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'diff',
}
function langFromPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? (LANG_BY_EXT[ext] ?? '') : ''
}

// parseToolResult flattens a tool_result block's content into displayable text
// plus any inline images (an image-read returns image blocks, not text - item
// 4). Base64 sources become data URLs; url sources are used verbatim.
function parseToolResult(content: unknown): { text: string; images: string[] } {
  const images: string[] = []
  const collect = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(collect).filter(Boolean).join('\n')
    if (c && typeof c === 'object') {
      const b = c as ClaudeContentBlock & {
        source?: { type?: string; media_type?: string; data?: string; url?: string }
      }
      if (b.type === 'image' && b.source) {
        const s = b.source
        if (s.type === 'base64' && s.data) images.push(`data:${s.media_type ?? 'image/png'};base64,${s.data}`)
        else if (s.type === 'url' && s.url) images.push(s.url)
        return ''
      }
      if (typeof b.text === 'string') return b.text
    }
    return ''
  }
  return { text: stripToolUseError(collect(content)), images }
}

// --- Plan / to-do panel (TodoWrite) -----------------------------------------

// One entry of the agent's TodoWrite list. `activeForm` is the present-tense
// label the CLI shows while a step is in progress ("Running tests").
interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

// parseTodos validates a TodoWrite tool input ({todos: [...]}), returning null
// for anything malformed so the call falls back to a normal tool card.
function parseTodos(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== 'object') return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const out: TodoItem[] = []
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.content !== 'string' || !o.content) continue
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending'
    out.push({ content: o.content, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined })
  }
  return out.length ? out : null
}

// PlanPanel floats the agent's current to-do list (its latest TodoWrite) in the
// chat's top-right corner (item 17): a compact card that expands to the checklist
// and collapses to a "Plan n/total" chip - defaulting collapsed when the pane is
// too narrow to sit a card alongside the transcript.
function PlanPanel({ todos, narrow }: { todos: TodoItem[]; narrow: boolean }) {
  const [open, setOpen] = useState(!narrow)
  // Follow the narrow/wide flip (collapse when it gets tight, re-open when it
  // widens) while still letting the user toggle in between - a render-phase sync
  // like the settings fields use.
  const [prevNarrow, setPrevNarrow] = useState(narrow)
  if (prevNarrow !== narrow) {
    setPrevNarrow(narrow)
    setOpen(!narrow)
  }
  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  const allDone = total > 0 && done === total

  return (
    <div className="absolute top-3 right-3 z-10 w-64 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 bg-white/90 dark:bg-[#2b2b28]/90 shadow-lg backdrop-blur animate-chat-item-in">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left cursor-pointer text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        <ListChecks className={`w-3.5 h-3.5 shrink-0 ${allDone ? 'text-emerald-500' : 'text-[#c96442]'}`} />
        <span className="text-xs font-semibold shrink-0">Plan</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
          {done}/{total}
        </span>
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      <Expandable open={open}>
        <ul className="max-h-72 overflow-y-auto px-2.5 pb-2 space-y-1 text-xs">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {t.status === 'completed' ? (
                <CheckCircle2 className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-500" />
              ) : t.status === 'in_progress' ? (
                <LoaderCircle className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin text-amber-500" />
              ) : (
                <Circle className="mt-0.5 w-3.5 h-3.5 shrink-0 text-stone-300 dark:text-stone-600" />
              )}
              <span
                className={
                  t.status === 'completed'
                    ? 'line-through text-stone-400 dark:text-stone-500'
                    : t.status === 'in_progress'
                      ? 'font-medium text-stone-700 dark:text-stone-200'
                      : 'text-stone-500 dark:text-stone-400'
                }
              >
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      </Expandable>
    </div>
  )
}

// --- Claude-app-ish shared styles -------------------------------------------

// The user's message bubble: borderless, a shade off the pane background.
// No whitespace-pre-wrap: the Markdown chat variant's remark-breaks already
// preserves typed newlines.
const USER_BUBBLE_CLASS =
  'max-w-[85%] rounded-2xl rounded-br-md bg-[#f0eee6] dark:bg-[#31302c] px-3.5 py-2 break-words'

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

// OutputPanel renders a tool's textual output on the shared quiet panel,
// syntax highlighted when a language is known (item 3, e.g. a Read of a .ts
// file) and tinted red on error. Tall output scrolls within a capped height.
function OutputPanel({ text, lang, isError }: { text: string; lang: string; isError?: boolean }) {
  // Code output (a Read of a known extension) is stripped of any stray ANSI and
  // syntax highlighted; terminal output (bash) keeps its ANSI colours, rendered
  // to spans. Neither path ever shows raw escape garbage.
  const html = useMemo(
    () => (lang ? highlightHtml(stripAnsi(text), lang) : hasAnsi(text) ? ansiToHtml(text) : null),
    [text, lang],
  )
  const cls = `${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-y-auto px-2.5 py-1.5 ${
    isError ? 'text-red-600 dark:text-red-300' : 'text-stone-600 dark:text-stone-300'
  }`
  if (html != null) return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />
  return <pre className={cls}>{stripAnsi(text) || '(no output)'}</pre>
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

// memo'd so composer keystrokes (a sibling state change) don't re-render every
// tool card in the transcript (item 16). Props are stable per settled item.
const ToolCard = memo(function ToolCard({ item, worktree }: { item: Extract<ChatItem, { kind: 'tool' }>; worktree: string | null }) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const pending = item.result === undefined
  const input = (typeof item.input === 'object' && item.input !== null ? item.input : null) as
    | Record<string, unknown>
    | null
  const command = typeof input?.command === 'string' ? (input.command as string) : ''
  const isBash = item.name === 'Bash' && command !== ''
  const description = isBash && typeof input?.description === 'string' ? (input.description as string) : ''

  // Read specifics (items 1, 3, 5): the file it read, a "memory <name>" alias
  // for auto-memory files, the line range for the header, whether the input is
  // "simple" (fully described by the header, so the Input panel is hidden), and
  // the language to highlight its output by.
  const isRead = item.name === 'Read'
  const readPath = isRead && typeof input?.file_path === 'string' ? (input.file_path as string) : ''
  const mem = isRead ? memoryName(readPath) : null
  const lineInfo = isRead ? readLineInfo(input) : ''
  const simpleRead =
    isRead && input != null && Object.keys(input).every((k) => k === 'file_path' || k === 'offset' || k === 'limit')
  const outputLang = isRead ? langFromPath(readPath) : ''

  // A Bash header shows the human description when the agent provided one (the
  // script itself lives in the expanded card); a memory Read shows "memory
  // <name>"; other tools show their primary argument, worktree-relative and
  // home-collapsed.
  const summary = mem
    ? `memory ${mem}`
    : collapseHome(trimWorktreePaths(isBash ? description || command : summarizeToolInput(item.input), worktree))
  const summaryMono = !mem && !(isBash && description)
  // The Input panel is redundant for a plain Read (item 1) - everything it holds
  // is already in the header. Bash shows its Command panel unlabelled (item 13).
  const hideInput = simpleRead
  // Whether an input/command panel renders above the output. When it doesn't
  // (a plain Read), the "Output" header is redundant and dropped (item 32).
  const hasInput = isBash || !hideInput
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
      {/* Header row: the whole left side toggles open; a Raw button sits at the
          right, only while expanded (item 32). Two sibling buttons (not nested)
          so the Raw toggle doesn't also collapse the card. */}
      <div className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-stone-600 dark:text-stone-300">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 min-w-0 items-baseline gap-1.5 text-left cursor-pointer hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <Icon className={`w-3 h-3 shrink-0 self-center ${item.isError ? 'text-red-500 dark:text-red-400' : 'text-stone-400 dark:text-stone-500'}`} />
          <span className="font-medium shrink-0">{item.name}</span>
          <span className={`truncate ${summaryMono ? 'font-mono' : ''} text-stone-400 dark:text-stone-500`}>{summary}</span>
          {lineInfo && <span className="shrink-0 text-stone-400/70 dark:text-stone-500/70">{lineInfo}</span>}
        </button>
        {pending && (
          <span className="shrink-0 self-center text-[10px] text-amber-600 dark:text-amber-400/90 animate-pulse">running</span>
        )}
        {open && (
          <button
            onClick={() => setShowRaw((r) => !r)}
            className={`shrink-0 self-center px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
              showRaw
                ? 'bg-stone-200 text-stone-700 dark:bg-white/10 dark:text-stone-200'
                : 'text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300'
            }`}
            title="Toggle the raw tool-call JSON"
          >
            Raw
          </button>
        )}
      </div>
      <Expandable open={open}>
        <div className="px-2.5 pb-2 space-y-1.5">
          {showRaw ? (
            <CodePanel code={rawJson} lang="json" />
          ) : (
            <>
              {isBash ? (
                <CodePanel code={trimWorktreePaths(splitBashChains(command), worktree)} lang="bash" />
              ) : hideInput ? null : (
                <CodePanel code={trimWorktreePaths(JSON.stringify(item.input, null, 2) ?? '', worktree)} lang="json" />
              )}
              {(item.result !== undefined || (item.resultImages && item.resultImages.length > 0)) && (
                <div>
                  {/* "Output" only when there's an input panel above it to
                      separate from; a plain Read's body is output-only (item 32). */}
                  {hasInput && (
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
                      Output
                    </div>
                  )}
                  {item.resultImages && item.resultImages.length > 0 && (
                    <div className="mb-1 max-h-80 overflow-y-auto space-y-1">
                      {item.resultImages.map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt="Tool output image"
                          className="max-w-full rounded-md border border-stone-200 dark:border-white/[0.08]"
                        />
                      ))}
                    </div>
                  )}
                  {item.result !== undefined && !(item.result === '' && item.resultImages?.length) && (
                    <OutputPanel text={item.result} lang={outputLang} isError={item.isError} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Expandable>
    </div>
  )
})

// ThinkingCard is the Claude-app-style thought disclosure: a shimmering
// "Thinking..." label with a live tail while tokens stream, a quiet one-line
// snippet once settled. Clicking expands inline on desktop (clamped, with a
// Show more escape hatch) and opens a bottom sheet on small screens.
// memo'd for the same reason as ToolCard (item 16).
const ThinkingCard = memo(function ThinkingCard({ text, streaming, durationMs }: { text: string; streaming?: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [clipped, setClipped] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // The settled label keeps the same disclosure affordance but names the elapsed
  // time when we timed it live (item 11), e.g. "Thought for 5s".
  const settledLabel = durationMs != null ? `Thought for ${formatDuration(durationMs)}` : 'Thought'

  const trimmed = text.trim()
  const snippet = trimmed.split('\n')[0] ?? ''
  // The live tail shown under the shimmer label while collapsed: the last
  // couple of lines of the thought so far, auto-updating as tokens arrive.
  const tailLines = trimmed.split('\n').filter((l) => l.trim() !== '')
  const tail = tailLines.slice(-2).join('\n')
  // An empty thought (some models - e.g. Opus/Fable turns - reason silently, so
  // the thinking block streams no visible text) has nothing to reveal: show the
  // live "Thinking..." indicator but no disclosure, and don't render a settled
  // empty card at all (item 26).
  const empty = trimmed === ''

  // Only offer "Show more" when the clamped body actually overflows.
  useEffect(() => {
    if (!open || showAll) return
    const el = bodyRef.current
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [open, showAll, text])

  function toggle() {
    if (empty) return
    // On phones an inline expansion is cramped; pop the thought up from the
    // bottom instead.
    if (window.matchMedia('(max-width: 639px)').matches) {
      setSheet(true)
      return
    }
    setOpen((o) => !o)
  }

  // A settled empty thought renders nothing (only the transient streaming
  // indicator is worth showing).
  if (empty && !streaming) return null

  return (
    <div className="text-xs">
      <button
        onClick={toggle}
        disabled={empty}
        className={`group flex w-full items-center gap-1.5 text-left ${empty ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {streaming ? (
          <span className="chat-text-shimmer font-medium shrink-0 text-stone-500">Thinking...</span>
        ) : (
          <span className="shrink-0 font-medium text-stone-400 dark:text-stone-500 group-hover:text-stone-600 dark:group-hover:text-stone-300 transition-colors">
            {settledLabel}
          </span>
        )}
        {!streaming && !open && snippet && (
          <span className="truncate italic text-stone-400/80 dark:text-stone-500/80">{snippet}</span>
        )}
        {!empty && (
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-stone-400/70 dark:text-stone-500/70 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      {streaming && !open && !empty && tail && (
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
                {streaming ? 'Thinking...' : settledLabel}
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
})

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

// reduceHistoryEvents reduces a batch of older (settled) conversation events -
// the load-older page (item 25) - into ChatItems ready to prepend. It mirrors
// the live reducer's settled-event handling (no streaming, model or
// control_request state): user turns (classified like routeUserText),
// assistant text/thinking/tool_use/question blocks with tool_result patching,
// and result footers. A TodoWrite is dropped (the plan panel already holds the
// latest state, not this older one). allocId hands out ids for the batch.
function reduceHistoryEvents(events: ClaudeEvent[], allocId: () => number): ChatItem[] {
  const items: ChatItem[] = []
  const push = (item: DistributiveOmit<ChatItem, 'id'>) => {
    items.push({ ...item, id: allocId() } as ChatItem)
  }
  const patchTool = (toolUseId: string, text: string, isError: boolean, images: string[]) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'tool' && it.toolUseId === toolUseId) {
        it.result = text
        it.isError = isError
        it.resultImages = images.length ? images : undefined
        return
      }
      if (it.kind === 'question' && it.toolUseId === toolUseId) {
        it.result = text
        return
      }
    }
  }
  const routeUser = (rawText: string) => {
    const text = stripLocalCommandCaveat(rawText)
    if (!text) return
    const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
      push({ kind: 'command', name: cmd[1].trim(), args })
      return
    }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
    if (stdout) {
      const body = stdout[1].trim()
      if (body) push({ kind: 'cmdout', text: body })
      return
    }
    if (text.startsWith('[Request interrupted by user')) {
      push({ kind: 'interrupted' })
      return
    }
    if (text.includes('<task-notification>')) {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
      push({ kind: 'notice', text: decodeEntities(summary || 'Background task update') })
      return
    }
    push({ kind: 'user', text })
  }
  const seenBlocks = new Map<string, Set<string>>()
  for (const ev of events) {
    if (ev.type === 'user') {
      const content = ev.message?.content
      if (typeof content === 'string') {
        if (content.trim()) routeUser(content)
        continue
      }
      for (const block of content ?? []) {
        if (block.type === 'text' && block.text?.trim()) routeUser(block.text)
        else if (block.type === 'tool_result' && block.tool_use_id) {
          const p = parseToolResult(block.content)
          patchTool(block.tool_use_id, p.text, block.is_error === true, p.images)
        }
      }
    } else if (ev.type === 'assistant') {
      const content = ev.message?.content
      if (ev.isApiErrorMessage) {
        const text = Array.isArray(content)
          ? content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
          : typeof content === 'string'
            ? content
            : ''
        push({ kind: 'result', isError: true, errorText: text.trim() || undefined })
        continue
      }
      if (!Array.isArray(content)) continue
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
        if (block.type === 'text' && block.text?.trim()) push({ kind: 'assistant', text: block.text })
        else if (block.type === 'thinking' && block.thinking?.trim()) push({ kind: 'thinking', text: block.thinking })
        else if (block.type === 'tool_use' && block.id) {
          const specs = block.name === 'AskUserQuestion' ? parseQuestionSpecs(block.input) : null
          const todos = block.name === 'TodoWrite' ? parseTodos(block.input) : null
          if (specs) push({ kind: 'question', toolUseId: block.id, input: block.input, specs })
          else if (todos) { /* older plan state - the panel already shows the latest */ }
          else push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
        }
      }
    } else if (ev.type === 'result') {
      push({
        kind: 'result',
        isError: ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success'),
        durationMs: ev.duration_ms,
        costUsd: ev.total_cost_usd,
        errorText: ev.is_error ? ev.result : undefined,
      })
    }
  }
  return items
}

export function ChatPane({ agentId, projectId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh }: ChatProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  // The in-flight streamed content block (token streaming via stream_event
  // deltas), rendered live below the settled items and superseded by the
  // complete assistant event that follows it.
  const [stream, setStream] = useState<{ kind: 'assistant' | 'thinking'; text: string } | null>(null)
  // The agent's current plan (its latest TodoWrite), shown in the floating
  // PlanPanel (item 17). Empty until the agent writes a to-do list.
  const [todos, setTodos] = useState<TodoItem[]>([])
  // Chat pane width, tracked so the plan panel collapses when there's no room
  // to sit it alongside the transcript.
  const [paneWidth, setPaneWidth] = useState(0)
  const [replayDone, setReplayDone] = useState(false)
  // Item ids >= this animate in (they arrived live); replayed history commits
  // in one batch without the entrance animation. null while replaying.
  const [liveFromId, setLiveFromId] = useState<number | null>(null)
  const [connected, setConnected] = useState(false)
  // The composer draft (text + attachments) is restored per agent so it survives
  // switching agents/reloads (item 30): text from agentViewPrefs, attachments
  // from the in-memory chatDrafts cache.
  const [input, setInput] = useState(() => loadAgentViewPrefs(projectId, agentId).chatDraft ?? '')
  const inputRef = useRef(input)
  useEffect(() => {
    inputRef.current = input
  }, [input])
  // Messages handed to the socket, awaiting their --replay-user-messages echo
  // (see PendingSend). Rendered pinned under the settled items.
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])
  const sendSeqRef = useRef(1)
  // Optimistically-shown user messages (item 26): a decreasing id counter (kept
  // negative so it never collides with the reducer's positive ids) and the
  // texts still awaiting their CLI echo, so a late echo is deduped rather than
  // rendered a second time.
  const optimisticIdRef = useRef(-1)
  const optimisticTextsRef = useRef<string[]>([])
  // Id of the optimistic "Set model to ..." confirmation (item 31), so the CLI's
  // real echo can supersede it. null when none is pending.
  const optimisticModelIdRef = useRef<number | null>(null)
  // Load-older infinite scroll (item 25): the uuid of the current oldest history
  // line (the paging anchor), a decreasing id space for prepended history (kept
  // well below the optimistic range so it never collides), an in-flight guard,
  // whether the transcript start has been reached, and the scrollHeight snapshot
  // used to keep the viewport anchored across a prepend.
  const oldestUuidRef = useRef<string | null>(null)
  const historyIdRef = useRef(-1_000_000)
  const loadingOlderRef = useRef(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [allHistoryLoaded, setAllHistoryLoaded] = useState(false)
  const pendingPrependRef = useRef<number | null>(null)
  // Composer attachments (same upload flow as the spawn box), restored from the
  // per-agent in-memory cache (item 30).
  const [attachments, setAttachments] = useState<Attachment[]>(() => loadChatAttachments(chatDraftKey(projectId, agentId)))
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
  // Whether agent prose renders serif (item 9, the default) - a Browser setting.
  const serif = useChatFontStore((s) => s.serif)
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
    setTodos([])
    setReplayDone(false)
    setLiveFromId(null)
    // The transcript replay + the daemon's queue frame are authoritative for
    // this new connection, so drop the optimistic copies (queued bubbles and
    // in-flight "sending" messages) that would otherwise double them.
    setPendingSends([])
    optimisticTextsRef.current = []
    optimisticIdRef.current = -1
    optimisticModelIdRef.current = null
    // Reset load-older paging for the fresh backfill.
    oldestUuidRef.current = null
    historyIdRef.current = -1_000_000
    loadingOlderRef.current = false
    setLoadingOlder(false)
    setAllHistoryLoaded(false)
    pendingPrependRef.current = null
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
    // When a thinking block starts streaming we stamp the start time; the settled
    // thinking item picks it up (and clears it) to show "Thought for Xs" (item
    // 11). Replayed history never streams, so it stays null -> a plain "Thought".
    let thinkingStart: number | null = null
    const takeThinkingDuration = (): number | undefined => {
      if (thinkingStart == null) return undefined
      const ms = Date.now() - thinkingStart
      thinkingStart = null
      return ms
    }
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
    const patchTool = (toolUseId: string, result: string, isError: boolean, images: string[]) => {
      const resultImages = images.length > 0 ? images : undefined
      // The tool/question card may still be in the un-flushed batch or already
      // rendered.
      const inPending = pending.find(
        (it) => (it.kind === 'tool' || it.kind === 'question') && it.toolUseId === toolUseId,
      )
      if (inPending && inPending.kind === 'tool') {
        inPending.result = result
        inPending.isError = isError
        inPending.resultImages = resultImages
        return
      }
      if (inPending && inPending.kind === 'question') {
        inPending.result = result
        return
      }
      setItems((prev) =>
        prev.map((it) => {
          if (it.kind === 'tool' && it.toolUseId === toolUseId) return { ...it, result, isError, resultImages }
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

    // reconcileQueue merges the daemon's authoritative queued-message snapshot
    // into the optimistic pending bubbles: keep in-flight "sending" bubbles and
    // any queued bubble the server still lists, and add server-queued messages
    // we don't have (on reconnect, local pending was reset, so this restores the
    // whole queue - item 21's survive-navigation guarantee).
    const reconcileQueue = (messages: { id?: string; content?: unknown }[]) => {
      const server = messages
        .filter((m): m is { id: string; content?: unknown } => typeof m.id === 'string')
        .map((m) => ({ clientId: m.id, text: contentText(m.content) }))
      const serverIds = new Set(server.map((s) => s.clientId))
      setPendingSends((prev) => {
        const kept = prev.filter((p) => !p.queued || serverIds.has(p.clientId))
        const keptIds = new Set(kept.map((p) => p.clientId))
        const added = server
          .filter((s) => !keptIds.has(s.clientId))
          .map((s) => ({ id: sendSeqRef.current++, clientId: s.clientId, text: s.text, queued: true }))
        return [...kept, ...added]
      })
    }

    // handleHistoryBefore prepends an older-history batch (item 25): reduce the
    // events, snapshot the scroll height so the viewport can be re-anchored
    // after the prepend (a layout effect does the adjust), advance the oldest
    // anchor, and mark the end reached.
    const handleHistoryBefore = (events: ClaudeEvent[], done: boolean) => {
      loadingOlderRef.current = false
      setLoadingOlder(false)
      if (events.length > 0) {
        const older = reduceHistoryEvents(events, () => historyIdRef.current--)
        // Advance the anchor to the oldest event of this batch.
        const anchor = events.find((e) => typeof e.uuid === 'string' && e.uuid)?.uuid
        if (anchor) oldestUuidRef.current = anchor
        if (older.length > 0) {
          pendingPrependRef.current = scrollRef.current?.scrollHeight ?? 0
          setItems((prev) => [...older, ...prev])
        }
      }
      if (done) setAllHistoryLoaded(true)
    }

    // routeUserText classifies one user-turn text: slash-command echoes and
    // local command output arrive wrapped in pseudo-XML tags, interrupts as a
    // bracketed marker, everything else is a real user message.
    const routeUserText = (rawText: string) => {
      // Drop the CLI's local-command caveat wrapper; a message that is nothing
      // but the caveat is skipped entirely (item 31).
      const text = stripLocalCommandCaveat(rawText)
      if (!text) return
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
        // the source of truth for the dropdown, and supersedes our optimistic
        // one (item 31).
        const m = /^Set model to\s+(\S+)/.exec(body)
        if (m) {
          setModel(m[1])
          const oid = optimisticModelIdRef.current
          if (oid != null) {
            optimisticModelIdRef.current = null
            setItems((prev) => prev.filter((it) => it.id !== oid))
          }
        }
        if (body) push({ kind: 'cmdout', text: body })
        return
      }
      if (text.startsWith('[Request interrupted by user')) {
        push({ kind: 'interrupted' })
        return
      }
      // A harness-injected background-task notification (<task-notification>):
      // render a compact one-line notice instead of the raw XML (item 15).
      if (text.includes('<task-notification>')) {
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
        push({ kind: 'notice', text: decodeEntities(summary || 'Background task update') })
        return
      }
      // The echo of a message we already showed optimistically (item 26): just
      // confirm that copy (clear its sending flag) instead of rendering a
      // duplicate. The echo can arrive after the turn's response, so relying on
      // it for placement would put the user message below its own reply.
      const oi = optimisticTextsRef.current.indexOf(text)
      if (oi >= 0) {
        optimisticTextsRef.current.splice(oi, 1)
        setItems((prev) => {
          let j = -1
          for (let k = prev.length - 1; k >= 0; k--) {
            const it = prev[k]
            if (it.kind === 'user' && it.sending && it.text === text) {
              j = k
              break
            }
          }
          if (j < 0) return prev
          const next = [...prev]
          next[j] = { ...next[j], sending: false } as ChatItem
          return next
        })
        return
      }
      settlePendingSend(text)
      push({ kind: 'user', text })
    }

    const handleClaudeEvent = (ev: ClaudeEvent) => {
      // The first event carrying a uuid is the oldest loaded so far - the anchor
      // for load-older paging (item 25). Only set once (backfill is oldest-first;
      // a prepend updates it to something older).
      if (ev.uuid && oldestUuidRef.current === null) oldestUuidRef.current = ev.uuid
      switch (ev.type) {
        case 'system': {
          if (ev.subtype === 'init') {
            if (typeof ev.model === 'string' && ev.model) setModel(ev.model)
            if (Array.isArray(ev.slash_commands)) {
              setSlashCommands(ev.slash_commands.filter((c): c is string => typeof c === 'string'))
            }
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
              const parsed = parseToolResult(block.content)
              patchTool(block.tool_use_id, parsed.text, block.is_error === true, parsed.images)
            }
          }
          return
        }
        case 'assistant': {
          const content = ev.message?.content
          // A turn that failed mid-response comes back as an ordinary assistant
          // message flagged isApiErrorMessage; render it as an error box (like a
          // result error) rather than a normal reply so it reads as the failure
          // it is. The head is also flipped into the `error` status server-side.
          if (ev.isApiErrorMessage) {
            const text = Array.isArray(content)
              ? content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
              : typeof content === 'string'
                ? content
                : ''
            push({ kind: 'result', isError: true, errorText: text.trim() || undefined })
            clearStream()
            return
          }
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
              push({ kind: 'thinking', text: block.thinking, durationMs: takeThinkingDuration() })
            } else if (block.type === 'tool_use' && block.id) {
              // AskUserQuestion renders as an interactive question card, not a
              // tool card; its answer channel arrives with the paired
              // control_request (patchQuestionRequest). TodoWrite feeds the
              // floating plan panel instead of a card (item 17).
              const specs = block.name === 'AskUserQuestion' ? parseQuestionSpecs(block.input) : null
              const todos = block.name === 'TodoWrite' ? parseTodos(block.input) : null
              if (specs) {
                push({ kind: 'question', toolUseId: block.id, input: block.input, specs })
              } else if (todos) {
                setTodos(todos)
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
            if (bt === 'thinking') thinkingStart = Date.now()
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
      let msg: {
        type?: string
        status?: string
        head_moved?: boolean
        event?: ClaudeEvent
        messages?: { id?: string; content?: unknown }[]
        events?: ClaudeEvent[]
        done?: boolean
      }
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
        case 'queue':
          // The daemon's authoritative snapshot of still-queued messages (sent
          // after replay_done and on reconnect). Reconcile the optimistic
          // bubbles: keep in-flight "sending" ones and any queued bubble the
          // server still has, and add server-queued messages we're missing (the
          // reload-after-navigate case, where local state was reset).
          reconcileQueue(msg.messages ?? [])
          return
        case 'history_before':
          // A load-older page (item 25): older conversation events to prepend.
          handleHistoryBefore(msg.events ?? [], msg.done === true)
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

  // Keep the viewport anchored across a load-older prepend (item 25): before
  // paint, grow scrollTop by however much taller the content got, so the lines
  // the user was reading stay put instead of jumping down. Runs before the
  // auto-scroll effect below, which no-ops here (a user loading older history is
  // scrolled up, not pinned).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingPrependRef.current != null) {
      el.scrollTop += el.scrollHeight - pendingPrependRef.current
      pendingPrependRef.current = null
    }
  }, [items])

  // Auto-scroll to the bottom on new content while pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items, stream, replayDone, pendingSends])

  // Track the pane width so the plan panel (item 17) can collapse when there's
  // no room to float it alongside the centered transcript.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth))
    ro.observe(el)
    setPaneWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

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

  // requestOlderHistory asks the daemon for the batch older than the current
  // oldest line, when the user scrolls near the top (item 25).
  function requestOlderHistory() {
    if (loadingOlderRef.current || allHistoryLoaded || !replayDone || !oldestUuidRef.current) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    ws.send(JSON.stringify({ type: 'load_before', before: oldestUuidRef.current }))
  }

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop < 300) requestOlderHistory()
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

  // --- Composer draft persistence (item 30) ---------------------------------

  // Save the composer text (debounced) so a half-written message survives an
  // agent switch or reload. Sending clears input, which persists as "no draft".
  useEffect(() => {
    const t = setTimeout(() => patchAgentViewPrefs(projectId, agentId, { chatDraft: input || undefined }), 300)
    return () => clearTimeout(t)
  }, [input, projectId, agentId])

  // --- Composer: attachments ------------------------------------------------

  const attachmentsRef = useRef<Attachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
    // Mirror to the per-agent cache so a switch away restores them.
    saveChatAttachments(chatDraftKey(projectId, agentId), attachments)
  }, [attachments, projectId, agentId])
  // On unmount (agent switch), keep the draft's attachments alive in the cache -
  // do NOT revoke their object URLs, so returning to the agent restores working
  // thumbnails. They're freed on send/remove, or when the page fully reloads.
  useEffect(
    () => () => {
      saveChatAttachments(chatDraftKey(projectId, agentId), attachmentsRef.current)
      patchAgentViewPrefs(projectId, agentId, { chatDraft: inputRef.current || undefined })
    },
    [projectId, agentId],
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

  // sendUserText hands one user turn to the socket, tagged with a client id and
  // whether a turn is currently running (queued). The daemon HOLDS a queued
  // message (draining it when the turn ends) or delivers it immediately, and
  // replays the held queue on reconnect (item 21) - so the queue survives
  // closing the window / navigating away, and stays editable (Up arrow). The
  // bubble is added optimistically; the CLI's echo (or a `queue` frame on
  // reattach) is the source of truth. Returns false when the socket isn't usable.
  function sendUserText(text: string): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    pinnedRef.current = true
    setPinned(true)
    // isTurnRunning already excludes needs_input (that's WAITING/NEEDS_INPUT,
    // not RUNNING/STARTING), so a running turn means the daemon should queue it.
    const queued = isTurnRunning
    const clientId = crypto.randomUUID()
    ws.send(JSON.stringify({ type: 'user_message', id: clientId, queued, content: [{ type: 'text', text }] }))
    if (queued) {
      // A held message shows as a queued bubble pinned under the transcript
      // (reconciled against the server's queue frame on reconnect).
      setPendingSends((prev) => [...prev, { id: sendSeqRef.current++, clientId, text, queued }])
    } else {
      // A message that goes straight through appears immediately, in-flow, above
      // the thinking/response it triggers (item 26); the CLI's echo (which can
      // arrive after that response) is deduped by optimisticTextsRef.
      setItems((prev) => [...prev, { kind: 'user', id: optimisticIdRef.current--, text, sending: true }])
      optimisticTextsRef.current.push(text)
      // It starts a turn; nudge the status optimistically (like the terminal's
      // Enter handling), unless the agent is answering our question.
      if (status !== AgentStatus.NEEDS_INPUT) {
        useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
        onStatusUpdateRef.current?.(AgentStatus.RUNNING)
      }
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
    // All attachments are consumed by the send; free their preview URLs (the
    // unmount handler no longer revokes - it preserves them for the draft cache).
    for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
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
    // Also show the confirmation in-flow right away (item 31): the CLI echoes a
    // /model change to the transcript but not always to the live stream, so it
    // would otherwise not appear until a reload. The CLI's real echo, when it
    // arrives, supersedes this (routeUserText).
    const optId = optimisticIdRef.current--
    optimisticModelIdRef.current = optId
    setItems((prev) => [...prev, { kind: 'cmdout', id: optId, text: `Set model to ${id}` }])
    pinnedRef.current = true
    setPinned(true)
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
    // Up arrow on an empty composer dequeues the most recent still-queued
    // (unsent) message back into the box to edit (item 21). Only queued holds
    // qualify - a message already handed to the CLI can't be recalled. Tell the
    // daemon to drop it from the server queue too.
    if (e.key === 'ArrowUp' && input === '' && slashMatches.length === 0) {
      const last = [...pendingSends].reverse().find((p) => p.queued)
      if (last) {
        e.preventDefault()
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'dequeue', id: last.clientId }))
        }
        setPendingSends((prev) => prev.filter((p) => p.id !== last.id))
        setInput(last.text)
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
      if (before.trim()) parts.push(<Markdown key={key++} text={before} />)
      const specs = parseQuestionBlock(m[1])
      if (specs) {
        parts.push(
          <div key={key++} className="my-1.5">
            <QuestionCard specs={specs} disabled={!connected} onSubmit={sendAnswersAsText} />
          </div>,
        )
      } else {
        parts.push(<Markdown key={key++} text={m[0]} />)
      }
      rest = rest.slice(m.index + m[0].length)
    }
    if (parts.length === 0) return <Markdown text={text} />
    if (rest.trim()) parts.push(<Markdown key={key++} text={rest} />)
    return parts
  }

  function renderChatItem(item: ChatItem): ReactNode {
    switch (item.kind) {
      case 'user':
        return (
          <div className="flex flex-col items-end gap-1">
            <div className={`${USER_BUBBLE_CLASS}${item.sending ? ' opacity-75' : ''}`}>
              <Markdown text={item.text} />
            </div>
            {item.sending && (
              <div className="flex items-center gap-1 pr-1 text-[10px] text-stone-400 dark:text-stone-500 select-none">
                <LoaderCircle className="w-3 h-3 animate-spin" />
                Sending...
              </div>
            )}
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
      case 'notice':
        return (
          <div className="flex justify-center">
            <div className="max-w-[90%] truncate rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 select-none" title={item.text}>
              {item.text}
            </div>
          </div>
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
        return <div className={`max-w-[95%] ${serif ? 'chat-serif' : 'leading-relaxed'}`}>{renderAssistantText(item.text)}</div>
      case 'thinking':
        return <ThinkingCard text={item.text} durationMs={item.durationMs} />
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
        // A failed turn still surfaces its error; a successful one renders
        // nothing - the per-turn duration/cost footer was noise (item 27).
        if (item.isError) {
          return (
            <div className="rounded-lg border border-red-300/70 bg-red-50 dark:border-red-900/70 dark:bg-red-950/30 px-3 py-1.5 text-xs text-red-600 dark:text-red-300 whitespace-pre-wrap break-words">
              {item.errorText || 'The turn ended with an error.'}
            </div>
          )
        }
        return null
    }
  }

  const modelLabel = modelDisplayLabel(model)

  // A turn's result footer (duration/cost) should show once. On a resume the
  // transcript backfill and the live stream can each end with their own result
  // event, landing two footers back to back with nothing between (the "2
  // durations" report); drop a result that is immediately followed by another,
  // keeping only the last of any consecutive run.
  const visibleItems = useMemo(
    () => items.filter((it, i) => !(it.kind === 'result' && items[i + 1]?.kind === 'result')),
    [items],
  )

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
          <div className="mx-auto max-w-5xl px-4 py-3 flex flex-col gap-3">
          {!replayDone && items.length === 0 && (
            <div className="text-xs text-stone-400 dark:text-stone-500 italic py-2">
              {connected ? 'Loading conversation...' : 'Connecting...'}
            </div>
          )}
          {/* Load-older affordance at the very top (item 25). */}
          {replayDone && loadingOlder && (
            <div className="flex items-center justify-center gap-1.5 py-1 text-[11px] text-stone-400 dark:text-stone-500 select-none">
              <LoaderCircle className="w-3 h-3 animate-spin" />
              Loading older messages...
            </div>
          )}
          {replayDone && allHistoryLoaded && items.length > 0 && (
            <div className="text-center py-1 text-[11px] text-stone-300 dark:text-stone-600 select-none">
              Beginning of conversation
            </div>
          )}
          {visibleItems.map((item) => (
            <div key={item.id} className={liveFromId != null && item.id >= liveFromId ? 'animate-chat-item-in' : undefined}>
              {renderChatItem(item)}
            </div>
          ))}
          {/* The in-flight streamed block: markdown-rendered live (with a
              virtual closing fence while inside a code block) plus a pulsing
              caret; streamed thinking uses the same collapsed card as settled
              thoughts, its preview auto-updating as tokens arrive. It's the
              current turn's response, so it sits ABOVE any queued (held-for-
              later) messages (item 33). */}
          {stream && stream.kind === 'assistant' && (
            <div className={`max-w-[95%] ${serif ? 'chat-serif' : 'leading-relaxed'}`}>
              <Markdown text={closeOpenFence(stream.text)} />
              <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 animate-pulse rounded-sm bg-[#c96442]/80" />
            </div>
          )}
          {stream && stream.kind === 'thinking' && <ThinkingCard text={stream.text} streaming />}
          {/* Queued messages: held for later, so pinned at the very bottom under
              the in-flight reply. (A "sending" message is an optimistic item in
              the flow above; only queued holds land here now.) */}
          {pendingSends.map((p) => (
            <div key={`pending-${p.id}`} className="flex flex-col items-end gap-1 animate-chat-item-in">
              <div className={`${USER_BUBBLE_CLASS} opacity-75`}>
                <Markdown text={p.text} />
              </div>
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
        {/* Current plan (item 17): the agent's latest TodoWrite, floated in the
            top-right; collapses to a chip when the pane is narrow. */}
        {todos.length > 0 && replayDone && <PlanPanel todos={todos} narrow={paneWidth > 0 && paneWidth < 560} />}
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
        <div className="relative mx-auto max-w-5xl">
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
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors cursor-pointer disabled:opacity-40 ${
                      modelMenuOpen
                        ? 'bg-stone-100 dark:bg-white/[0.08] text-stone-700 dark:text-stone-200'
                        : 'text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.06] hover:text-stone-700 dark:hover:text-stone-200'
                    }`}
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
