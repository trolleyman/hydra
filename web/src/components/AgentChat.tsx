import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  ClipboardList,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  ListEnd,
  ListPlus,
  LoaderCircle,
  MessageSquare,
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
import { HighlightedTextarea } from './HighlightedTextarea'
import { ImageLightbox } from './ImageLightbox'
import { Tooltip } from './Tooltip'
import { type Attachment, nextAttachmentId } from '../lib/spawnDrafts'
import { chatDraftKey, loadChatAttachments, saveChatAttachments } from '../lib/chatDrafts'
import { chatImageCounterKey, readLocal, writeLocal } from '../lib/storage'
import { parseUploadAttachments } from '../lib/uploadAttachments'
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
  // response, so we render our own copy rather than wait for it). noEntrance
  // suppresses the fade/slide entrance for a message that takes the place of a
  // queued bubble already on screen (item 21) - it was visible, so re-animating
  // it as it settles reads as a flicker.
  | { kind: 'user'; id: number; text: string; sending?: boolean; noEntrance?: boolean }
  // A slash command echoed back by the CLI (<command-name>/<command-args>).
  | { kind: 'command'; id: number; name: string; args: string }
  // A local command's output echoed back as <local-command-stdout>.
  | { kind: 'cmdout'; id: number; text: string }
  // A harness-injected system notice (e.g. a <task-notification> when a
  // background task finishes), rendered as a compact muted line, not raw XML.
  // subagentKey links a "sub-agent finished" notice to its sub-agent view, so
  // the pill can offer a View button.
  | { kind: 'notice'; id: number; text: string; subagentKey?: string }
  | { kind: 'interrupted'; id: number }
  // noEntrance suppresses the fade/slide entrance when this settled block simply
  // replaces the in-flight streamed copy already on screen - it was visible, so
  // re-animating it as it settles reads as a flicker (item 56), same rationale
  // as the queued-user-bubble case above.
  | { kind: 'assistant'; id: number; text: string; noEntrance?: boolean }
  // durationMs is the thinking time the daemon measured for this block (delivered
  // as a hydra_thinking event keyed by msgId); absent for old history recorded
  // before backend timing, which falls back to a transcript-gap estimate or a
  // plain "Thought". msgId lets a late-arriving duration patch this item.
  | { kind: 'thinking'; id: number; text: string; durationMs?: number; msgId?: string; noEntrance?: boolean }
  // ended: the turn finished (or history was replayed) without a result for this
  // tool, so stop showing it as "running" (item 42).
  | { kind: 'tool'; id: number; toolUseId: string; name: string; input: unknown; result?: string; resultImages?: string[]; isError?: boolean; ended?: boolean }
  // A native AskUserQuestion tool call. requestId arrives with the paired
  // can_use_tool control_request (the channel the answer goes back on);
  // result is the tool_result once answered.
  | { kind: 'question'; id: number; toolUseId: string; input: unknown; specs: QuestionSpec[]; requestId?: string; result?: string }
  | { kind: 'result'; id: number; isError: boolean; durationMs?: number; costUsd?: number; usage?: TokenUsage; stopReason?: string; errorText?: string }
  // A sub-agent (Task tool) whose meta carried no parent tool_use id, so it has
  // no Task card to fold into and renders as a standalone card in the flow. The
  // common case - a sub-agent linked to its Task card - needs no item: the Task
  // ToolCard upgrades into a SubagentCard in place (see renderChatItem).
  | { kind: 'subagent'; id: number; agentId: string }

// A sub-agent (Claude Task tool) run, assembled from its sidechain events.
// Keyed by agentId in the `subagents` map (a live line that carries only a
// parent_tool_use_id accumulates under the placeholder key "tool:<id>" until
// the meta frame links it to its real agentId). `toolUseId` (from the meta
// frame, or the live parent_tool_use_id) links it to the parent Task tool
// card, which upgrades into a SubagentCard; `items` is the sub-agent's own
// inner timeline (its thinking, tool calls and replies) and `prompt` its
// opening instruction.
interface SubagentView {
  agentId: string
  toolUseId?: string
  agentType?: string
  description?: string
  prompt?: string
  // 'running' until a sidechain result (or the turn's result) settles it; for a
  // Task-linked sub the parent tool_result is the more precise done signal.
  status: 'running' | 'done'
  // A background/async sub-agent (its Task tool_result was only the launch
  // boilerplate). It runs on past the turn that launched it, so the turn's
  // result must NOT settle it - only its own <task-notification> completion does.
  background?: boolean
  items: ChatItem[]
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// isSubRunning reports whether a sub-agent is still working: the parent Task
// card's tool_result (or its turn ending, `ended`) is the precise done signal
// for a linked sub. A background/async agent is the exception - its tool_result
// is only the launch boilerplate, arriving at spawn time, NOT a completion - so
// that result is ignored and we defer to the sub's own status (settled when its
// sidechain result finally lands), keeping the "working" marker up meanwhile.
function isSubRunning(sub: SubagentView, tool?: ToolItem): boolean {
  if (tool) {
    if (tool.result !== undefined && !isLaunchBoilerplate(tool.result)) return false
    if (tool.ended) return false
  }
  return sub.status === 'running'
}

// subLabels derives a sub-agent's display label + description, preferring the
// meta frame's fields and falling back to the Task tool input / prompt.
function subLabels(sub: SubagentView, tool?: ToolItem): { label: string; desc: string } {
  const input = (typeof tool?.input === 'object' && tool?.input !== null ? tool.input : null) as
    | Record<string, unknown>
    | null
  const label =
    sub.agentType || (typeof input?.subagent_type === 'string' ? (input.subagent_type as string) : '') || 'Sub-agent'
  const desc =
    sub.description ||
    (typeof input?.description === 'string' ? (input.description as string) : '') ||
    (sub.prompt ? sub.prompt.split('\n')[0] : '')
  return { label, desc }
}

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
// Anthropic token-usage shape (subset), carried on message_start / message_delta
// stream events and the final result event.
interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ClaudeEvent {
  type: string
  subtype?: string
  // ISO-8601 wall-clock time the entry was recorded. Only transcript lines
  // carry it (the backfill/replay on reconnect); live stdout stream-json lines
  // don't. Used to anchor the "working" indicator's elapsed clock to when the
  // turn actually started, so a reconnect mid-turn shows the real duration
  // rather than time-since-page-load (item 48).
  timestamp?: string
  // The durable conversation-record id (transcript + stdout share it). Tracked
  // as the anchor for load-older history paging (item 25).
  uuid?: string
  // stop_reason on a complete assistant message: "end_turn"/"tool_use" are
  // normal, "max_tokens" means the reply was truncated, "refusal" a safety stop
  // - only the abnormal ones are surfaced (item: turn footer).
  message?: { id?: string; content?: ClaudeContentBlock[] | string; stop_reason?: string; usage?: TokenUsage }
  duration_ms?: number
  total_cost_usd?: number
  result?: string
  is_error?: boolean
  // Token usage on the final result event (Anthropic usage shape).
  usage?: TokenUsage
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
  // Sub-agent (Task tool) markers: a sidechain event is one of a sub-agent's
  // own inner steps, not part of the main conversation; agentId names which
  // sub-agent. The reducer routes these into that sub-agent's card instead of
  // the main flow (so a sub-agent's prompt no longer masquerades as a user
  // message). Both fields ride verbatim on the stream-json lines - but only
  // TRANSCRIPT lines carry them; a sub-agent line on live stdout (CLI 2.1.x)
  // is marked solely by parent_tool_use_id (the Task tool_use that spawned
  // it), null on main-conversation lines.
  isSidechain?: boolean
  agentId?: string
  parent_tool_use_id?: string | null
  // A background/async sub-agent's completion <task-notification> is written to
  // the main transcript not as a user turn but as bookkeeping records the chat
  // socket relays live: a queue-operation (XML on top-level `content`) and an
  // attachment (XML on `attachment.prompt`). handleClaudeEvent settles the sub
  // off whichever carries it (see handleTaskNotification).
  content?: string
  attachment?: { prompt?: string; commandMode?: string }
  // Raw API event carried by stream_event lines (--include-partial-messages):
  // message_start carries the message's initial usage, message_delta the running
  // output-token count - fed to the live "working" indicator (item 48).
  event?: {
    type?: string
    content_block?: { type?: string }
    delta?: { type?: string; text?: string; thinking?: string }
    usage?: TokenUsage
    message?: { usage?: TokenUsage }
  }
  // control_request fields (--permission-prompt-tool stdio): the CLI asks the
  // client to approve a tool call - in practice only AskUserQuestion, since
  // --dangerously-skip-permissions auto-allows everything that doesn't
  // require user interaction.
  request_id?: string
  request?: { subtype?: string; tool_name?: string; input?: unknown; tool_use_id?: string }
  // hydra_thinking (a Hydra-synthesized event, not from Claude): the daemon
  // measured a thinking block's duration from the live stream and reports it
  // keyed by the assistant message id, so the client shows "Thought for Xs"
  // without timing it in the browser. Replayed from the head's sidecar on
  // reconnect (see internal/http emitThinkingDurations).
  message_id?: string
}

// parseEventTs reads a transcript entry's ISO `timestamp` into epoch ms, or
// null when absent/unparseable (live stdout lines have none).
function parseEventTs(ev: ClaudeEvent): number | null {
  if (typeof ev.timestamp !== 'string') return null
  const t = Date.parse(ev.timestamp)
  return Number.isFinite(t) ? t : null
}

// formatTokens abbreviates a token count (3900 -> "3.9k", 1_200_000 -> "1.2M").
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// formatCost renders a per-turn dollar figure - more precision for tiny amounts
// so a fraction-of-a-cent turn doesn't collapse to "$0.00".
function formatCost(usd: number): string {
  if (usd >= 0.1) return `$${usd.toFixed(2)}`
  if (usd >= 0.001) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

// usageBreakdown builds the hover title spelling out a turn's full token usage -
// input (uncached), cache read/write and output - kept off the visible line
// (item 47: only output shows there) since cache figures are noise at a glance.
function usageBreakdown(u: TokenUsage): string {
  const parts: string[] = []
  if (u.input_tokens) parts.push(`Input ${formatTokens(u.input_tokens)}`)
  if (u.cache_read_input_tokens) parts.push(`Cache read ${formatTokens(u.cache_read_input_tokens)}`)
  if (u.cache_creation_input_tokens) parts.push(`Cache write ${formatTokens(u.cache_creation_input_tokens)}`)
  if (u.output_tokens) parts.push(`Output ${formatTokens(u.output_tokens)}`)
  return parts.join(' · ')
}

// STOP_REASON_LABEL maps an abnormal assistant stop_reason to a short footer
// note. Normal ends (end_turn / tool_use) are absent - only truncation or a
// refusal is worth surfacing (the rest is noise).
const STOP_REASON_LABEL: Record<string, string> = {
  max_tokens: 'response cut off at max tokens',
  refusal: 'stopped (refusal)',
  model_context_window_exceeded: 'response cut off (context full)',
}

// Playful gerunds for the live "working" indicator (item 48), Claude-Code style;
// one is picked per turn so it stays stable while the turn runs.
const WORKING_VERBS = [
  'Flambéing', 'Percolating', 'Simmering', 'Noodling', 'Conjuring', 'Marinating',
  'Whisking', 'Churning', 'Brewing', 'Pondering', 'Tinkering', 'Finagling',
  'Crunching', 'Wrangling', 'Sculpting', 'Concocting',
]

// Auto-reconnect tuning: a connection that stayed open this long counts as
// healthy (resets the failure streak), and quick-failure retries back off
// exponentially up to this cap.
const RECONNECT_HEALTHY_MS = 15_000
const RECONNECT_MAX_DELAY_MS = 15_000

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
  // A TaskUpdate reads best as "#id -> status: subject" (only the parts present).
  if (typeof obj.taskId === 'string' || typeof obj.taskId === 'number') {
    const status = typeof obj.status === 'string' ? obj.status : ''
    const subj = typeof obj.subject === 'string' ? obj.subject : ''
    return `#${obj.taskId}${status ? ` -> ${status}` : ''}${subj ? `: ${subj}` : ''}`
  }
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'subject', 'description', 'prompt']) {
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

// The Task* tool family (TaskCreate/TaskUpdate) is the incremental cousin of
// TodoWrite: instead of one call carrying the whole list, each call mutates a
// single task. parseTaskCreate reads a TaskCreate input ({subject, ...}); a new
// task always starts `pending` (the harness assigns its id in creation order).
function parseTaskCreate(input: unknown): { content: string; activeForm?: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.subject !== 'string' || !o.subject) return null
  return { content: o.subject, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined }
}

// parseTaskUpdate reads a TaskUpdate input ({taskId, status?, subject?, ...}),
// returning the referenced id plus only the fields it changes (status "deleted"
// removes the task). Returns null when it names no task, so the call falls back
// to a normal tool card.
function parseTaskUpdate(
  input: unknown,
): { taskId: string; status?: TodoItem['status'] | 'deleted'; content?: string; activeForm?: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const taskId = typeof o.taskId === 'string' ? o.taskId : typeof o.taskId === 'number' ? String(o.taskId) : ''
  if (!taskId) return null
  const status =
    o.status === 'pending' || o.status === 'in_progress' || o.status === 'completed' || o.status === 'deleted'
      ? o.status
      : undefined
  return {
    taskId,
    status,
    content: typeof o.subject === 'string' && o.subject ? o.subject : undefined,
    activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
  }
}

// parseExitPlan reads an ExitPlanMode input ({plan, planFilePath}) - the plan
// markdown the agent proposes when leaving plan mode, plus the file it was
// written to. Returns the markdown and the file's basename (the long absolute
// planFilePath is noise as a header), or null for anything malformed so the
// call falls back to a normal tool card.
function parseExitPlan(input: unknown): { plan: string; fileName: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.plan !== 'string' || !o.plan.trim()) return null
  const path = typeof o.planFilePath === 'string' ? o.planFilePath : ''
  const fileName = path ? path.split('/').pop() || path : ''
  return { plan: o.plan, fileName }
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
  TaskCreate: ListPlus,
  TaskUpdate: ListChecks,
}

// memo'd so composer keystrokes (a sibling state change) don't re-render every
// tool card in the transcript (item 16). Props are stable per settled item.
const ToolCard = memo(function ToolCard({ item, worktree }: { item: Extract<ChatItem, { kind: 'tool' }>; worktree: string | null }) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const pending = item.result === undefined && !item.ended
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
  // File paths render in the UI sans font (item 23/2); code-like summaries (a
  // Bash command, a Grep pattern) stay monospace. A memory alias / Bash
  // description are prose (sans) already.
  const isPathSummary =
    !isBash && !mem && !!input && (typeof input.file_path === 'string' || typeof input.path === 'string')
  const summaryMono = !mem && !isPathSummary && !(isBash && description)
  // The Input panel is redundant for a plain Read (item 1) - everything it holds
  // is already in the header - and for a tool with no arguments at all (an empty
  // `{}` input, e.g. EnterPlanMode), where a `{}` panel is pure noise. Bash shows
  // its Command panel unlabelled (item 13).
  const emptyInput = input == null || Object.keys(input).length === 0
  const hideInput = simpleRead || emptyInput
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

// PlanCard renders an ExitPlanMode tool call: the agent's proposed plan shown
// as rendered markdown (not the raw JSON a generic tool card would show),
// headed by the plan file's basename (e.g. "compressed-sleeping-flame.md")
// rather than its long absolute path. Expanded by default so the plan is
// readable at a glance; a Raw toggle exposes the underlying tool-call JSON,
// mirroring ToolCard. memo'd for the same reason as ToolCard (item 16).
const PlanCard = memo(function PlanCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(true)
  const [showRaw, setShowRaw] = useState(false)
  const parsed = useMemo(() => parseExitPlan(item.input), [item.input])
  const rawJson = useMemo(() => {
    if (!showRaw) return ''
    const raw: Record<string, unknown> = { input: item.input }
    if (item.result !== undefined) raw.result = item.result
    return JSON.stringify(raw, null, 2)
  }, [showRaw, item.input, item.result])
  // A malformed ExitPlanMode input (no plan text) falls back to the generic card.
  if (!parsed) return <ToolCard item={item} worktree={null} />

  return (
    <div className="rounded-lg border border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03] text-xs overflow-hidden">
      <div className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-stone-600 dark:text-stone-300">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 min-w-0 items-baseline gap-1.5 text-left cursor-pointer hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <ClipboardList className="w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500" />
          <span className="font-medium shrink-0">Plan</span>
          {parsed.fileName && (
            <span className="truncate font-mono text-stone-400 dark:text-stone-500">{parsed.fileName}</span>
          )}
        </button>
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
        <div className="px-2.5 pb-2">
          {showRaw ? (
            <CodePanel code={rawJson} lang="json" />
          ) : (
            <div className="rounded-md border border-stone-200/70 dark:border-white/[0.06] bg-white/40 dark:bg-white/[0.02] px-3 py-1.5">
              <Markdown text={parsed.plan} />
            </div>
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
  // time when we have a duration (timed live, or estimated on replay - item 11,
  // item 7), e.g. "Thought for 5s". Ceil to whole seconds with a 1s floor so a
  // sub-second thought never reads "Thought for 0s".
  const settledLabel =
    durationMs != null ? `Thought for ${formatDuration(Math.max(1000, Math.ceil(durationMs / 1000) * 1000))}` : 'Thought'

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

  // A settled empty thought renders nothing UNLESS we timed it live (item 11):
  // a silently-reasoned turn then still shows "Thought for Xs" (just the label,
  // no snippet or disclosure) rather than the "Thinking..." indicator vanishing.
  if (empty && !streaming && durationMs == null) return null

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

// SubagentTimeline renders a sub-agent's inner steps (thinking / tool calls /
// replies), shared by the folded SubagentCard and the full SubagentChatView.
// skipId drops one inner item (the assistant message shown separately as the
// Report) so it does not appear twice.
function SubagentTimeline({
  sub,
  worktree,
  serif,
  skipId,
}: {
  sub: SubagentView
  worktree: string | null
  serif: boolean
  skipId?: number
}) {
  return (
    <>
      {sub.items.map((it) =>
        it.id === skipId ? null : it.kind === 'thinking' ? (
          <ThinkingCard key={it.id} text={it.text} durationMs={it.durationMs} />
        ) : it.kind === 'tool' ? (
          it.name === 'ExitPlanMode' ? (
            <PlanCard key={it.id} item={it} />
          ) : (
            <ToolCard key={it.id} item={it} worktree={worktree} />
          )
        ) : it.kind === 'assistant' ? (
          <div key={it.id} className={`leading-relaxed ${serif ? 'font-serif' : ''}`}>
            <Markdown text={it.text} />
          </div>
        ) : null,
      )}
    </>
  )
}

// The resolved final report of a sub-agent: `text` rendered as the report body,
// `itemId` set only when it came from an inner assistant message (so the timeline
// can skip it).
interface SubReport {
  text: string
  isError: boolean
  itemId?: number
}

// isLaunchBoilerplate spots the async/background-agent launch acknowledgement
// ("Async agent launched successfully ... internal metadata ...") - that is NOT
// the real report, just the handle returned to the parent at spawn time.
function isLaunchBoilerplate(s: string): boolean {
  return /Async agent launched successfully|internal metadata/i.test(s)
}

// subReport resolves what a sub-agent reported back. Normally that is the Task
// tool_result; but for a background/async agent the tool_result is only the
// launch boilerplate, so the sub-agent's own final assistant message is the real
// report (#62). itemId is set only in that latter case, letting the timeline skip
// the message so it is not shown twice.
function subReport(sub: SubagentView, tool?: ToolItem): SubReport | null {
  const res = tool?.result?.trim()
  if (tool?.isError && res) return { text: tool!.result!, isError: true }
  if (res && !isLaunchBoilerplate(res)) return { text: tool!.result!, isError: false }
  for (let i = sub.items.length - 1; i >= 0; i--) {
    const it = sub.items[i]
    if (it.kind === 'assistant' && it.text.trim()) return { text: it.text, isError: false, itemId: it.id }
  }
  return null
}

// reportSkipId picks the inner timeline item to hide so the final report is not
// shown twice (item: don't duplicate the end message in the steps). When the
// report came from an inner assistant message that item is skipped directly
// (`itemId`); when it came from the parent Task tool_result - which echoes the
// sub-agent's final assistant message verbatim - the matching last assistant
// item is skipped instead.
function reportSkipId(sub: SubagentView, report: SubReport | null): number | undefined {
  if (!report) return undefined
  if (report.itemId != null) return report.itemId
  if (report.isError) return undefined
  for (let i = sub.items.length - 1; i >= 0; i--) {
    const it = sub.items[i]
    if (it.kind === 'assistant') return it.text.trim() === report.text.trim() ? it.id : undefined
  }
  return undefined
}

// SubagentReport renders a sub-agent's final report (an error result as an error
// panel), under a small "Report" heading.
function SubagentReport({ report, serif }: { report: SubReport; serif: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
        Report
      </div>
      {report.isError ? (
        <OutputPanel text={report.text} lang="" isError />
      ) : (
        <div className={`leading-relaxed ${serif ? 'font-serif' : ''}`}>
          <Markdown text={report.text} />
        </div>
      )}
    </div>
  )
}

// parseTaskOutput pulls the fields out of a TaskOutput tool_result - the XML-ish
// envelope the harness returns when the parent agent explicitly retrieves a
// background task's result (`<status>`, `<output>`). A completed output becomes a
// report card instead of leaking the raw envelope into the chat (#62).
function parseTaskOutput(result?: string): { taskId?: string; status?: string; output?: string } | null {
  if (!result) return null
  const grab = (re: RegExp) => result.match(re)?.[1]?.trim()
  const output = result.match(/<output>\s*([\s\S]*?)\s*<\/output>/)?.[1]?.trim()
  if (!output) return null
  return {
    taskId: grab(/<task_id>([\s\S]*?)<\/task_id>/),
    status: grab(/<status>([\s\S]*?)<\/status>/),
    output,
  }
}

// FinishedReportCard surfaces a completed sub-agent's report inline: a compact
// header (label, description, optional link to the full run) over the report body
// rendered as markdown (or an error panel). Shared by the live "sub-agent
// finished" card (dropped at completion time) and the TaskOutput retrieval card
// (#62), so the user sees what the agent reported back without scrolling up to
// the launch card.
function FinishedReportCard({
  label,
  desc,
  report,
  serif,
  onOpenChat,
  openLabel,
}: {
  label: string
  desc?: string
  report: SubReport | null
  serif: boolean
  onOpenChat?: () => void
  openLabel?: string
}) {
  const isError = !!report?.isError
  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        isError
          ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
          : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
      }`}
    >
      <div className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 text-stone-600 dark:text-stone-300">
        <Bot className="w-3.5 h-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
        <span className="font-medium shrink-0">{label}</span>
        <span className="shrink-0 flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-500">
          <Check className="w-3 h-3" />
          finished
        </span>
        {desc && <span className="truncate text-stone-400 dark:text-stone-500">{desc}</span>}
        {onOpenChat && (
          <button
            onClick={onOpenChat}
            className="ml-auto shrink-0 font-medium text-[#c96442] hover:underline cursor-pointer"
          >
            {openLabel || 'View steps'}
          </button>
        )}
      </div>
      <div className="border-t border-stone-200/70 dark:border-white/[0.05] px-2.5 pb-2.5 pt-2">
        {report ? (
          report.isError ? (
            <OutputPanel text={report.text} lang="" isError />
          ) : (
            <div className={`leading-relaxed ${serif ? 'font-serif' : ''}`}>
              <Markdown text={report.text} />
            </div>
          )
        ) : (
          <div className="text-[11px] italic text-stone-400 dark:text-stone-500">No report returned.</div>
        )}
      </div>
    </div>
  )
}

// SubagentCard renders one sub-agent (Task tool) run: its opening prompt, then
// the inner step timeline (thinking / tool calls / replies) tucked behind a
// "N steps" toggle - collapsed by default so it never dominates the main
// conversation (#62) - and finally its report once done. When a Task tool card
// spawned it (`tool` set), the card upgrades that tool card in place; an unlinked
// sub-agent renders standalone. onOpenChat opens the sub-agent's own chat view
// (the pane's top-left selector switches back). finishedBadge shows an explicit
// "finished" chip in the header, used when this same card stands in for the old
// separate finished-report card (item: finished card should match the start card).
const SubagentCard = memo(function SubagentCard({
  sub,
  tool,
  worktree,
  serif,
  onOpenChat,
  finishedBadge,
}: {
  sub: SubagentView
  tool?: ToolItem
  worktree: string | null
  serif: boolean
  onOpenChat?: () => void
  finishedBadge?: boolean
}) {
  const running = isSubRunning(sub, tool)
  // Collapsed by default so a sub-agent never dominates the main conversation
  // (#62); the user expands the card to see its prompt, steps and report.
  const [open, setOpen] = useState(false)
  // The step timeline is collapsed by default (prompt + report are the resting
  // view); the user expands it to inspect the sub-agent's inner work.
  const [stepsOpen, setStepsOpen] = useState(false)

  const { label, desc } = subLabels(sub, tool)
  const steps = sub.items.length
  const report = running ? null : subReport(sub, tool)

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        tool?.isError
          ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
          : running
            ? 'border-violet-300/70 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/[0.05]'
            : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
      }`}
    >
      <div className="flex w-full items-center gap-1.5 pl-2.5 pr-2 text-stone-600 dark:text-stone-300">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left cursor-pointer hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          {running ? (
            <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
              <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-violet-400/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-500" />
            </span>
          ) : (
            <Bot className="w-3 h-3 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
          )}
          <span className="font-medium shrink-0">{label}</span>
          {desc && <span className="truncate text-stone-400 dark:text-stone-500">{desc}</span>}
          {running ? (
            <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] font-medium text-violet-600 dark:text-violet-400/90">
              <LoaderCircle className="w-3 h-3 animate-spin" />
              working{steps > 0 ? ` - ${steps} step${steps === 1 ? '' : 's'}` : ''}
            </span>
          ) : finishedBadge ? (
            <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-500">
              <Check className="w-3 h-3" />
              finished{steps > 0 ? ` - ${steps} step${steps === 1 ? '' : 's'}` : ''}
            </span>
          ) : (
            steps > 0 && (
              <span className="ml-auto shrink-0 text-[10px] text-stone-400 dark:text-stone-500">
                {steps} step{steps === 1 ? '' : 's'}
              </span>
            )
          )}
        </button>
        {onOpenChat && (
          <Tooltip content="Open sub-agent chat" side="top">
            <button
              onClick={onOpenChat}
              aria-label="Open sub-agent chat"
              className="shrink-0 rounded-md p-1 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-white/10 transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
      <Expandable open={open}>
        <div className="px-2.5 pb-2 space-y-2 border-t border-stone-200/70 dark:border-white/[0.05] pt-2">
          {sub.prompt && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
                Prompt
              </div>
              <div className={`break-words leading-relaxed ${serif ? 'font-serif' : ''}`}>
                <Markdown text={sub.prompt} />
              </div>
            </div>
          )}
          {steps > 0 && (
            <div>
              <button
                onClick={() => setStepsOpen((o) => !o)}
                className="flex items-center gap-1 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
              >
                <ChevronRight
                  className={`w-3 h-3 transition-transform duration-200 ${stepsOpen ? 'rotate-90' : ''}`}
                />
                {steps} step{steps === 1 ? '' : 's'}
              </button>
              <Expandable open={stepsOpen}>
                <div className="mt-1.5 space-y-1.5 border-l-2 border-violet-200/60 dark:border-violet-500/20 pl-2.5">
                  <SubagentTimeline sub={sub} worktree={worktree} serif={serif} skipId={reportSkipId(sub, report)} />
                </div>
              </Expandable>
            </div>
          )}
          {report && <SubagentReport report={report} serif={serif} />}
        </div>
      </Expandable>
    </div>
  )
})

// SubagentChatView is a sub-agent's conversation as its own full view: the
// pane's timeline area shows the sub-agent's prompt, inner steps and report
// instead of the main conversation. Reached via the top-left selector, the
// Task card's open-chat button or a finished notice's View link.
function SubagentChatView({
  sub,
  tool,
  worktree,
  serif,
}: {
  sub: SubagentView
  tool?: ToolItem
  worktree: string | null
  serif: boolean
}) {
  const running = isSubRunning(sub, tool)
  const { label, desc } = subLabels(sub, tool)
  const report = running ? null : subReport(sub, tool)
  return (
    <>
      <div className="flex items-baseline gap-2 pt-8 text-stone-600 dark:text-stone-300">
        <Bot className="w-4 h-4 shrink-0 self-center text-violet-500/80 dark:text-violet-400/80" />
        <span className="text-sm font-semibold">{label}</span>
        {desc && <span className="truncate text-xs text-stone-400 dark:text-stone-500">{desc}</span>}
        {running ? (
          <span className="ml-auto shrink-0 self-center flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400/90">
            <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
            working
          </span>
        ) : (
          <span className="ml-auto shrink-0 self-center flex items-center gap-1 text-[11px] text-stone-400 dark:text-stone-500">
            <Check className="w-3.5 h-3.5" />
            finished
          </span>
        )}
      </div>
      {sub.prompt && (
        <div>
          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
            Prompt
          </div>
          <div className={`break-words leading-relaxed ${serif ? 'font-serif' : ''}`}>
            <Markdown text={sub.prompt} />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 text-xs">
        <SubagentTimeline sub={sub} worktree={worktree} serif={serif} skipId={reportSkipId(sub, report)} />
      </div>
      {report && <SubagentReport report={report} serif={serif} />}
      {running && (
        <div className="flex items-center gap-1.5 text-[11px] select-none">
          <span className="text-[#c96442]">✳</span>
          <span className="chat-text-shimmer font-medium">Working...</span>
        </div>
      )}
    </>
  )
}

// ChatViewSelector is the top-left dropdown listing the current agents - the
// main conversation plus each sub-agent (Task tool run) with its live status -
// switching which conversation the pane shows. Rendered only once sub-agents
// exist; floats over the timeline like the jump-to-bottom button.
function ChatViewSelector({
  chatView,
  subagents,
  taskToolByUse,
  onSelect,
}: {
  chatView: string
  subagents: Record<string, SubagentView>
  taskToolByUse: Record<string, ToolItem>
  onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const subs = Object.values(subagents)
  const toolOf = (sub: SubagentView) => (sub.toolUseId ? taskToolByUse[sub.toolUseId] : undefined)
  const current = chatView !== 'main' ? subagents[chatView] : undefined
  const currentLabel = current ? subLabels(current, toolOf(current)).label : 'Main conversation'
  const pick = (key: string) => {
    setOpen(false)
    onSelect(key)
  }
  return (
    <div className="absolute top-2 left-3 z-20 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Switch agent chat"
        className={`flex items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/10 bg-white/90 dark:bg-[#30302e]/90 backdrop-blur px-2.5 py-1 shadow-sm transition-colors cursor-pointer ${
          open
            ? 'text-stone-800 dark:text-stone-100'
            : 'text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200'
        }`}
      >
        {current ? (
          <Bot className="w-3.5 h-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
        ) : (
          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
        )}
        <span className="max-w-48 truncate font-medium">{currentLabel}</span>
        {current && isSubRunning(current, toolOf(current)) && (
          <LoaderCircle className="w-3 h-3 shrink-0 animate-spin text-violet-500/80 dark:text-violet-400/80" />
        )}
        <ChevronDown className="w-3 h-3 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 w-72 overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-lg py-1">
            <button
              onClick={() => pick('main')}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5 shrink-0 text-stone-400 dark:text-stone-500" />
              <span className="font-medium">Main conversation</span>
              {chatView === 'main' && <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-[#c96442]" />}
            </button>
            {subs.map((sub) => {
              const tool = toolOf(sub)
              const { label, desc } = subLabels(sub, tool)
              return (
                <button
                  key={sub.agentId}
                  onClick={() => pick(sub.agentId)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer"
                >
                  <Bot className="w-3.5 h-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
                  <span className="shrink-0 font-medium">{label}</span>
                  {desc && <span className="truncate text-stone-400 dark:text-stone-500">{desc}</span>}
                  <span className="ml-auto shrink-0 flex items-center gap-1">
                    {isSubRunning(sub, tool) && (
                      <LoaderCircle className="w-3 h-3 animate-spin text-violet-500/80 dark:text-violet-400/80" />
                    )}
                    {chatView === sub.agentId && <Check className="w-3.5 h-3.5 text-[#c96442]" />}
                  </span>
                </button>
              )
            })}
          </div>
        </>
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

// deriveAnswered reconstructs which options (and any free-text "Other") each
// question resolved to, from the recorded tool_result text. On a resume the
// card's local selection state is gone - all we have is the durable result,
// which embeds the answers as `"<question>"="<comma-joined labels>"` pairs (the
// shape the real CLI's AskUserQuestion result produces, mirrored by the
// simulation). Matching those labels back to option indices lets a replayed
// card highlight the chosen options just as it did right after answering.
function deriveAnswered(specs: QuestionSpec[], answeredText: string): { selected: Set<number>[]; other: string[] } {
  const selected = specs.map(() => new Set<number>())
  const other = specs.map(() => '')
  specs.forEach((q, qi) => {
    const needle = `"${q.question}"="`
    const start = answeredText.indexOf(needle)
    if (start === -1) return
    const from = start + needle.length
    const end = answeredText.indexOf('"', from)
    if (end === -1) return
    // The labels were joined with ", " (see submit()). Consume the value left to
    // right, matching whole option labels (longest first, so a label that itself
    // contains ", " isn't mistaken for two) and dropping anything else into the
    // free-text "Other" field.
    let rest = answeredText.slice(from, end)
    const extras: string[] = []
    while (rest.length > 0) {
      const match = q.options
        .map((o) => o.label)
        .filter((l) => rest === l || rest.startsWith(l + ', '))
        .sort((a, b) => b.length - a.length)[0]
      if (match != null) {
        selected[qi].add(q.options.findIndex((o) => o.label === match))
        rest = rest.slice(match.length).replace(/^, /, '')
      } else {
        const sep = rest.indexOf(', ')
        extras.push(sep === -1 ? rest : rest.slice(0, sep))
        rest = sep === -1 ? '' : rest.slice(sep + 2)
      }
    }
    if (extras.length) other[qi] = extras.join(', ')
  })
  return { selected, other }
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

  // On a resume the card mounts already-answered with no local selection - and
  // the same holds if it was answered in another tab. Recover the chosen
  // options from the recorded result so the settled card highlights them just
  // as it did right after answering. A live answer in this tab keeps its own
  // local selection, so only fall back when nothing was picked here.
  const derived = useMemo(
    () => (answeredText != null ? deriveAnswered(specs, answeredText) : null),
    [specs, answeredText],
  )
  const localEmpty = selected.every((s) => s.size === 0) && other.every((v) => v.trim() === '')
  const showSelected = derived && localEmpty ? derived.selected : selected
  const showOther = derived && localEmpty ? derived.other : other

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
              const isSel = showSelected[qi].has(oi)
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
              value={showOther[qi]}
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

// ChatUserMessage renders a user turn: the prose bubble plus any uploads it
// referenced, shown as attachment chips / image thumbnails (clickable into a
// lightbox) rather than raw paths, with the CLI's image placeholder stripped
// (items 41, 43). memo'd so composer keystrokes don't re-parse every message.
const ChatUserMessage = memo(function ChatUserMessage({
  text,
  sending,
  dimmed,
  projectId,
}: {
  text: string
  sending?: boolean
  // dimmed renders the muted (opacity-75) bubble without the "Sending..." row -
  // used for a queued message pinned under the transcript, so it shows the same
  // image thumbnails / chips as a finalized turn instead of raw upload paths.
  dimmed?: boolean
  projectId: string | null
}) {
  const { text: body, attachments } = useMemo(() => parseUploadAttachments(text, projectId), [text, projectId])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  // Nothing left after stripping the CLI's image placeholder (item 41) - don't
  // render an empty bubble.
  if (!body && attachments.length === 0 && !sending && !dimmed) return null
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`${USER_BUBBLE_CLASS}${sending || dimmed ? ' opacity-75' : ''}`}>
        {body && <Markdown text={body} />}
        {attachments.length > 0 && (
          <AttachmentChips
            attachments={attachments}
            size="sm"
            className={body ? 'mt-2' : ''}
            onOpenImage={(id) => setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))}
          />
        )}
      </div>
      {/* No "Sending..." row: the dimmed (opacity-75) bubble already signals the
          in-flight state, and a row that appears then vanishes on confirm shifted
          the whole transcript below it. */}
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
})

// reduceHistoryEvents reduces a batch of older (settled) conversation events -
// the load-older page (item 25) - into ChatItems ready to prepend. It mirrors
// the live reducer's settled-event handling (no streaming, model or
// control_request state): user turns (classified like routeUserText),
// assistant text/thinking/tool_use/question blocks with tool_result patching,
// and result footers. A TodoWrite is dropped (the plan panel already holds the
// latest state, not this older one). allocId hands out ids for the batch.
function reduceHistoryEvents(events: ClaudeEvent[], allocId: () => number, durations?: Map<string, number>): ChatItem[] {
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
    // A user turn starting settles the previous turn's synthesized footer
    // (mirrors the live reducer's routeUserText).
    flushHistFooter()
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
  // The transcript has no `result` events (they aren't part of Claude's durable
  // record), so a historical turn's footer is synthesized from the assistant
  // messages' own usage. The transcript records one assistant event per content
  // block, each carrying the same message envelope (id, usage, stop_reason even
  // on non-final blocks), so usage counts once per message id and the footer
  // flushes only at a turn boundary (the next user message) - never per event,
  // which interleaved footers with the conversation. No duration/cost is
  // recoverable, so the footer shows just the token count (+ any abnormal-stop
  // flag).
  let histTurnOut = 0
  let histLastUsage: TokenUsage | undefined
  let histStopReason: string | null = null
  const histUsageCounted = new Set<string>()
  const flushHistFooter = () => {
    const total = histTurnOut
    const sr = histStopReason
    histTurnOut = 0
    histStopReason = null
    if (!sr) return
    if (total || (sr !== 'end_turn' && STOP_REASON_LABEL[sr])) {
      push({
        kind: 'result',
        isError: false,
        usage: total ? { ...(histLastUsage ?? {}), output_tokens: total } : histLastUsage,
        stopReason: sr,
      })
    }
  }
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
        else if (block.type === 'thinking') {
          // Duration from the daemon's measurement (sent up-front on connect, so
          // it's in hand even for a lazily-loaded older batch); show an empty
          // silently-reasoned thought only when it carries one.
          const dur = msgId ? durations?.get(msgId) : undefined
          if (block.thinking?.trim() || dur != null) push({ kind: 'thinking', msgId: msgId || undefined, text: block.thinking ?? '', durationMs: dur })
        }
        else if (block.type === 'tool_use' && block.id) {
          const specs = block.name === 'AskUserQuestion' ? parseQuestionSpecs(block.input) : null
          const todos = block.name === 'TodoWrite' ? parseTodos(block.input) : null
          if (specs) push({ kind: 'question', toolUseId: block.id, input: block.input, specs })
          else if (todos) { /* older plan state - the panel already shows the latest */ }
          // Task* ops fall through to a normal tool card (like any other tool);
          // only the panel state is latest-wins, and that is driven by the live
          // reducer's replay, not this older page.
          else push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
        }
      }
      // Turn-footer synthesis (item: historical usage): roll this message's
      // output into the pending turn footer, once per message id.
      const u = ev.message?.usage
      if (u?.output_tokens && (!msgId || !histUsageCounted.has(msgId))) {
        if (msgId) histUsageCounted.add(msgId)
        histTurnOut += u.output_tokens
        histLastUsage = u
      }
      const sr = ev.message?.stop_reason
      if (sr && sr !== 'tool_use') histStopReason = sr
    } else if (ev.type === 'result') {
      // A real result footer replaces the turn's pending synthesized one.
      histTurnOut = 0
      histStopReason = null
      const out = ev.usage?.output_tokens
      push({
        kind: 'result',
        isError: ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success'),
        durationMs: ev.duration_ms,
        costUsd: ev.total_cost_usd,
        usage: ev.usage ?? (out ? { output_tokens: out } : undefined),
        errorText: ev.is_error ? ev.result : undefined,
      })
    }
  }
  // A pending footer at the end of the page is deliberately dropped, not
  // flushed: this page's last event adjoins the previously-oldest event, so a
  // turn straddling the boundary already produced its footer in the items
  // below - flushing here would duplicate it (with content in between, where
  // the consecutive-results dedup can't collapse it).
  return items
}

// The settled message list, memoized so the live token stream (which updates
// once per delta, many times a second) doesn't re-render every prior message.
// While a turn streams, only `stream` changes in ChatPane - none of these props
// do - so this whole list bails out; without it, each token delta re-rendered
// every settled message's markdown (O(messages x tokens), the source of the
// scroll jank on long conversations). It re-renders only when the settled items
// change (a message commits) or when something that alters how a row renders
// changes (serif/worktree/connected/subagents). `renderItem` is a stable wrapper
// (see ChatPane) so it never trips the memo; the fields it reads are listed in
// the comparator so a change to any of them still refreshes the list.
interface SettledMessagesProps {
  items: ChatItem[]
  liveFromId: number | null
  renderItem: (item: ChatItem) => ReactNode
  serif: boolean
  connected: boolean
  worktreePath: string | null
  subByToolUse: Record<string, SubagentView>
  subagents: Record<string, SubagentView>
}

const SettledMessages = memo(
  function SettledMessages({ items, liveFromId, renderItem }: SettledMessagesProps) {
    return (
      <>
        {items.map((item) => (
          <div
            key={item.id}
            className={
              liveFromId != null && item.id >= liveFromId && !('noEntrance' in item && item.noEntrance)
                ? 'animate-chat-item-in'
                : undefined
            }
          >
            {renderItem(item)}
          </div>
        ))}
      </>
    )
  },
  (a, b) =>
    a.items === b.items &&
    a.liveFromId === b.liveFromId &&
    a.renderItem === b.renderItem &&
    a.serif === b.serif &&
    a.connected === b.connected &&
    a.worktreePath === b.worktreePath &&
    a.subByToolUse === b.subByToolUse &&
    a.subagents === b.subagents,
)

export function ChatPane({ agentId, projectId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh }: ChatProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  // Thinking-block durations the daemon measured, keyed by assistant message id
  // (delivered as hydra_thinking events - replayed from the head's sidecar on
  // connect, then live). The reducer reads this when it builds a thinking item;
  // a load-older batch reads it too (reduceHistoryEvents). A ref so both survive
  // re-renders and the whole connection's worth of durations stays in hand.
  const thoughtDurationsRef = useRef<Map<string, number>>(new Map())
  // The in-flight streamed content block (token streaming via stream_event
  // deltas), rendered live below the settled items and superseded by the
  // complete assistant event that follows it.
  const [stream, setStream] = useState<{ kind: 'assistant' | 'thinking'; text: string } | null>(null)
  // The agent's current plan (its latest TodoWrite), shown in the floating
  // PlanPanel (item 17). Empty until the agent writes a to-do list.
  const [todos, setTodos] = useState<TodoItem[]>([])
  // Live "working" indicator (item 48): the turn's start time (for the ticking
  // elapsed), the elapsed seconds, the running output-token count (completed
  // messages + the in-flight one), and the per-turn verb. Reset each turn.
  const turnStartRef = useRef<number | null>(null)
  // The current turn's true wall-clock start (ms), parsed from the triggering
  // user message's transcript timestamp when the reconnect backfill replays it.
  // Null until a turn-starting user message with a timestamp is seen (a live
  // turn we witnessed from the start has none, and correctly falls back to
  // Date.now()). Consumed by the elapsed effect and corrected at replay_done.
  const turnStartClockRef = useRef<number | null>(null)
  const turnTokensRef = useRef(0)
  const curMsgTokensRef = useRef(0)
  const turnCountRef = useRef(0)
  // The latest assistant message's stop_reason this turn, so the footer can flag
  // an abnormal end (max_tokens truncation / refusal). Reset when a turn starts.
  const turnStopReasonRef = useRef<string | null>(null)
  const [turnVerb, setTurnVerb] = useState(WORKING_VERBS[0])
  const [elapsed, setElapsed] = useState(0)
  const [turnTokens, setTurnTokens] = useState(0)
  // Whether the CLI is authed with a real API key (system:init apiKeySource).
  // Subscription/OAuth auth reports "none", where total_cost_usd is a notional
  // API-rate figure not money billed - so the footer shows cost only for a key.
  const [apiKeyReal, setApiKeyReal] = useState(false)
  // Sub-agents (Task tool runs) keyed by agentId, each assembled from its
  // sidechain events. A linked sub folds into its Task card; an unlinked one
  // renders via a 'subagent' item. Reset per connection like `items`.
  const [subagents, setSubagents] = useState<Record<string, SubagentView>>({})
  // Which conversation the pane shows: the main agent's, or one sub-agent's
  // own chat ('main' | a `subagents` key). Switched by the top-left selector,
  // the Task card's open-chat button and a finished notice's View link. It
  // survives reconnects (the replay rebuilds the same keys); while the key is
  // missing (mid-replay, or a stale key) the pane falls back to the main view.
  const [chatView, setChatView] = useState<string>('main')
  // The main view's scroll spot, parked while a sub-agent view is open so
  // coming back lands where the reader left off.
  const mainScrollRef = useRef<{ top: number; pinned: boolean } | null>(null)
  // Chat pane width, tracked so the plan panel collapses when there's no room
  // to sit it alongside the transcript.
  const [paneWidth, setPaneWidth] = useState(0)
  const [replayDone, setReplayDone] = useState(false)
  // Item ids >= this animate in (they arrived live); replayed history commits
  // in one batch without the entrance animation. null while replaying.
  const [liveFromId, setLiveFromId] = useState<number | null>(null)
  const [connected, setConnected] = useState(false)
  // Auto-reconnect: without it the pane sits on a dead socket forever after any
  // drop (a daemon restart/upgrade, the terminal<->chat mode toggle's session
  // relaunch, a network blip) - nothing else ever bumps reconnectAttempt, so
  // the composer showed "Disconnected" until a manual refresh. Every close
  // schedules a retry that re-runs the connect effect; the backend lazy-resumes
  // the head on attach, so reconnecting is always safe. retryStreakRef counts
  // consecutive quick failures (connect -> die within seconds) for backoff; a
  // connection that stayed up resets it so the first retry after a healthy run
  // is near-instant.
  const [autoRetry, setAutoRetry] = useState(0)
  const retryStreakRef = useRef(0)
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
  // A ref mirror of pendingSends so the (effect-scoped) reducer can tell whether
  // a just-echoed user turn came from a queued bubble - if so, the settled item
  // replaces it without an entrance animation (it was already on screen).
  const pendingSendsRef = useRef<PendingSend[]>([])
  useEffect(() => {
    pendingSendsRef.current = pendingSends
  }, [pendingSends])
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
  // Explicit composer height (px), driven by the per-line auto-grow effect. The
  // markdown-highlight textarea is absolutely positioned inside its wrapper, so
  // it can't size the box itself - the wrapper carries the height instead. Seed
  // it from the saved min rows (leading-5 = 20px line, pt-2.5 + pb-1 = 14px pad)
  // so the composer opens at the right height before the effect measures.
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    const saved = loadAgentViewPrefs(projectId, agentId).chatComposerRows
    const rows = saved && saved >= 1 && saved <= 10 ? Math.round(saved) : 1
    return rows * 20 + 14
  })
  const composerDragRef = useRef<{ startY: number; startRows: number; lineHeight: number } | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The inner content wrapper inside the scroll container; observed so we can
  // follow the bottom smoothly while a card expands (item 55) - the height
  // grows across the 0.22s disclosure animation, not in one step.
  const contentRef = useRef<HTMLDivElement>(null)
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
  // The current head status, read from inside the WS reducer closure (which is
  // pinned to its own render) to decide at replay_done whether a still-"working"
  // sub-agent is genuinely live or just stale replayed history (item 5).
  const isTurnRunningRef = useRef(isTurnRunning)
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate
    onDiffRefreshRef.current = onDiffRefresh
    isTurnRunningRef.current = isTurnRunning
  })

  useEffect(() => {
    setItems([])
    setStream(null)
    setTodos([])
    setSubagents({})
    setReplayDone(false)
    setLiveFromId(null)
    // Durations are re-sent from the sidecar at the start of each connection.
    thoughtDurationsRef.current = new Map()
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

    // --- Task* plan reconstruction (item 17, cont.) ------------------------
    // TodoWrite carries the whole to-do list in one call, so it can just replace
    // `todos`. The Task* family (TaskCreate/TaskUpdate) is incremental, so we
    // rebuild the list here and republish it to the same PlanPanel: TaskCreate
    // appends a task (the harness numbers them in creation order - #1, #2, ... -
    // which we mirror with taskSeq, since the assigned id lives in the tool
    // *result*, not its input); TaskUpdate mutates one by id, or drops it on
    // status "deleted". A session uses one planning tool or the other; if both
    // ever appear, the most recent write wins.
    const taskItems = new Map<string, { content: string; status: TodoItem['status']; activeForm?: string; order: number }>()
    let taskSeq = 0
    const publishTasks = () => {
      const list = [...taskItems.values()]
        .sort((a, b) => a.order - b.order)
        .map(({ content, status, activeForm }) => ({ content, status, activeForm }))
      setTodos(list)
    }
    // applyTaskTool folds one Task* tool_use into the plan panel (TaskCreate
    // appends a pending task; TaskUpdate mutates one by id, or drops it on status
    // "deleted"). Non-Task tools and malformed inputs are ignored. The block is
    // still rendered as a normal tool card by the caller, so the task-list
    // mutation stays visible in the conversation flow too.
    const applyTaskTool = (name: string | undefined, input: unknown) => {
      if (name === 'TaskCreate') {
        const t = parseTaskCreate(input)
        if (!t) return
        taskSeq += 1
        taskItems.set(String(taskSeq), { content: t.content, status: 'pending', activeForm: t.activeForm, order: taskSeq })
        publishTasks()
      } else if (name === 'TaskUpdate') {
        const u = parseTaskUpdate(input)
        if (!u) return
        // A TaskUpdate for a task we never saw created (e.g. its create predates
        // the replay window) has nothing to reflect yet.
        const cur = taskItems.get(u.taskId)
        if (!cur) return
        if (u.status === 'deleted') taskItems.delete(u.taskId)
        else {
          if (u.status) cur.status = u.status
          if (u.content) cur.content = u.content
          if (u.activeForm !== undefined) cur.activeForm = u.activeForm
        }
        publishTasks()
      }
    }

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
    // Which block kinds this message streamed live. `message_stop` clears
    // streamBuf (to drop the in-flight node) BEFORE the settled assistant/thinking
    // event arrives, so streamBuf can't tell the settle "you were already on
    // screen". This set outlives message_stop - reset per message (message_start),
    // added on each streamed block - so the settle can suppress its entrance
    // animation and the finished message doesn't re-fade over text already there.
    let streamedKinds = new Set<'assistant' | 'thinking'>()
    // Turn-footer synthesis for backfilled history (the transcript has no
    // `result` events to carry usage). The transcript records one assistant
    // event PER CONTENT BLOCK, each carrying the same message envelope (id,
    // usage, stop_reason - even on non-final blocks), so usage is counted once
    // per message id and the footer is flushed only at a turn boundary (the
    // next user message, or replay end) - synthesizing it per event put a
    // footer BEFORE the text of a [thinking, text] message and a duplicate
    // after it, interleaved with the conversation. A live turn's real `result`
    // event discards the pending footer and renders its own instead.
    let histTurnOut = 0
    let histLastUsage: TokenUsage | undefined
    let histStopReason: string | null = null
    const histUsageCounted = new Set<string>()
    const discardHistFooter = () => {
      histTurnOut = 0
      histStopReason = null
    }
    const flushHistFooter = () => {
      const total = histTurnOut
      const sr = histStopReason
      discardHistFooter()
      // No stop_reason seen -> the turn never completed (an interrupt, or the
      // replay caught it mid-flight); its live continuation or real result
      // handles the footer, so pushing partial usage here would be noise.
      if (!sr) return
      if (total || (sr !== 'end_turn' && STOP_REASON_LABEL[sr])) {
        push({
          kind: 'result',
          isError: false,
          usage: total ? { ...(histLastUsage ?? {}), output_tokens: total } : histLastUsage,
          stopReason: sr,
        })
      }
    }
    // Thinking durations are measured on the daemon now (delivered as
    // hydra_thinking events into thoughtDurationsRef, keyed by message id), not
    // timed in the browser - so a reload/resume shows the same "Thought for Xs"
    // for every client. The estimate below is only a fallback for old history
    // recorded before backend timing existed.
    //
    // The wall-clock timestamp of the previously handled transcript event, so a
    // replayed thought (which never streams, so the live timer above is empty)
    // can still show "Thought for Xs" - estimated as the gap from the event that
    // triggered the turn to this assistant message (item 7). Live stdout lines
    // carry no timestamp, so this stays null there and the live timer is used.
    let prevEventTs: number | null = null
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

    // --- Sub-agent (Task tool) routing -------------------------------------
    // Sidechain events are a sub-agent's own inner steps; they must not land in
    // the main flow (that is the bug where a sub-agent's prompt showed as a user
    // message). We accumulate each sub-agent in `subLocal`, keyed by agentId,
    // and commit to the `subagents` state on the same replay-vs-live cadence as
    // the main items (one batch during replay, microtask-coalesced when live).
    const subLocal: Record<string, SubagentView> = {}
    // Per-sub id counter (for inner item React keys) + seen-block set (idempotent
    // block handling, mirroring the main reducer's seenBlocks).
    const subMeta = new Map<string, { nextId: number; seen: Map<string, Set<string>>; lastTs: number | null }>()
    let subFlushScheduled = false
    const flushSubagents = () => {
      subFlushScheduled = false
      // Fresh object + fresh item arrays so React re-renders the changed subs.
      const snap: Record<string, SubagentView> = {}
      for (const k in subLocal) snap[k] = { ...subLocal[k], items: [...subLocal[k].items] }
      setSubagents(snap)
    }
    const scheduleSubFlush = () => {
      if (replaying || subFlushScheduled) return
      subFlushScheduled = true
      queueMicrotask(flushSubagents)
    }
    const ensureSubagent = (agentId: string): SubagentView => {
      let sub = subLocal[agentId]
      if (!sub) {
        sub = { agentId, status: 'running', items: [] }
        subLocal[agentId] = sub
        subMeta.set(agentId, { nextId: 1, seen: new Map(), lastTs: null })
      }
      return sub
    }
    // A subagent_meta frame links a sub-agent to its Task tool_use (so the Task
    // card upgrades into the SubagentCard in place) and labels it. A frame
    // without a tool_use id (a sub whose sidecar lacked one) has no card to fold
    // into, so it gets a standalone 'subagent' item instead.
    const markedStandalone = new Set<string>()
    // toolUseId -> real sub key, learned from meta frames, so a live line that
    // carries only parent_tool_use_id lands in the linked sub (not a placeholder).
    const toolUseToSub = new Map<string, string>()
    // Task tool_use ids whose tool_result was the async-launch boilerplate: their
    // sub-agents run in the background, past the launching turn, so a turn result
    // never settles them (only their <task-notification> does). Tracked as a set
    // because the boilerplate result can arrive before the sub is even created.
    const backgroundToolUses = new Set<string>()
    const markBackground = (sub: SubagentView, toolUseId: string) => {
      if (toolUseId && backgroundToolUses.has(toolUseId)) sub.background = true
    }
    // Task tool_use inputs by id: the label/description fallback for a sub-agent
    // whose meta frame hasn't arrived (the live placeholder route).
    const taskInputByUse = new Map<string, { type?: string; desc?: string }>()
    const handleSubagentMeta = (agentId: string, toolUseId: string, agentType: string, description: string) => {
      if (!agentId) return
      const sub = ensureSubagent(agentId)
      if (agentType) sub.agentType = agentType
      if (description) sub.description = description
      if (toolUseId) {
        sub.toolUseId = toolUseId
        markBackground(sub, toolUseId)
        toolUseToSub.set(toolUseId, agentId)
        // Absorb the placeholder accumulated from live parent_tool_use_id-only
        // lines, now that the meta names the real sub-agent.
        const phKey = 'tool:' + toolUseId
        const ph = subLocal[phKey]
        if (ph && phKey !== agentId) {
          if (!sub.prompt && ph.prompt) sub.prompt = ph.prompt
          if (ph.background) sub.background = true
          const meta = subMeta.get(agentId)!
          for (const it of ph.items) sub.items.push({ ...it, id: meta.nextId++ } as ChatItem)
          if (ph.status === 'done' && sub.status === 'running') sub.status = 'done'
          delete subLocal[phKey]
          subMeta.delete(phKey)
          // A viewer parked on the placeholder follows it to the real key.
          setChatView((cur) => (cur === phKey ? agentId : cur))
        }
      } else if (!markedStandalone.has(agentId)) {
        markedStandalone.add(agentId)
        push({ kind: 'subagent', agentId })
      }
      scheduleSubFlush()
    }
    const patchSubTool = (sub: SubagentView, toolUseId: string, result: string, isError: boolean, images: string[]) => {
      const resultImages = images.length > 0 ? images : undefined
      // Replace the item with a fresh object (not an in-place mutation): the
      // memoized ToolCard compares its `item` prop by reference, so mutating the
      // existing object would leave a finished step stuck showing "running" until
      // some other state forced a re-render (item: sub-agent step cards).
      for (let i = 0; i < sub.items.length; i++) {
        const it = sub.items[i]
        if (it.kind === 'tool' && it.toolUseId === toolUseId) {
          sub.items[i] = { ...it, result, isError, resultImages }
          return
        }
      }
    }
    // noticeSubDone drops a compact "finished" notice (with a View link to the
    // sub-agent's chat) into the main flow when a sub-agent completes LIVE -
    // replayed history stays quiet (the folded card already tells the story).
    const noticeSubDone = (key: string, sub: SubagentView) => {
      if (replaying) return
      const info = sub.toolUseId ? taskInputByUse.get(sub.toolUseId) : undefined
      const label = sub.agentType || info?.type || 'Sub-agent'
      const desc = sub.description || info?.desc || ''
      push({ kind: 'notice', text: `${label} finished${desc ? ': ' + desc : ''}`, subagentKey: key })
    }
    // settleSubagentByToolUse marks the sub-agent spawned by a Task tool_use as
    // done - the parent tool_result arriving is the authoritative live end
    // signal (current CLIs never put the sub's own result line on stdout). A
    // background/async agent's result is only the launch boilerplate, though, so
    // it settles nothing - that sub stays running until its sidechain result.
    const settleSubagentByToolUse = (toolUseId: string, result: string) => {
      if (isLaunchBoilerplate(result)) {
        // Not a completion - it just tells us this is a background/async sub.
        // Flag it (and any sub already linked, incl. a live placeholder) so the
        // turn's result won't settle it early; it ends via its task-notification.
        backgroundToolUses.add(toolUseId)
        for (const key in subLocal) {
          if (subLocal[key].toolUseId === toolUseId) subLocal[key].background = true
        }
        return
      }
      for (const key in subLocal) {
        const sub = subLocal[key]
        if (sub.toolUseId === toolUseId && sub.status === 'running') {
          sub.status = 'done'
          noticeSubDone(key, sub)
          scheduleSubFlush()
        }
      }
    }
    // Distinct task-notifications already surfaced this connection: the notice +
    // settle fire once even though the CLI writes each notification more than
    // once (a queue-operation and an attachment, both relayed live off the main
    // transcript) and a later real user turn may consume it again.
    const seenNotif = new Set<string>()
    // handleTaskNotification folds one <task-notification> record into the flow:
    // a compact notice, plus - for a background/async sub-agent whose completion
    // this is (its Task tool_result was only launch boilerplate, so nothing else
    // settles it) - marking the matching still-"working" card done by task-id /
    // tool-use-id. Reached both from a user turn that consumed the notification
    // and from the live main-transcript relay, so it dedups its own copies.
    const handleTaskNotification = (text: string, ts?: number | null) => {
      const taskId = /<task-id>([\s\S]*?)<\/task-id>/.exec(text)?.[1]?.trim()
      const noticeToolUse = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(text)?.[1]?.trim()
      const taskStatus = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim()
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
      const dedupKey = `${taskId ?? ''}\0${noticeToolUse ?? ''}\0${taskStatus ?? ''}\0${summary ?? ''}`
      if (seenNotif.has(dedupKey)) return
      seenNotif.add(dedupKey)
      const stillRunning = taskStatus != null && /^(running|in[_-]?progress|pending)$/i.test(taskStatus)
      if (!stillRunning && (taskId || noticeToolUse)) {
        for (const key in subLocal) {
          const sub = subLocal[key]
          const matches = (taskId && sub.agentId === taskId) || (noticeToolUse && sub.toolUseId === noticeToolUse)
          if (matches && sub.status === 'running') {
            sub.status = 'done'
            scheduleSubFlush()
          }
        }
      }
      // A genuine turn-starting continuation anchors the "working" clock (item 48).
      if (ts != null) turnStartClockRef.current = ts
      push({ kind: 'notice', text: decodeEntities(summary || 'Background task update') })
    }
    // routeSidechain folds one sub-agent stream event into its card. Mirrors the
    // main user/assistant handling, minus the specialisations that can't occur
    // inside a sub-agent (slash commands, TodoWrite plan panel, AskUserQuestion,
    // the queue) - those render as plain items or are ignored.
    const routeSidechain = (ev: ClaudeEvent) => {
      const parentTool = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : ''
      // Transcript lines name their sub-agent; a live stdout line carries only
      // the spawning Task tool_use - land it in the linked sub if the meta
      // frame already arrived, else in a placeholder merged later.
      const agentId = ev.agentId || (parentTool ? (toolUseToSub.get(parentTool) ?? 'tool:' + parentTool) : '_sub')
      const sub = ensureSubagent(agentId)
      if (parentTool && !sub.toolUseId) sub.toolUseId = parentTool
      if (parentTool) markBackground(sub, parentTool)
      const meta = subMeta.get(agentId)!
      // Snapshot the sub's previous event timestamp before advancing, so a
      // replayed thought can estimate its duration (item 7); mirrors the main
      // flow's prevEventTs.
      const evTs = parseEventTs(ev)
      const prevTs = meta.lastTs
      if (evTs != null) meta.lastTs = evTs
      if (ev.type === 'user') {
        const content = ev.message?.content
        const takePrompt = (t: string) => {
          if (!sub.prompt && t.trim()) sub.prompt = t
        }
        if (typeof content === 'string') takePrompt(content)
        else
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text) takePrompt(block.text)
            else if (block.type === 'tool_result' && block.tool_use_id) {
              const parsed = parseToolResult(block.content)
              patchSubTool(sub, block.tool_use_id, parsed.text, block.is_error === true, parsed.images)
            }
          }
      } else if (ev.type === 'assistant') {
        const content = ev.message?.content
        if (Array.isArray(content)) {
          const msgId = ev.message?.id ?? ''
          let seen = meta.seen.get(msgId)
          if (!seen) {
            seen = new Set()
            meta.seen.set(msgId, seen)
          }
          for (const block of content) {
            const key = `${block.type}:${block.id ?? ''}:${block.text ?? block.thinking ?? ''}`
            if (msgId && seen.has(key)) continue
            if (msgId) seen.add(key)
            if (block.type === 'text' && block.text?.trim()) {
              sub.items.push({ kind: 'assistant', id: meta.nextId++, text: block.text })
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              const dur = prevTs != null && evTs != null ? Math.max(0, evTs - prevTs) : undefined
              sub.items.push({ kind: 'thinking', id: meta.nextId++, text: block.thinking, durationMs: dur })
            } else if (block.type === 'tool_use' && block.id) {
              sub.items.push({ kind: 'tool', id: meta.nextId++, toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
            }
          }
        }
      } else if (ev.type === 'result') {
        if (sub.status === 'running') {
          sub.status = 'done'
          noticeSubDone(agentId, sub)
        }
      }
      scheduleSubFlush()
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

    // clearSending drops the "Sending..." indicator from optimistic user
    // messages the moment the agent starts responding (item 44) - the response
    // proves the message was received, so waiting for the CLI's echo (which can
    // lag behind the reply) would leave it stuck reading "Sending...".
    const clearSending = () => {
      setItems((prev) =>
        prev.some((it) => it.kind === 'user' && it.sending)
          ? prev.map((it) => (it.kind === 'user' && it.sending ? { ...it, sending: false } : it))
          : prev,
      )
    }

    // endPendingTools stops the "running" indicator on tool cards that never got
    // a result - a turn that ended (or history replayed) without one means the
    // tool isn't actually still running (item 42). Also clears the un-flushed
    // batch so replayed history doesn't briefly strobe "running".
    const endPendingTools = () => {
      for (const it of pending) if (it.kind === 'tool' && it.result === undefined) it.ended = true
      setItems((prev) =>
        prev.some((it) => it.kind === 'tool' && it.result === undefined && !it.ended)
          ? prev.map((it) => (it.kind === 'tool' && it.result === undefined && !it.ended ? { ...it, ended: true } : it))
          : prev,
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
        const older = reduceHistoryEvents(events, () => historyIdRef.current--, thoughtDurationsRef.current)
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

    // Whether the current turn was ended by a user interrupt (the CLI echoed
    // its bracketed marker). The turn's `result` arrives as an error
    // (subtype error_during_execution), but rendering a red "ended with an
    // error" box right under the "Interrupted by user" chip reads as a second
    // failure - so the result of an interrupted turn renders as a plain
    // footer instead. Reset on the next real user message, so a marker whose
    // result never arrived (e.g. lost to ring wrap) can't relabel a later,
    // genuinely-failed turn.
    let interruptPending = false

    // True once a `/model` command echo was just routed, so the very next
    // routed entry (its `<local-command-stdout>Set model to ...` sibling) knows
    // it belongs to a durable command record. A bare "Set model to ..." echo
    // with no preceding command is the CLI's transient stdout confirmation
    // (replayed from the scrollback ring on reconnect) - see the set_model
    // handling below.
    let pendingModelCmd = false

    // routeUserText classifies one user-turn text: slash-command echoes and
    // local command output arrive wrapped in pseudo-XML tags, interrupts as a
    // bracketed marker, everything else is a real user message.
    const routeUserText = (rawText: string, ts?: number | null) => {
      // Drop the CLI's local-command caveat wrapper; a message that is nothing
      // but the caveat is skipped entirely (item 31).
      const text = stripLocalCommandCaveat(rawText)
      if (!text) return
      // Consume the "a /model command just routed" flag: it only survives to the
      // immediately-following entry (the command's own stdout sibling).
      const afterModelCmd = pendingModelCmd
      pendingModelCmd = false
      // A user turn starting is the boundary that settles the previous turn's
      // synthesized footer (backfill only - live turns' pending footers are
      // discarded by their real result event before the next user turn).
      flushHistFooter()
      // Record this turn's true start time (item 48): a genuine turn-starting
      // message (a slash command, a prompt, a background-task continuation)
      // anchors the "working" indicator's elapsed clock. Skipped for the
      // non-turn-starting cases below (slash-command output, an interrupt).
      const markTurnStart = () => {
        if (ts != null) turnStartClockRef.current = ts
      }
      const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
      if (cmd) {
        const name = cmd[1].trim()
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
        markTurnStart()
        push({ kind: 'command', name, args })
        // The durable transcript records a /model change as this command echo
        // immediately followed by a "Set model to ..." stdout sibling; flag it
        // so that sibling renders (and the bare ring echo doesn't).
        pendingModelCmd = name === '/model'
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
            // Live echo of a change THIS client just made: swap our optimistic
            // confirmation for the CLI's (which carries the full model id).
            optimisticModelIdRef.current = null
            setItems((prev) => prev.filter((it) => it.id !== oid))
          } else if (!afterModelCmd) {
            // A bare "Set model to ..." echo with no preceding /model command:
            // the CLI's transient stdout confirmation, replayed from the
            // scrollback ring on reconnect. It carries no uuid, so the backend's
            // uuid dedup can't drop it, and pushing it here appends a DUPLICATE
            // at the bottom of the conversation - even though the durable
            // transcript copy (the one that DOES follow a /model command) already
            // rendered at its correct position. Sync the dropdown only, so the
            // confirmation no longer jumps to the bottom after navigating away
            // and back.
            return
          }
        }
        if (body) push({ kind: 'cmdout', text: body })
        return
      }
      if (text.startsWith('[Request interrupted by user')) {
        push({ kind: 'interrupted' })
        interruptPending = true
        endPendingTools()
        return
      }
      // A harness-injected background-task notification (<task-notification>)
      // consumed as a user turn: fold it into a notice (and settle a background
      // sub-agent) via the shared handler, which dedups against the live
      // main-transcript relay of the same notification (item 8/15).
      if (text.includes('<task-notification>')) {
        handleTaskNotification(text, ts)
        return
      }
      // The echo of a message we already showed optimistically (item 26): just
      // confirm that copy (clear its sending flag) instead of rendering a
      // duplicate. The echo can arrive after the turn's response, so relying on
      // it for placement would put the user message below its own reply.
      const oi = optimisticTextsRef.current.indexOf(text)
      if (oi >= 0) {
        markTurnStart()
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
      markTurnStart()
      // A queued bubble being echoed back: the settled item takes its place, so
      // it enters without the fade/slide (it was already visible as the pending
      // bubble - item 21).
      const fromQueue = pendingSendsRef.current.some((p) => p.text === text)
      settlePendingSend(text)
      interruptPending = false
      push({ kind: 'user', text, noEntrance: fromQueue })
    }

    const handleClaudeEvent = (ev: ClaudeEvent) => {
      // A background/async sub-agent's completion arrives NOT as a user turn but
      // as a <task-notification> bookkeeping record the chat socket relays live
      // off the main transcript: a queue-operation (XML on `content`) or an
      // attachment (XML on `attachment.prompt`). Settle off it up front, whatever
      // the event type, so a finished background sub-agent's card stops reading
      // "working" the moment it ends. A notification later consumed by a real
      // user turn routes through routeUserText instead, and dedups there.
      const notifText =
        (typeof ev.content === 'string' && ev.content.includes('<task-notification>') && ev.content) ||
        (typeof ev.attachment?.prompt === 'string' &&
          ev.attachment.prompt.includes('<task-notification>') &&
          ev.attachment.prompt) ||
        ''
      if (notifText) {
        handleTaskNotification(notifText, parseEventTs(ev))
        return
      }
      // A sub-agent's inner step: route it into that sub-agent's card, never the
      // main flow. This is the fix for sub-agent prompts showing as user
      // messages (they arrive as sidechain `user` events - live ones marked
      // only by parent_tool_use_id). Checked before the load-older anchor
      // below: sidechain uuids live in sub-agent transcripts, so anchoring
      // history paging on one would never resolve.
      if (ev.isSidechain || (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id)) {
        // A sub-agent's partial deltas aren't token-streamed into the main
        // bubble; its complete blocks arrive via the transcript tail.
        if (ev.type !== 'stream_event') routeSidechain(ev)
        return
      }
      // Snapshot the prior event's timestamp before advancing it - a replayed
      // thought reads it to estimate its duration (item 7).
      const evTs = parseEventTs(ev)
      const prevTs = prevEventTs
      if (evTs != null) prevEventTs = evTs
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
            if (typeof ev.apiKeySource === 'string') setApiKeyReal(ev.apiKeySource !== 'none')
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
          // The only other can_use_tool request is ExitPlanMode's plan gate
          // (--dangerously-skip-permissions auto-allows everything else): the
          // daemon auto-approves that one server-side, so the client ignores it
          // and just renders the proposed plan as a card (see PlanCard).
          return
        }
        case 'user': {
          const content = ev.message?.content
          const userTs = parseEventTs(ev)
          if (typeof content === 'string') {
            if (content.trim()) routeUserText(content, userTs)
            return
          }
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              routeUserText(block.text, userTs)
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              const parsed = parseToolResult(block.content)
              patchTool(block.tool_use_id, parsed.text, block.is_error === true, parsed.images)
              settleSubagentByToolUse(block.tool_use_id, parsed.text)
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
          clearSending()
          // Remember this turn's latest stop_reason so the result footer can flag
          // a truncated / refused reply (the last message before the result wins).
          if (typeof ev.message?.stop_reason === 'string') turnStopReasonRef.current = ev.message.stop_reason
          const msgId = ev.message?.id ?? ''
          let seen = seenBlocks.get(msgId)
          if (!seen) {
            seen = new Set()
            seenBlocks.set(msgId, seen)
          }
          for (let bi = 0; bi < content.length; bi++) {
            const block = content[bi]
            const key = `${block.type}:${block.id ?? ''}:${block.text ?? block.thinking ?? ''}`
            if (msgId && seen.has(key)) continue
            if (msgId) seen.add(key)
            if (block.type === 'text' && block.text?.trim()) {
              // noEntrance when this settles the block we've been streaming live:
              // the text is already on screen, so a fade-in on swap flickers
              // (item 56). streamedKinds (not streamBuf, which message_stop has
              // already nulled) remembers we streamed this text.
              push({ kind: 'assistant', text: block.text, noEntrance: streamedKinds.has('assistant') })
            } else if (block.type === 'thinking') {
              // Duration comes from the daemon (a hydra_thinking event keyed by
              // this message id, already in hand - sent before the backfill and
              // live at the block's end). A settled thought is shown when it has
              // visible text OR carries a measured duration: a duration means it
              // was a real (possibly silently-reasoned, empty) thought, so an
              // empty timed thought still reads "Thought for Xs" instead of
              // vanishing (item 11). Old history with no backend duration falls
              // back to the transcript-gap estimate (visible-text thoughts only,
              // so a contentless untimed block stays hidden).
              let dur = msgId ? thoughtDurationsRef.current.get(msgId) : undefined
              if (dur == null && block.thinking?.trim() && prevTs != null && evTs != null) {
                dur = Math.max(0, evTs - prevTs)
              }
              if (block.thinking?.trim() || dur != null) {
                push({ kind: 'thinking', msgId: msgId || undefined, text: block.thinking ?? '', durationMs: dur, noEntrance: streamedKinds.has('thinking') })
              }
            } else if (block.type === 'tool_use' && block.id) {
              // AskUserQuestion renders as an interactive question card, not a
              // tool card; its answer channel arrives with the paired
              // control_request (patchQuestionRequest). TodoWrite feeds the
              // floating plan panel instead of a card (item 17); the Task* family
              // feeds the panel too but still shows its card, so each individual
              // task-list mutation is visible in the flow.
              const specs = block.name === 'AskUserQuestion' ? parseQuestionSpecs(block.input) : null
              const todos = block.name === 'TodoWrite' ? parseTodos(block.input) : null
              if (specs) {
                push({ kind: 'question', toolUseId: block.id, input: block.input, specs })
              } else if (todos) {
                setTodos(todos)
              } else {
                applyTaskTool(block.name, block.input)
                if (block.name === 'Task') {
                  const inp = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>
                  taskInputByUse.set(block.id, {
                    type: typeof inp.subagent_type === 'string' ? inp.subagent_type : undefined,
                    desc: typeof inp.description === 'string' ? inp.description : undefined,
                  })
                }
                push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
              }
            }
          }
          // Roll this message's usage into the pending turn footer (see
          // flushHistFooter) - once per message id, since every content block
          // arrives as its own assistant event carrying the same envelope.
          const u = ev.message?.usage
          if (u?.output_tokens && (!msgId || !histUsageCounted.has(msgId))) {
            if (msgId) histUsageCounted.add(msgId)
            histTurnOut += u.output_tokens
            histLastUsage = u
          }
          const sr = ev.message?.stop_reason
          if (sr && sr !== 'tool_use') histStopReason = sr
          // The complete event supersedes any in-flight streamed block (finals
          // always follow their own deltas). Cleared in the same batch as the
          // push above, so the text swaps without a flash.
          clearStream()
          return
        }
        case 'hydra_thinking': {
          // The daemon measured a thinking block's duration and reports it here
          // keyed by message id (replayed from the sidecar on connect, then live
          // at the block's end). Stash it for the thinking item this reducer
          // builds; if that item already exists (the duration arrived after it),
          // patch it in place - both the not-yet-flushed pending batch and the
          // committed state.
          const mid = ev.message_id
          const ms = ev.duration_ms
          if (!mid || typeof ms !== 'number') return
          thoughtDurationsRef.current.set(mid, ms)
          for (const it of pending) {
            if (it.kind === 'thinking' && it.msgId === mid && it.durationMs == null) it.durationMs = ms
          }
          setItems((prev) => {
            let changed = false
            const next = prev.map((it) => {
              if (it.kind === 'thinking' && it.msgId === mid && it.durationMs == null) {
                changed = true
                return { ...it, durationMs: ms }
              }
              return it
            })
            return changed ? next : prev
          })
          return
        }
        case 'stream_event': {
          const e = ev.event
          if (!e) return
          if (e.type === 'content_block_start') {
            const bt = e.content_block?.type
            // The agent is producing output - the pending send has landed (item 44).
            clearSending()
            // tool_use input streaming (input_json_delta) is not rendered; the
            // tool card appears with the complete assistant event.
            streamBuf = bt === 'text' ? { kind: 'assistant', text: '' } : bt === 'thinking' ? { kind: 'thinking', text: '' } : null
            if (streamBuf) streamedKinds.add(streamBuf.kind)
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
          } else if (e.type === 'message_start') {
            // A new API message in this turn: reset which kinds this message
            // streamed (see streamedKinds), then seed the in-flight token count
            // (item 48).
            streamedKinds = new Set()
            curMsgTokensRef.current = e.message?.usage?.output_tokens ?? 0
            setTurnTokens(turnTokensRef.current + curMsgTokensRef.current)
          } else if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
            // Running (cumulative-for-this-message) output token count.
            curMsgTokensRef.current = e.usage.output_tokens
            setTurnTokens(turnTokensRef.current + curMsgTokensRef.current)
          } else if (e.type === 'message_stop') {
            // Roll the finished message's tokens into the turn total.
            turnTokensRef.current += curMsgTokensRef.current
            curMsgTokensRef.current = 0
            setTurnTokens(turnTokensRef.current)
            clearStream()
          }
          return
        }
        case 'result': {
          // Prefer the result's own usage; fall back to the output count we
          // tallied live from the stream deltas (item 47/48).
          const liveOut = (turnTokensRef.current + curMsgTokensRef.current) || undefined
          const usage: TokenUsage | undefined = ev.usage ?? (liveOut ? { output_tokens: liveOut } : undefined)
          // A user-interrupted turn "fails" by protocol (is_error, subtype
          // error_during_execution), but the interrupt chip already tells that
          // story - render its footer as a normal quiet one, not an error box.
          const wasInterrupt = interruptPending
          interruptPending = false
          push({
            kind: 'result',
            isError: !wasInterrupt && (ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success')),
            durationMs: ev.duration_ms,
            costUsd: ev.total_cost_usd,
            usage,
            stopReason: turnStopReasonRef.current ?? undefined,
            errorText: !wasInterrupt && ev.is_error ? ev.result : undefined,
          })
          // Consumed - clear it so it can't leak onto a later turn's result (the
          // live turn-start reset only fires between live turns, not between the
          // several results a backfill can carry). The real result also replaces
          // the turn's pending synthesized footer.
          turnStopReasonRef.current = null
          discardHistFooter()
          // A synchronous sub-agent finishes within the turn that launched it, so
          // a turn ending settles any still marked running (a sub whose own result
          // line we never saw). A BACKGROUND sub-agent, though, outlives its
          // launching turn - settling it here would wrongly flip it to "finished"
          // while it is still working; it ends only via its <task-notification>.
          let changed = false
          for (const k in subLocal) {
            if (subLocal[k].status === 'running' && !subLocal[k].background) {
              subLocal[k].status = 'done'
              changed = true
            }
          }
          if (changed) scheduleSubFlush()
          clearStream()
          endPendingTools()
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
    let retryTimer: number | null = null
    let openedAt: number | null = null
    ws.onopen = () => {
      openedAt = Date.now()
      setConnected(true)
    }
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      let msg: {
        type?: string
        status?: string
        head_moved?: boolean
        event?: ClaudeEvent
        messages?: { id?: string; content?: unknown }[]
        agentId?: string
        toolUseId?: string
        agentType?: string
        description?: string
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
        case 'subagent_meta':
          // Links a sub-agent to its Task tool_use (folding it into that card)
          // and labels it; arrives ahead of the sub's events live, and per-sub
          // during backfill. Tolerates arriving after events too.
          handleSubagentMeta(msg.agentId ?? '', msg.toolUseId ?? '', msg.agentType ?? '', msg.description ?? '')
          return
        case 'replay_done':
          // History that ends on a completed turn (no trailing user message to
          // settle it, and no result event in the replay to supersede it) gets
          // its synthesized footer here. Flushed before `replaying` clears so
          // it commits in the same single batch as the history.
          flushHistFooter()
          replaying = false
          // Any tool from the replayed history with no result isn't running
          // anymore (its turn is over) - don't leave it stuck "running" (item 42).
          endPendingTools()
          // Same for sub-agents (item 5): a sub still marked running after the
          // whole transcript replayed only stays genuinely live if the head is
          // mid-turn right now (a reconnect during an active turn). Otherwise -
          // e.g. after a server restart - the run is long over and never emitted
          // the settling result, so mark it done (and end its orphaned steps) so
          // it doesn't read "working" forever. A BACKGROUND sub is the exception:
          // it runs independently of any turn, and its completion notification is
          // now backfilled (so a finished one already settled above) - a still-
          // running one is genuinely live, so leave it be.
          if (!isTurnRunningRef.current) {
            for (const key in subLocal) {
              const sub = subLocal[key]
              if (sub.status !== 'running' || sub.background) continue
              sub.status = 'done'
              for (let i = 0; i < sub.items.length; i++) {
                const it = sub.items[i]
                if (it.kind === 'tool' && it.result === undefined && !it.ended) {
                  sub.items[i] = { ...it, ended: true }
                }
              }
            }
          }
          flush()
          flushSubagents()
          // Anchor the "working" indicator to the running turn's real start
          // (item 48): the backfill just replayed the triggering user message,
          // so turnStartClockRef now holds when the turn actually began. The
          // elapsed effect set turnStartRef to page-load time before the
          // backfill arrived; correct it (and elapsed) here, before the
          // indicator first renders (it's gated on replayDone).
          {
            const real = turnStartClockRef.current
            if (real != null && real <= Date.now()) {
              turnStartRef.current = real
              setElapsed(Math.floor((Date.now() - real) / 1000))
            }
          }
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
      // Schedule the reconnect. A drop after a healthy stretch retries almost
      // immediately; a streak of quick failures (the daemon is down, the head
      // can't resume) backs off exponentially to a slow poll. Unmount detaches
      // this handler (closeWebSocket), so a deliberate teardown never retries.
      const healthy = openedAt != null && Date.now() - openedAt >= RECONNECT_HEALTHY_MS
      retryStreakRef.current = healthy ? 0 : retryStreakRef.current + 1
      const delay =
        retryStreakRef.current === 0
          ? 500
          : Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** (retryStreakRef.current - 1))
      retryTimer = window.setTimeout(() => setAutoRetry((n) => n + 1), delay)
    }

    return () => {
      if (streamTimer != null) clearTimeout(streamTimer)
      if (retryTimer != null) clearTimeout(retryTimer)
      closeWebSocket(ws)
      wsRef.current = null
      setConnected(false)
    }
  }, [agentId, projectId, reconnectAttempt, autoRetry])

  // Tool cards by tool_use id: a sub-agent view reads its parent Task card for
  // labels, the live/done state and the final report.
  const taskToolByUse = useMemo(() => {
    const m: Record<string, ToolItem> = {}
    for (const it of items) if (it.kind === 'tool') m[it.toolUseId] = it
    return m
  }, [items])

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  // --- Sub-agent chat views --------------------------------------------------

  // Viewing another agent's chat is per-head ephemeral UI; a different head
  // starts back on its main conversation.
  useEffect(() => {
    setChatView('main')
    mainScrollRef.current = null
  }, [agentId, projectId])

  function openSubView(key: string) {
    if (chatView === 'main') mainScrollRef.current = { ...lastScrollRef.current }
    setChatView(key)
  }

  // Position the viewport when the view switches: a running sub-agent pins to
  // the bottom (follow it live), a finished one starts at the top (read the
  // run from the start), and returning to main restores the parked spot.
  const prevChatViewRef = useRef(chatView)
  useLayoutEffect(() => {
    if (prevChatViewRef.current === chatView) return
    prevChatViewRef.current = chatView
    const el = scrollRef.current
    if (!el) return
    if (chatView === 'main') {
      const saved = mainScrollRef.current
      const pin = saved?.pinned ?? true
      pinnedRef.current = pin
      setPinned(pin)
      el.scrollTop = pin ? el.scrollHeight : (saved?.top ?? 0)
    } else {
      const sub = subagents[chatView]
      const tool = sub?.toolUseId ? taskToolByUse[sub.toolUseId] : undefined
      const running = sub ? isSubRunning(sub, tool) : false
      pinnedRef.current = running
      setPinned(running)
      el.scrollTop = running ? el.scrollHeight : 0
    }
  }, [chatView, subagents, taskToolByUse])

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

  // Live turn timer for the "working" indicator (item 48): start the clock (and
  // reset the per-turn token count + pick a fresh verb) when a turn begins, tick
  // the elapsed seconds while it runs, and stop when it ends.
  useEffect(() => {
    if (!isTurnRunning) {
      turnStartRef.current = null
      turnStartClockRef.current = null
      setElapsed(0)
      return
    }
    if (turnStartRef.current == null) {
      // Prefer the turn's real start (from a replayed user message's timestamp)
      // over "now" so a reconnect mid-turn shows the true elapsed. A live turn
      // we saw begin has no such timestamp yet and falls back to now; a later
      // replay_done still corrects it. clamp: never a future time (clock skew).
      const real = turnStartClockRef.current
      turnStartRef.current = real != null && real <= Date.now() ? real : Date.now()
      turnTokensRef.current = 0
      curMsgTokensRef.current = 0
      turnStopReasonRef.current = null
      setTurnTokens(0)
      setTurnVerb(WORKING_VERBS[turnCountRef.current++ % WORKING_VERBS.length])
    }
    const tick = () => setElapsed(Math.floor((Date.now() - (turnStartRef.current ?? Date.now())) / 1000))
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [isTurnRunning])

  // Auto-scroll to the bottom on new content while pinned. `subagents` is a
  // dep so a sub-agent view follows its own live growth too.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items, stream, replayDone, pendingSends, subagents])

  // Follow the bottom continuously while pinned as the content height changes
  // between renders - notably during a card's 0.22s expand/collapse animation,
  // which grows the height frame-by-frame. Without this the disclosure glides
  // open and then the view snaps to the bottom in one jump once React next
  // re-renders (item 55). A no-op when the user has scrolled up (not pinned),
  // so load-older prepends and the restored offset are left alone.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

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
    // Load-older pages main history; a sub-agent view has its whole run already.
    if (el.scrollTop < 300 && chatView === 'main') requestOlderHistory()
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    pinnedRef.current = nearBottom
    setPinned(nearBottom)
    // A hidden pane has no geometry; don't let a stray 0-measurement clobber
    // the remembered offset. A sub-agent view's offsets aren't remembered at
    // all - the saved spot belongs to the main conversation.
    if (!active || el.clientHeight === 0 || chatView !== 'main') return
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

  // numberGenericImage renames pasted / unnamed images to image1.png,
  // image2.png, ... (per project+agent, persisted) so each gets a stable, unique
  // on-disk name - like the spawn box (item 46). Named files keep their name.
  function numberGenericImage(file: File): File {
    if (!isImageFile(file)) return file
    const stem = file.name.replace(/\.[^.]*$/, '')
    if (stem !== '' && stem.toLowerCase() !== 'image') return file
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] || file.type.split('/')[1] || 'png').toLowerCase()
    const key = chatImageCounterKey(projectId, agentId)
    const n = (Number(readLocal(key)) || 0) + 1
    writeLocal(key, String(n))
    return new File([file], `image${n}.${ext}`, { type: file.type, lastModified: file.lastModified })
  }

  function addFiles(rawFiles: File[]) {
    for (const raw of rawFiles) {
      const file = numberGenericImage(raw)
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
    // The textarea fills its wrapper (position: absolute, inset-0), so collapsing
    // to 'auto' would just stretch it to the parent. Pin it to 0 instead: the box
    // is empty but the content overflows, so scrollHeight reports the true content
    // height. Restore to '' afterwards to hand sizing back to the wrapper.
    ta.style.height = '0px'
    const contentRows = Math.max(1, Math.round((ta.scrollHeight - pad) / lineHeight))
    ta.style.height = ''
    const rows = Math.min(MAX_ROWS, Math.max(minRows, contentRows))
    ta.style.overflowY = contentRows > rows ? 'auto' : 'hidden'
    setComposerHeight(rows * lineHeight + pad)
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

  // discardQueued drops a still-queued message (the X on its bubble, item 52):
  // tell the daemon to remove it from the server queue and clear the local
  // bubble. A message already handed to the CLI is gone from the queue, so the
  // daemon simply reports not-found and the bubble was already off pendingSends.
  function discardQueued(p: PendingSend) {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'dequeue', id: p.clientId }))
    }
    setPendingSends((prev) => prev.filter((x) => x.id !== p.id))
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
    // A staged attachment counts as a non-empty composer too, so recalling never
    // clobbers files the user is mid-way through attaching.
    if (e.key === 'ArrowUp' && input === '' && attachments.length === 0 && slashMatches.length === 0) {
      const last = [...pendingSends].reverse().find((p) => p.queued)
      if (last) {
        e.preventDefault()
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'dequeue', id: last.clientId }))
        }
        setPendingSends((prev) => prev.filter((p) => p.id !== last.id))
        // Split the recalled message back into its typed text and the uploads it
        // referenced, so image attachments return to the composer as chips - not
        // raw upload paths pasted into the textarea (the send flow re-appends
        // them). Fresh ids keep them unique against later attachments.
        const { text: body, attachments: recalled } = parseUploadAttachments(last.text, projectId)
        setInput(body)
        setAttachments(recalled.map((a) => ({ ...a, id: nextAttachmentId() })))
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
        return <ChatUserMessage text={item.text} sending={item.sending} projectId={projectId} />
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
      case 'notice': {
        // A "sub-agent finished" notice: when it links to a sub-agent we have,
        // re-surface it at completion time (so the user needn't scroll up to the
        // launch card) using the same SubagentCard as the launch, with a
        // "finished" badge (#62, item 4). Other notices (background-task
        // completions etc.) stay as a compact pill.
        const sub = item.subagentKey ? subagents[item.subagentKey] : undefined
        if (sub) {
          const tool = sub.toolUseId ? taskToolByUse[sub.toolUseId] : undefined
          return (
            <SubagentCard
              sub={sub}
              tool={tool}
              worktree={worktreePath}
              serif={serif}
              onOpenChat={() => openSubView(sub.agentId)}
              finishedBadge
            />
          )
        }
        return (
          <div className="flex justify-center">
            <div className="flex max-w-[90%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 select-none" title={item.text}>
              <span className="truncate">{item.text}</span>
            </div>
          </div>
        )
      }
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
      case 'tool': {
        // A Task tool card whose sub-agent we've linked upgrades into the
        // richer SubagentCard (its inner timeline + report) in place.
        const sub = subByToolUse[item.toolUseId]
        if (sub)
          return (
            <SubagentCard sub={sub} tool={item} worktree={worktreePath} serif={serif} onOpenChat={() => openSubView(sub.agentId)} />
          )
        // ExitPlanMode gets a dedicated card that renders the plan markdown.
        if (item.name === 'ExitPlanMode') return <PlanCard item={item} />
        // A TaskOutput retrieval whose result has landed: render the reported
        // output as a finished card (linking to the sub-agent's steps when the
        // task_id matches one we're tracking) rather than the raw XML envelope.
        if (item.name === 'TaskOutput') {
          const parsed = parseTaskOutput(item.result)
          if (parsed) {
            const linked = parsed.taskId ? subagents[parsed.taskId] : undefined
            const linkedTool = linked?.toolUseId ? taskToolByUse[linked.toolUseId] : undefined
            const label = linked ? subLabels(linked, linkedTool).label : 'Agent'
            const desc = linked ? subLabels(linked, linkedTool).desc : undefined
            return (
              <FinishedReportCard
                label={label}
                desc={desc}
                report={{ text: parsed.output!, isError: parsed.status !== undefined && parsed.status !== 'completed' }}
                serif={serif}
                onOpenChat={linked ? () => openSubView(linked.agentId) : undefined}
              />
            )
          }
        }
        return <ToolCard item={item} worktree={worktreePath} />
      }
      case 'subagent': {
        // A sub-agent with no parent Task card (its meta lacked a tool_use id).
        const sub = subagents[item.agentId]
        if (!sub) return null
        return <SubagentCard sub={sub} worktree={worktreePath} serif={serif} onOpenChat={() => openSubView(sub.agentId)} />
      }
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
        // A quiet end-of-turn summary (item 47): "* Crunched for <duration>",
        // Claude-Code style, optionally with cost (API-key auth only) and the
        // output-token count (hover for the full input/cache/output breakdown).
        // A truncation/refusal stop_reason is flagged in amber. Historical turns
        // carry no timing, so they show just the metrics. Nothing when empty.
        {
          const out = item.usage?.output_tokens
          const cost = apiKeyReal && item.costUsd ? formatCost(item.costUsd) : null
          const stopNote = item.stopReason ? STOP_REASON_LABEL[item.stopReason] : undefined
          // The "↓ N tokens" count is only useful for the current (latest) turn -
          // a wall of per-turn counts up the scrollback is just noise (#60). Show
          // it on the last turn's footer only; earlier footers keep just their
          // duration/cost, dropping to nothing for historical (timing-less) turns.
          const isLast = visibleItems[visibleItems.length - 1]?.id === item.id
          const showTokens = !!out && isLast
          if (item.durationMs == null && !showTokens && !cost && !stopNote) return null
          const segs: ReactNode[] = []
          if (item.durationMs != null) segs.push(`Crunched for ${formatDuration(item.durationMs)}`)
          if (cost) segs.push(cost)
          if (showTokens) segs.push(
            <span key="tok" title={item.usage ? usageBreakdown(item.usage) : undefined}>
              ↓ {formatTokens(out)} tokens
            </span>,
          )
          if (stopNote) segs.push(
            <span key="stop" className="text-amber-600 dark:text-amber-500">{stopNote}</span>,
          )
          return (
            <div className="flex items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500 select-none">
              <span className="text-[#c96442]">✳</span>
              {segs.map((s, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-stone-300 dark:text-stone-600">·</span>}
                  {s}
                </span>
              ))}
            </div>
          )
        }
      default: {
        // Exhaustiveness guard: with every kind above handled, `item` narrows to
        // `never` here, so a newly-added ChatItem kind that isn't given a case
        // fails to compile. A kind that only shows up at runtime (something off
        // the wire we don't model) still surfaces a visible notice rather than
        // silently rendering nothing.
        const exhaustive: never = item
        return (
          <div className="flex justify-center">
            <div className="rounded-full border border-amber-300/70 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/30 px-2.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400 select-none">
              Unknown event kind: {(exhaustive as { kind?: string }).kind ?? 'unknown'}
            </div>
          </div>
        )
      }
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

  // toolUseId -> sub-agent, so a Task tool card upgrades into a SubagentCard in
  // place (correct position, live and on backfill) without any marker item.
  const subByToolUse = useMemo(() => {
    const m: Record<string, SubagentView> = {}
    for (const s of Object.values(subagents)) if (s.toolUseId) m[s.toolUseId] = s
    return m
  }, [subagents])

  // The sub-agent whose chat the pane currently shows (undefined = main view,
  // also the fallback while a selected key is missing mid-replay).
  const viewSub = chatView !== 'main' ? subagents[chatView] : undefined
  const viewSubTool = viewSub?.toolUseId ? taskToolByUse[viewSub.toolUseId] : undefined
  const hasSubagents = Object.keys(subagents).length > 0

  // A stable wrapper around renderChatItem (a per-render closure) so it never
  // trips SettledMessages' memo. It always calls the latest closure via a ref, so
  // it never renders stale data; the inputs that actually change a row's output
  // are passed to SettledMessages explicitly (and listed in its comparator).
  const renderItemRef = useRef(renderChatItem)
  renderItemRef.current = renderChatItem
  const renderItem = useCallback((item: ChatItem) => renderItemRef.current(item), [])

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
        {/* The current-agents selector (main + sub-agents), floated top-left
            once any sub-agent exists. */}
        {hasSubagents && (
          <ChatViewSelector
            chatView={viewSub ? chatView : 'main'}
            subagents={subagents}
            taskToolByUse={taskToolByUse}
            onSelect={(key) => (key === 'main' ? setChatView('main') : openSubView(key))}
          />
        )}
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div ref={contentRef} className="mx-auto max-w-5xl px-4 py-3 flex flex-col gap-3">
          {viewSub ? (
            <SubagentChatView sub={viewSub} tool={viewSubTool} worktree={worktreePath} serif={serif} />
          ) : (
          <>
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
          <SettledMessages
            items={visibleItems}
            liveFromId={liveFromId}
            renderItem={renderItem}
            serif={serif}
            connected={connected}
            worktreePath={worktreePath}
            subByToolUse={subByToolUse}
            subagents={subagents}
          />
          {/* The in-flight streamed block: markdown-rendered live (with a
              virtual closing fence while inside a code block); streamed thinking
              uses the same collapsed card as settled thoughts, its preview
              auto-updating as tokens arrive. It's the current turn's response,
              so it sits ABOVE any queued (held-for-later) messages (item 33).
              The "working" indicator below already signals the turn is live, so
              no blinking caret is appended here - it reflowed as text wrapped
              and read as visual jitter (item 56). */}
          {stream && stream.kind === 'assistant' && (
            <div className={`chat-stream-tail max-w-[95%] ${serif ? 'chat-serif' : 'leading-relaxed'}`}>
              <Markdown text={closeOpenFence(stream.text)} />
            </div>
          )}
          {stream && stream.kind === 'thinking' && <ThinkingCard text={stream.text} streaming />}
          {/* Live "working" indicator (item 48): a playful verb + elapsed time,
              and the running output-token count when the CLI reports it. */}
          {isTurnRunning && replayDone && (
            <div className="flex items-center gap-1.5 text-[11px] select-none animate-chat-item-in">
              <span className="text-[#c96442]">✳</span>
              <span className="chat-text-shimmer font-medium">{turnVerb}...</span>
              <span className="text-stone-400 dark:text-stone-500">
                ({formatDuration(elapsed * 1000)}
                {turnTokens > 0 ? ` · ↓ ${formatTokens(turnTokens)} tokens` : ''})
              </span>
            </div>
          )}
          {/* Queued messages: held for later, so pinned at the very bottom under
              the in-flight reply. (A "sending" message is an optimistic item in
              the flow above; only queued holds land here now.) A stack of queued
              bubbles reads as one group, so they sit tighter (gap-1) than the
              gap-3 between distinct turns (item 51). */}
          {pendingSends.length > 0 && (
            <div className="flex flex-col gap-1">
              {pendingSends.map((p) => (
                <div key={`pending-${p.id}`} className="group relative flex justify-end animate-chat-item-in">
                  {/* Flush right, exactly where the message will land once it
                      is sent (a real user bubble) - and rendered the same way, so
                      image thumbnails / attachment chips show here too, not raw
                      upload paths (dimmed while it waits). */}
                  <ChatUserMessage text={p.text} dimmed projectId={projectId} />
                  {/* Discard button (item 52): drops the queued message from the
                      server queue. A floating chip overhanging the bubble's
                      top-right corner (revealed on hover so the resting stack
                      stays clean); the 8px overhang stays inside the column's
                      px-4 padding, so it never leaves the chat view. */}
                  <Tooltip content="Discard queued message" side="top">
                    <button
                      onClick={() => discardQueued(p)}
                      aria-label="Discard queued message"
                      className="absolute -top-2 -right-2 z-10 rounded-full border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-sm p-1 text-stone-400 dark:text-stone-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-[#3a3937] transition cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
          </>
          )}
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
            top-right; collapses to a chip when the pane is narrow. Main view
            only - it is the main agent's plan. */}
        {todos.length > 0 && replayDone && !viewSub && <PlanPanel todos={todos} narrow={paneWidth > 0 && paneWidth < 560} />}
      </div>

      {/* A sub-agent's chat can only be read, not talked to: swap the composer
          for a quiet bar with the way back. */}
      {viewSub ? (
        <div className="shrink-0 px-3 pb-3 pt-2">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 rounded-2xl border border-stone-300/70 dark:border-white/[0.09] bg-white dark:bg-[#30302e] px-3.5 py-2.5 text-xs text-stone-400 dark:text-stone-500 shadow-sm">
            <span className="select-none">Sub-agent conversation - read-only</span>
            <button
              onClick={() => setChatView('main')}
              className="shrink-0 rounded-lg px-2 py-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              Back to main conversation
            </button>
          </div>
        </div>
      ) : (
      <>
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
            <HighlightedTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setSlashDismissed(false)
              }}
              onKeyDown={onComposerKeyDown}
              onPaste={handlePaste}
              placeholder={connected ? 'Write a message...' : 'Connecting...'}
              disabled={!connected}
              rows={1}
              wrapperClassName="w-full"
              wrapperStyle={{ height: composerHeight }}
              textColorClassName="text-stone-800 dark:text-stone-100"
              caretClassName="caret-stone-800 dark:caret-stone-100"
              textClassName="px-3.5 pt-2.5 pb-1 text-[13px] leading-5 placeholder-stone-400 dark:placeholder-stone-500 disabled:opacity-50"
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
                    obvious thing - i.e. the message will queue, draining into
                    the running turn at its next step (terminal-style
                    steering); otherwise show nothing. */}
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
      </>
      )}

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
