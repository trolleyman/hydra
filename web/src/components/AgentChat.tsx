import { Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentType, type ReactNode } from 'react'
import {
  Archive,
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
  GitCommitHorizontal,
  GitMerge,
  Globe,
  History,
  Info,
  ListChecks,
  ListEnd,
  ListPlus,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  SquareDot,
  SquareMinus,
  SquarePlus,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import { SiGit } from '@icons-pack/react-simple-icons'
import { AgentStatus } from '../api'
import { api } from '../stores/apiClient'
import { useAgentStore } from '../stores/agentStore'
import { Markdown } from '../lib/MarkdownRenderer'
import { stripAnsi, hasAnsi, ansiToHtml } from '../lib/ansi'
import { dropNoopCd, formatBashForDisplay, parseHostRunScript, unwrapBashLoginCommand } from '../lib/bashFormat'
import { fileViewLineInfo, parseFileViewScript, splitFileViewOutput, type FileViewSection } from '../lib/fileViewCommand'
import { parseMatchLines, parseScriptSteps, splitScriptOutput, type MatchLine, type ScriptSection } from '../lib/shellSections'
import { trackShellCwds, type ShellStep } from '../lib/shellCwd'
import { formatBytes } from '../lib/formatBytes'
import { highlightHtml, highlightLines } from '../lib/highlightCore'
import { closeWebSocket } from '../lib/ws'
import { getWsUrl } from '../lib/terminalWs'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { densityFromPath, logicalSize } from '../lib/imageDensity'
import { pasteMarkerText } from '../lib/pastedText'
import { usePasteMarkersStore } from '../lib/composerPrefs'
import { ResizeGrip } from './ResizeGrip'
import { formatError } from '../api/format_error'
import { AttachmentChips } from './AttachmentChips'
import { HighlightedTextarea } from './HighlightedTextarea'
import { enterEdit, ensureCaretVisible } from '../lib/textareaEdit'
import { renderMarkdownSource } from '../lib/markdown'
import { randomId } from '../lib/uuid'
import { Lightbox } from './Lightbox'
import { ToolApproval } from './ToolApproval'
import { UrlText } from './HostName'
import { Tooltip } from './Tooltip'
import { WorkSpark } from './WorkSpark'
import { ChatAgentTypeContext } from '../lib/chatAgentType'
import { type Attachment, nextAttachmentId, isGenericImageName, nextGenericImageNumber } from '../lib/spawnDrafts'
import { attachmentLightboxItems, openableAttachments } from '../lib/attachmentLightbox'
// langFromPath (the extension -> Prism language map a Read tool's output is
// highlighted by, item 3) now lives in lib/fileKind, beside the file-type
// classifier, so the lightbox's text viewer highlights by the same table.
import { langFromPath } from '../lib/fileKind'
import { useComposerHistory, makeSnapshot } from '../lib/composerHistory'
import { chatDraftKey, loadChatAttachments, saveChatAttachments } from '../lib/chatDrafts'
import { loadPlan, parseServerPlan, savePlan, seedLocalPlan } from '../lib/planStore'
import { createPlanBuilder, parseTodos, toTodoItems, type TodoItem } from '../lib/planReducer'
import { parseUploadAttachments, isImageResizeNotice } from '../lib/uploadAttachments'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { useChatBashIndentStore, useChatCodeLinesStore, useChatStepsStore, useChatStreamStore } from '../lib/chatPrefs'
import { useChatIsSerif } from '../lib/fontPrefs'
import { providerErrorText } from '../lib/providerError'
import { ChatApprovalContext, usePendingToolApproval } from '../lib/toolApproval'
import { approvalMatchesTool } from '../lib/approvalMatch'
import { useApprovalStore } from '../stores/approvalStore'
import { selectionToMarkdown } from '../lib/copyMarkdown'
import { claimOrphanResult, newToolResultLink, stashOrphanResult } from '../lib/toolResultLink'
import type { ToolResultLink } from '../lib/toolResultLink'
import { buildEditRows, hasLineNumbers, parseEditPatch, type EditHunk } from '../lib/editDiff'
import { renderWordDiffHtml, WORD_ADD_CLASS, WORD_DEL_CLASS } from '../lib/wordDiff'

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
  agentType?: string
  projectId: string | null
  active: boolean
  reconnectAttempt: number
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: (headMoved: boolean) => void
  // Clicking a commit chip: point the diff viewer at just that commit (and
  // reveal the diff pane). Absent -> chips render non-clickable.
  onSelectCommit?: (sha: string) => void
}

interface NormalizedChatEvent {
  seq: number
  source_id?: string
  type: string
  timestamp: string
  payload?: Record<string, unknown>
}

interface ChatProjectionSnapshot {
  plan?: unknown
  slash_commands?: string[]
  turn?: { id?: string; status?: string }
  // The block being produced right now, accumulated from the deltas that landed
  // before this client attached (see seedStream).
  stream?: { kind?: string; message_id?: string; text?: string }
  subagents?: Record<string, { id?: string; parent_id?: string; parent_item_id?: string; agent_type?: string; description?: string; prompt?: string; status?: string; activity?: string }>
}

// Omit that distributes over a union (plain Omit collapses ChatItem to its
// common properties, losing each variant's own fields).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// One commit dragged in by a merge, shown in the merge chip's expanded list.
interface MergedCommit { sha: string; shortSha: string; subject: string }

// mergeFieldsFromPayload pulls the merge annotation off a commit_created payload
// (see chat.annotateMerge). Absent on ordinary commits and on merges recorded
// before the annotation existed - both render as a plain commit chip.
function mergeFieldsFromPayload(payload: Record<string, unknown>): Pick<CommitChipItem, 'isMerge' | 'mergedCount' | 'merged'> {
  if (payload.is_merge !== true) return {}
  const raw = Array.isArray(payload.merged_commits) ? payload.merged_commits : []
  const merged: MergedCommit[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const m = entry as Record<string, unknown>
    const sha = typeof m.sha === 'string' ? m.sha : ''
    if (!sha) continue
    merged.push({
      sha,
      shortSha: typeof m.short_sha === 'string' ? m.short_sha : sha.slice(0, 7),
      subject: typeof m.subject === 'string' ? m.subject : '',
    })
  }
  const mergedCount = typeof payload.merged_count === 'number' ? payload.merged_count : merged.length
  return { isMerge: true, mergedCount, merged }
}

// mergeChipLabel renders "Merged <ref> - N commits", extracting the merged ref
// name from a standard git merge subject and falling back to the raw subject.
function mergeChipLabel(subject: string, count: number): string {
  const m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)
  const n = `${count} commit${count === 1 ? '' : 's'}`
  return m ? `Merged ${m[1]} - ${n}` : `${subject} - ${n}`
}

// Shared styling for commit/merge pills - the same centered notification look as
// notice/cmdout chips.
const COMMIT_PILL = 'flex items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 select-none'
const COMMIT_HOVER = 'cursor-pointer hover:bg-stone-200/70 dark:hover:bg-white/[0.08] hover:text-stone-700 dark:hover:text-stone-200 transition-colors'

// MergeCommitChip renders a merge as a single pill that expands to list the commits
// it dragged in. Its own useState survives row re-renders (the row is memo'd on the
// stable chip item), so expansion needs no plumbing through the transcript.
function MergeCommitChip({ item, onSelectCommit }: { item: CommitChipItem; onSelectCommit?: (sha: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const clickable = !!onSelectCommit
  const count = item.mergedCount ?? item.merged?.length ?? 0
  const label = mergeChipLabel(item.subject, count)
  const shown = item.merged?.length ?? 0
  return (
    <div className="flex max-w-full flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`${COMMIT_PILL} ${COMMIT_HOVER} max-w-full`}
        title={expanded ? 'Hide merged commits' : 'Show merged commits'}
      >
        {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <GitMerge className="w-3 h-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <Expandable open={expanded && shown > 0} className="w-full">
        <div className="flex w-full flex-col gap-0.5 rounded-md border border-stone-200 dark:border-white/[0.08] bg-stone-50/60 dark:bg-white/[0.02] px-2 py-1.5">
          {item.merged!.map((m) => (
            <div
              key={m.sha}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onSelectCommit?.(m.sha) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectCommit?.(m.sha) } } : undefined}
              className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 ${clickable ? COMMIT_HOVER : ''}`}
              title={clickable ? `Show ${m.shortSha} in the diff view` : m.shortSha}
            >
              <GitCommitHorizontal className="w-3 h-3 shrink-0" />
              <span className="font-mono shrink-0">{m.shortSha}</span>
              <span className="truncate">{m.subject}</span>
            </div>
          ))}
          {shown < count && (
            <div className="px-1 py-0.5 text-[11px] italic text-stone-400 dark:text-stone-500">
              ... and {count - shown} more
            </div>
          )}
        </div>
      </Expandable>
    </div>
  )
}

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
  // A "!command" the user ran from the composer: run in the head's sandbox, its
  // output shown as a card AND delivered to the agent as a user turn. clientId is
  // the send frame's id, used to settle the optimistic running card in place when
  // the daemon's result event arrives. running is the optimistic in-flight state.
  | { kind: 'shellCmd'; id: number; clientId?: string; command: string; output: string; exitCode?: number; truncated?: boolean; timedOut?: boolean; stopped?: boolean; running?: boolean; noEntrance?: boolean }
  // A harness-injected system notice (e.g. a <task-notification> when a
  // background task finishes), rendered as a compact muted line, not raw XML.
  // subagentKey links a "sub-agent finished" notice to its sub-agent view, so
  // the pill can offer a View button. taskId/toolUseId (from the notification's
  // own tags) let the pill resolve its background sub-agent at render time, and
  // outputFile (the <output-file> tag) makes a background command's pill
  // expandable to show the command's output.
  | { kind: 'notice'; id: number; text: string; subagentKey?: string; taskId?: string; toolUseId?: string; outputFile?: string; noEntrance?: boolean }
  // The CLI-injected "session continued" preamble after a context compaction
  // (auto/out-of-context or /compact): a bookkeeping summary, not a real user
  // turn, so it collapses behind an expander (item 39). outOfContext labels the
  // auto/ran-out-of-context case specifically.
  | { kind: 'contextNote'; id: number; text: string; outOfContext: boolean }
  // Machine-injected context (isMeta) that rode in a `user` envelope but was
  // never typed - rendered out of the chat flow rather than as a user bubble.
  // `skill` is a Skill's auto-loaded SKILL.md body (name = the skill); `meta` is
  // the generic fallback for any other injected-context message. Keying both off
  // the isMeta flag avoids a per-string matcher for each new injection kind.
  | { kind: 'skill'; id: number; name: string; text: string }
  | { kind: 'meta'; id: number; text: string }
  | { kind: 'interrupted'; id: number }
  // noEntrance suppresses the fade/slide entrance when this settled block simply
  // replaces the in-flight streamed copy already on screen - it was visible, so
  // re-animating it as it settles reads as a flicker (item 56), same rationale
  // as the queued-user-bubble case above.
  // uuid is the conversation-record id of the assistant block this item was built
  // from, stamped so a model_refusal_fallback retraction can evict it (see
  // ProviderEvent.retractedMessageUuids). Only set on live assistant-produced items.
  | { kind: 'assistant'; id: number; text: string; noEntrance?: boolean; uuid?: string }
  // durationMs is the thinking time the daemon measured for this block (delivered
  // as a hydra_thinking event keyed by msgId); absent for old history recorded
  // before backend timing, which falls back to a transcript-gap estimate or a
  // plain "Thought". msgId lets a late-arriving duration patch this item.
  | { kind: 'thinking'; id: number; text: string; durationMs?: number; msgId?: string; noEntrance?: boolean; uuid?: string }
  // ended: the turn finished (or history was replayed) without a result for this
  // tool, so stop showing it as "running" (item 42).
  // rawUse/rawResult are the provider's own blocks, kept so the Raw panel can
  // print what was actually sent rather than a reconstruction of it (see
  // toolRawJson). They cost one wrapper object per card: the heavy part of a
  // result is its text, and that string is shared with `result`, not copied.
  // Both arrive with the RESULT rather than the call: editPatch is an Edit's
  // unified patch (the call itself only knows the two strings - see lib/editDiff),
  // cwdAfter the directory the shell was left in (see lib/shellCwd).
  | { kind: 'tool'; id: number; toolUseId: string; name: string; input: unknown; result?: string; runningOutput?: string; resultImages?: string[]; isError?: boolean; ended?: boolean; uuid?: string; rawUse?: unknown; rawResult?: unknown; editPatch?: EditHunk[]; cwdAfter?: string }
  // A native AskUserQuestion tool call. requestId arrives with the paired
  // can_use_tool control_request (the channel the answer goes back on);
  // result is the tool_result once answered. expired: the turn that raised the
  // question ended without an answer, so that channel is gone (see
  // expireQuestions) - the card stays but answers it as a plain message.
  | { kind: 'question'; id: number; toolUseId: string; input: unknown; specs: QuestionSpec[]; requestId?: string; result?: string; expired?: boolean; uuid?: string }
  | { kind: 'result'; id: number; isError: boolean; durationMs?: number; costUsd?: number; usage?: TokenUsage; stopReason?: string; errorText?: string }
  // A sub-agent (Task tool) whose meta carried no parent tool_use id, so it has
  // no Task card to fold into and renders as a standalone card in the flow. The
  // common case - a sub-agent linked to its Task card - needs no item: the Task
  // ToolCard upgrades into a SubagentCard in place (see renderChatItem).
  | { kind: 'subagent'; id: number; agentId: string }
  // A commit the agent made on its branch, shown as a clickable notification
  // chip. Not a chat event: git is the durable record, so chips derive from the
  // commits endpoint and are interleaved into the transcript by `ts` (the
  // commit's author date, epoch ms) against the items' stamped times (see
  // mergedItems). Clicking one points the diff viewer at just that commit.
  // A merge chip (isMerge) collapses the commits it brought in: mergedCount is the
  // true total, merged is a capped preview list the chip expands to show.
  | { kind: 'commit'; id: number; sha: string; shortSha: string; subject: string; ts: number; noEntrance?: boolean; isMerge?: boolean; mergedCount?: number; merged?: MergedCommit[] }

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
  // The sub-agent that spawned this one (from its meta frame) - set only for a
  // NESTED sub-agent (a sub-agent's own Task/Agent spawn). Its card renders
  // inside the parent's step timeline, not the main flow, and a parent whose
  // own run has settled still reads "waiting on sub-agents" while any
  // descendant runs (see subsAwaitingChildren).
  parentAgentId?: string
  prompt?: string
  // 'running' until a sidechain result (or the turn's result) settles it; for a
  // Task-linked sub the parent tool_result is the more precise done signal.
  status: 'running' | 'done'
  // A background/async sub-agent (its Task tool_result was only the launch
  // boilerplate). It runs on past the turn that launched it, so the turn's
  // result must NOT settle it - only its own <task-notification> completion does.
  background?: boolean
  // Put back to work by a SendMessage after it had already finished (the tool
  // resumed it in the background). Its parent Task tool_result settled long ago,
  // so that signal must stop counting as "done" or the card would read finished
  // while the agent is running again - see reopenMessagedSubagent.
  reopened?: boolean
  items: ChatItem[]
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type CommitChipItem = Extract<ChatItem, { kind: 'commit' }>

// isSubRunning reports whether a sub-agent is still working: the parent Task
// card's tool_result (or its turn ending, `ended`) is the precise done signal
// for a linked sub. A background/async agent is the exception - its tool_result
// is only the launch boilerplate, arriving at spawn time, NOT a completion - so
// that result is ignored and we defer to the sub's own status (settled when its
// sidechain result finally lands), keeping the "working" marker up meanwhile.
function isSubRunning(sub: SubagentView, tool?: ToolItem): boolean {
  if (tool && !sub.reopened) {
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

function subCardLabels(sub: SubagentView, tool?: ToolItem): { label: string; desc: string } {
  const original = subLabels(sub, tool)
  const kind = original.label === 'Sub-agent' ? '' : original.label
  return {
    label: kind.toLowerCase() === 'codex' ? 'Agent' : 'Sub-agent',
    desc: [kind, original.desc].filter(Boolean).join(': '),
  }
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
  // Set on blocks Hydra makes up (a plan checkpoint has no tool call behind
  // it): they are not provider payloads, so Raw must not present them as one.
  synthetic?: boolean
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

interface ProviderEvent {
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
  // The working directory the CLI recorded for this entry. The Bash tool runs
  // ONE shell for a whole session, so this is the only record of where a command
  // ran - and it is read from the TOOL RESULT entry, where it is the directory
  // AFTER the command. (On the assistant entry carrying the tool_use it is
  // stamped at flush time and can land either side of the call, so it is
  // ignored.) Absent from live stdout lines on some CLI versions, in which case
  // the chat infers the directory instead - see lib/shellCwd.
  cwd?: string
  // Set on the events normalizedToProviderEvents rebuilds from the backend
  // timeline: THIS object is Hydra's reconstruction, not a line a provider sent,
  // so Raw must not present it as one. The provider's own entry (the recorded
  // line minus its message content) rides on `entry` where the backend captured
  // one - see internal/chat/claude.go.
  synthesizedEvent?: boolean
  entry?: unknown
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
  // model_refusal_fallback system event: when a turn trips a model's safety
  // classifier the CLI retries it under a fallback model and emits this, listing
  // the uuids of the flagged blocks it retracted. On the LIVE stream those blocks
  // already streamed and rendered (the retry then re-emits them under new uuids),
  // so the reducer evicts the listed uuids to undo the duplicate. Read both
  // spellings: the persisted transcript uses camelCase, and the stdout stream-json
  // field name isn't guaranteed identical. Only the retry is persisted, so the
  // backfill/history path never sees the duplicate and needs no eviction.
  retractedMessageUuids?: string[]
  retracted_message_uuids?: string[]
  // The tool's own structured result, riding on a user envelope alongside its
  // tool_result block. Only the Edit slice of it is used - its unified patch,
  // which is what lets an Edit card show the file's real line numbers (see
  // lib/editDiff). Both spellings again: stdout stream-json writes it
  // snake_case, the persisted transcript camelCase. The normalized path instead
  // delivers the patch pre-extracted by the daemon, as `editPatch`.
  tool_use_result?: unknown
  toolUseResult?: unknown
  editPatch?: EditHunk[] | null
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
  subagentNotice?: { key: string; label: string; description: string }
  // Set by the CLI on machine-injected context that rides in a `user` envelope
  // but was never typed by the user - the resume nudge, and a Skill's auto-loaded
  // SKILL.md body. The reducer routes these out of the normal chat flow (a
  // collapsed meta card / a skill card) instead of rendering them as a user turn.
  isMeta?: boolean
  // A background/async sub-agent's completion <task-notification> is written to
  // the main transcript not as a user turn but as bookkeeping records the chat
  // socket relays live: a queue-operation (XML on top-level `content`) and an
  // attachment (XML on `attachment.prompt`). handleProviderEvent settles the sub
  // off whichever carries it (see handleTaskNotification).
  content?: string
  // attachment.prompt is a string for <task-notification> records, and an array
  // of content blocks for queued_command records (a queued message consumed
  // into a running turn - see queuedCommandText).
  attachment?: { type?: string; prompt?: string | { type?: string; text?: string }[]; commandMode?: string }
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
  // shell rides on a synthesized 'shellcmd' event (built from a user_message
  // whose payload carried a `shell` object): a chat "!command"'s sandboxed
  // result, rendered as a ShellCommandCard instead of a user bubble.
  shell?: { command: string; output: string; exit_code: number; truncated?: boolean; timed_out?: boolean; stopped?: boolean }
}

// parseEventTs reads a transcript entry's ISO `timestamp` into epoch ms, or
// null when absent/unparseable (live stdout lines have none).
function parseEventTs(ev: ProviderEvent): number | null {
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

// Playful gerunds for the live "working" indicator (item 48), Claude-Code
// style: a broad grab-bag picked at RANDOM per turn (not round-robin, which
// made the same few words - Flambeing, Crunching - feel like fixtures). The
// pick stays stable while the turn runs.
const WORKING_VERBS = [
  'Accomplishing', 'Actualizing', 'Baking', 'Brewing', 'Cerebrating',
  'Churning', 'Coalescing', 'Cogitating', 'Combobulating', 'Computing',
  'Concocting', 'Conjuring', 'Considering', 'Cooking', 'Crafting',
  'Crunching', 'Deciphering', 'Deliberating', 'Distilling', 'Divining',
  'Effecting', 'Elucidating', 'Envisioning', 'Finagling', 'Flambeing',
  'Forging', 'Frolicking', 'Germinating', 'Hatching', 'Herding',
  'Hustling', 'Ideating', 'Incubating', 'Inferring', 'Manifesting',
  'Marinating', 'Moseying', 'Mulling', 'Musing', 'Mustering',
  'Noodling', 'Percolating', 'Perusing', 'Pondering', 'Pontificating',
  'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming',
  'Schlepping', 'Simmering', 'Smooshing', 'Spelunking', 'Stewing',
  'Sussing', 'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting',
  'Unfurling', 'Unravelling', 'Vibing', 'Wandering', 'Whirring',
  'Whisking', 'Wibbling', 'Wizarding', 'Working', 'Wrangling',
]

// Auto-reconnect tuning: a connection that stayed open this long counts as
// healthy (resets the failure streak), and quick-failure retries back off
// exponentially up to this cap.
const RECONNECT_HEALTHY_MS = 15_000
const RECONNECT_MAX_DELAY_MS = 15_000

// Opening an agent with unread changes on the top of its last message (see
// alignToLastMessage): the breathing room left above that message (and below
// any card floating over the transcript's top edge); how close to the bottom
// still counts as "at the bottom" (also the slack that tells our own scroll
// write apart from the user moving); and how long re-aligning keeps up with
// content settling in - markdown, highlighting and images all land over the
// frames after the replay.
const ALIGN_GAP_PX = 8
const BOTTOM_SLACK_PX = 4
const ALIGN_SETTLE_MS = 1_000

// Time constant of the pinned auto-scroll glide (see followBottom): the gap to
// the bottom shrinks by 1/e every this-many ms, so a jump is ~95% closed in
// 3x this. Short enough that live streaming stays glued to the bottom, long
// enough that a tool card landing reads as a slide rather than a jump.
const FOLLOW_TAU_MS = 70

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

function stableContentKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContentKey).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableContentKey(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

// Claude appends a machine-oriented continuation/usage trailer to completed
// side-agent text. It belongs to the transport, not the human-readable report.
function cleanSubagentReport(text: string): string {
  return text
    .replace(/\n?agentId:\s*[^\n]+(?:\n<usage>[\s\S]*?<\/usage>)?\s*$/i, '')
    .replace(/\n?<usage>[\s\S]*?<\/usage>\s*$/i, '')
    .trimEnd()
}

// entryString reads one field off a relayed provider entry (see ProviderEvent.entry).
function entryString(entry: unknown, key: string): string {
  if (!entry || typeof entry !== 'object') return ''
  const value = (entry as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

// Bridge the provider-neutral backend timeline into the mature presentation
// reducer while Claude's legacy wire format is being retired. Provider details
// stop at this boundary; paging and live delivery use the same conversion.
// (Exported for tests.)
// eslint-disable-next-line react-refresh/only-export-components
export function normalizedToProviderEvents(ev: NormalizedChatEvent, showEmptyReasoning = false): ProviderEvent[] {
  const p = ev.payload ?? {}
  const base = {
    timestamp: ev.timestamp,
    // Hydra user events retain the client-generated id. Matching optimistic
    // bubbles by this id avoids a repeated same-text message replacing the
    // wrong bubble (and visibly flashing during Codex send reconciliation).
    uuid: typeof p.uuid === 'string' && p.uuid
      ? p.uuid
      : ev.type === 'user_message' && typeof p.id === 'string' && p.id
        ? p.id
        : `normalized:${ev.seq}`,
    isSidechain: p.sidechain === true,
    agentId: typeof p.agent_id === 'string' ? p.agent_id : undefined,
    parent_tool_use_id: typeof p.parent_item_id === 'string' ? p.parent_item_id : undefined,
    // The provider's own recorded entry, when the backend captured one. The
    // fields the presentation needs are read off it rather than being copied up
    // one by one - `cwd` (see lib/shellCwd) is the first, and whatever a future
    // CLI adds is already here. `p.cwd` is the older spelling, kept for events
    // stored before the entry was relayed.
    entry: p.entry && typeof p.entry === 'object' ? p.entry : undefined,
    cwd: entryString(p.entry, 'cwd') || (typeof p.cwd === 'string' ? p.cwd : '') || undefined,
    synthesizedEvent: true,
  }
  const text = typeof p.text === 'string' ? p.text : contentText(p.content)
  const id = typeof p.id === 'string' ? p.id : typeof p.message_id === 'string' ? p.message_id : String(ev.seq)
  switch (ev.type) {
    case 'conversation_started':
      return [{ type: 'system', subtype: 'init', model: typeof p.model === 'string' ? p.model : undefined, slash_commands: Array.isArray(p.slash_commands) ? p.slash_commands.filter((v): v is string => typeof v === 'string') : undefined, apiKeySource: typeof p.api_key_source === 'string' ? p.api_key_source : undefined }]
    case 'user_message': {
      // A "!command" the user ran: its user_message payload carries the sandboxed
      // result under `shell`. Render it as a shell-command card, not a user bubble
      // (the same text is still what the agent received as its turn).
      const sh = p.shell as { command?: unknown; output?: unknown; exit_code?: unknown; truncated?: unknown; timed_out?: unknown; stopped?: unknown } | undefined
      if (sh && typeof sh === 'object') {
        return [{
          ...base,
          type: 'shellcmd',
          shell: {
            command: typeof sh.command === 'string' ? sh.command : '',
            output: typeof sh.output === 'string' ? sh.output : '',
            exit_code: typeof sh.exit_code === 'number' ? sh.exit_code : -1,
            truncated: sh.truncated === true,
            timed_out: sh.timed_out === true,
            stopped: sh.stopped === true,
          },
        }]
      }
      return text.trim() ? [{ ...base, type: 'user', message: { content: p.content as ClaudeContentBlock[] | string } }] : []
    }
    case 'context_message':
      return [{ ...base, type: 'user', isMeta: true, message: { content: p.content as ClaudeContentBlock[] | string } }]
    case 'assistant_message':
      return text.trim() ? [{ ...base, type: 'assistant', message: { id, content: [{ type: 'text', text }], stop_reason: typeof p.stop_reason === 'string' ? p.stop_reason : undefined, usage: p.usage as TokenUsage } }] : []
    case 'reasoning_completed':
      return text.trim() || showEmptyReasoning ? [{ ...base, type: 'assistant', message: { id, content: [{ type: 'thinking', thinking: text }] } }] : []
    case 'tool_started': {
      const name = typeof p.name === 'string' ? p.name : 'tool'
      const input = p.input ?? p.item ?? (typeof p.command === 'string' ? { command: p.command, cwd: p.cwd } : p)
      // Claude's normalized tool payloads are the Anthropic block, field for
      // field, so the block rebuilt here IS what the provider sent and Raw can
      // show it. Codex's are not - they carry the item's status/output (and its
      // native item), and the daemon passes the true payload separately as
      // `_raw` - so mark those blocks synthetic and let Raw fall back to it.
      const codexShaped = p.status !== undefined || p.output !== undefined || p.item !== undefined
      return [{ ...base, type: 'assistant', message: { id: `tool:${id}`, content: [{ type: 'tool_use', id, name, input, synthetic: codexShaped }] } }]
    }
    case 'tool_completed': {
      const result = p.content ?? p.output ?? (typeof p.status === 'string' ? p.status : '')
      // Same rule for the result: `content` is Claude's verbatim tool_result
      // payload; anything reconstructed from output/status is not a block.
      // `patch` rides on the event, not the block - it is Hydra's extract of the
      // tool's structured result, not something the provider put in the block.
      return [{ ...base, type: 'user', editPatch: parseEditPatch(p.patch), message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: p.is_error === true || p.status === 'failed', synthetic: p.content == null }] } }]
    }
    case 'plan_updated': {
      // Claude exposes its TaskCreate/TaskUpdate calls as ordinary tool cards;
      // its tracker-generated plan events are state checkpoints, not a second
      // visible UpdatePlan invocation. Codex's turn/plan/updated notification
      // has no separate tool item, so retain its useful timeline card.
      if (p.provider !== 'codex') return []
      const plan = Array.isArray(p.plan) ? p.plan : []
      const completed = plan.filter((entry) => entry && typeof entry === 'object' && (entry as { status?: unknown }).status === 'completed').length
      const summary = `${plan.length} task${plan.length === 1 ? '' : 's'} · ${completed} completed`
      const toolID = `plan:${ev.seq}`
      // Hydra invents this card from a plan checkpoint - there is no tool call
      // behind it, so `synthetic` keeps its made-up blocks out of Raw (they
      // would read as a protocol payload the provider never sent).
      return [
        { ...base, type: 'assistant', message: { id: `tool:${toolID}`, content: [{ type: 'tool_use', id: toolID, name: 'UpdatePlan', input: { description: summary, plan }, synthetic: true }] } },
        { ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolID, content: 'Plan updated', synthetic: true }] } },
      ]
    }
    case 'subagent_completed': {
      const key = typeof p.id === 'string' ? p.id : ''
      const label = typeof p.agent_type === 'string' ? p.agent_type : 'Sub-agent'
      const description = typeof p.description === 'string' ? p.description : ''
      return key ? [{ ...base, type: 'hydra_subagent_completed', isSidechain: false, agentId: undefined, parent_tool_use_id: null, subagentNotice: { key, label, description } }] : []
    }
    case 'content_stream_started':
      // The first normalized delta opens the presentation stream. Forwarding
      // this provider boundary as well opened it twice and reset Claude's
      // partially rendered response when its first token arrived.
      return []
    case 'content_stream_completed':
      // The completed semantic message closes the stream atomically with the
      // settled item, avoiding an empty gap between preview and final content.
      return []
    case 'usage_updated': {
      const usage = p.usage as TokenUsage
      return typeof p.message_id === 'string'
        ? [{ type: 'stream_event', event: { type: 'message_start', message: { usage } } }]
        : [{ type: 'stream_event', event: { type: 'message_delta', usage } }]
    }
    case 'reasoning_duration':
      return [{ type: 'hydra_thinking', message_id: typeof p.message_id === 'string' ? p.message_id : '', duration_ms: typeof p.duration_ms === 'number' ? p.duration_ms : 0 }]
    case 'messages_retracted':
      return [{ type: 'system', subtype: 'model_refusal_fallback', retractedMessageUuids: Array.isArray(p.message_ids) ? p.message_ids.filter((v): v is string => typeof v === 'string') : [] }]
    case 'notice':
      return text && !isAgentCompletionNotification(text) ? [{ ...base, type: 'queue-operation', content: text }] : []
    case 'interaction_requested': {
      const interaction = p.interaction && typeof p.interaction === 'object' ? p.interaction as Record<string, unknown> : {}
      if (p.provider === 'claude') {
        return [{ type: 'control_request', request_id: typeof p.request_id === 'string' ? p.request_id : '', request: interaction as ProviderEvent['request'] }]
      }
      const params = interaction.params && typeof interaction.params === 'object' ? interaction.params as Record<string, unknown> : {}
      if (interaction.method === 'item/tool/requestUserInput') {
        const toolID = typeof params.itemId === 'string' ? params.itemId : id
        const requestID = String(interaction.request_id ?? '')
        const input = { questions: Array.isArray(params.questions) ? params.questions : [] }
        return [
          { ...base, type: 'assistant', message: { id: `question:${toolID}`, content: [{ type: 'tool_use', id: toolID, name: 'AskUserQuestion', input }] } },
          { type: 'control_request', request_id: requestID, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: toolID, input } },
        ]
      }
      return []
    }
    case 'turn_completed':
    case 'turn_failed': {
      // Compatibility for logs written before cancellation got its own event
      // type: the adapter labelled them completed/failed but retained Codex's
      // cancellation status or error in the payload.
      const terminal = `${typeof p.status === 'string' ? p.status : ''} ${contentText(p.error)}`.toLowerCase()
      if (/interrupt|cancel/.test(terminal)) {
        return [{ ...base, type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]
      }
      return [{ ...base, type: 'result', subtype: ev.type === 'turn_failed' ? 'error' : 'success', is_error: ev.type === 'turn_failed', result: providerErrorText(p.error) || (typeof p.result === 'string' ? p.result : ''), usage: p.usage as TokenUsage, total_cost_usd: typeof p.cost_usd === 'number' ? p.cost_usd : undefined }]
    }
    case 'turn_error':
      return [{ ...base, type: 'result', subtype: 'error', is_error: true, result: providerErrorText(p.error) }]
    case 'turn_interrupted':
      return [{ ...base, type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]
    default:
      return []
  }
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

// isTaskNotification reports whether a message IS a harness <task-notification>
// bookkeeping record (which always leads with the tag) rather than a real message
// that merely mentions one in its prose - so quoting "<task-notification>" in a
// chat message no longer gets it swallowed as a notice. trimStart covers the raw
// relay channels (ev.content / attachment.prompt) that aren't pre-trimmed.
function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

// Logs written before agent completion became one canonical lifecycle event
// contain both this machine notification and subagent_completed. Suppress the
// former during replay so old conversations are idempotent too.
function isAgentCompletionNotification(text: string): boolean {
  if (!isTaskNotification(text)) return false
  const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim()
  const summary = decodeEntities(/<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? '')
  return status === 'completed' && /^Agent\b/i.test(summary)
}

// queuedCommandText extracts the message text from a queued_command attachment
// record. When the CLI consumes a queued message INTO A RUNNING TURN (mid-turn
// steering - the queue-operation "remove" path), it writes NO plain `user`
// event; this attachment, with the text on attachment.prompt content blocks,
// is the message's only durable trace - so replay must rebuild the user bubble
// from it or the message vanishes on the next reattach. (A message consumed
// while the CLI is idle gets a real user event and never reaches this path.)
function queuedCommandText(ev: ProviderEvent): string | null {
  const att = ev.attachment
  if (ev.type !== 'attachment' || att?.type !== 'queued_command') return null
  const prompt = att.prompt
  if (typeof prompt === 'string') {
    // A background task's <task-notification> rides the same attachment type
    // with a string prompt - that's a notice, never a user message (the
    // reducers consume it before reaching here; this guard is belt+braces).
    const t = prompt.trim()
    return !t || isTaskNotification(t) ? null : t
  }
  if (!Array.isArray(prompt)) return null
  const text = prompt
    .filter((b) => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
  return text || null
}

// detectContextNote recognises the CLI-injected "session continued" preamble that
// leads a conversation after a context compaction (auto/ran-out-of-context or an
// explicit /compact). It's a summary the CLI feeds the model to carry state over,
// not a real user turn, so the chat collapses it behind an expander (item 39).
// Returns null for any ordinary message. outOfContext flags the auto case.
function detectContextNote(text: string): { outOfContext: boolean } | null {
  const t = text.trimStart()
  if (t.startsWith('This session is being continued from a previous conversation')) {
    return { outOfContext: /ran out of context/i.test(t.slice(0, 200)) }
  }
  return null
}

// detectSkillBody recognises the SKILL.md body Claude auto-injects when a Skill
// tool runs: an isMeta `user` text block that always opens with "Base directory
// for this skill: <path>". Returns the skill name (the path's last segment) and
// the body with that lead line stripped, or null for any other meta message.
function detectSkillBody(text: string): { name: string; body: string } | null {
  const m = /^\s*Base directory for this skill:\s*(\S+)[^\n]*\n?/.exec(text)
  if (!m) return null
  const name = m[1].split('/').filter(Boolean).pop() || 'skill'
  return { name, body: text.slice(m[0].length).trim() }
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

// Input fields that hold PROSE (a sentence the agent wrote), rendered in the
// sans font on the card header rather than monospace - a ScheduleWakeup prompt
// or an Agent brief isn't code.
const PROSE_INPUT_KEYS = new Set(['query', 'subject', 'summary', 'description', 'prompt', 'reason'])

// summarizeGitInput renders an mcp__hydra__git_* call as the action it performs
// ("hard -> 67b6ffa2", a commit subject) rather than as its arguments. None of
// these tools carry any of the keys the generic loop below looks for, so without
// this they all fall through to the JSON.stringify fallback - which dumps a whole
// escaped commit message, literal \n and all, into a one-line card header.
// Returns null for a tool with nothing worth previewing.
function summarizeGitInput(tool: string, obj: Record<string, unknown>): { text: string; prose: boolean } | null {
  const str = (key: string) => (typeof obj[key] === 'string' ? (obj[key] as string) : '')
  switch (tool) {
    case 'git_commit':
      // Subject line only - the rest of the message is prose the agent wrote out,
      // and it is what renders as a literal \n\n when squeezed onto one line.
      // --amend rides in the heading; the staging mode is in the body.
      return { text: str('message').split('\n')[0].trim(), prose: true }
    case 'git_add': {
      // Only a fallback: a git_add with a readable path renders as a lowlit path
      // in the header (isPathSummary), with its ranges in the lineInfo slot.
      const specs = gitAddSpecs(obj)
      return { text: specs.length === 1 ? specs[0].path : `${specs.length} files`, prose: specs.length !== 1 }
    }
    case 'git_reset': {
      // The mode is in the heading (gitToolHeading), so the summary is just the
      // operand: the target commit, or the paths being unstaged.
      const unstage = Array.isArray(obj.unstage) ? obj.unstage : []
      if (unstage.length) return { text: unstage.join(', '), prose: false }
      return { text: str('to') || 'HEAD', prose: false }
    }
    case 'git_revert':
    case 'git_cherry_pick':
      return { text: str('commit'), prose: false }
    case 'git_rebase': {
      const plan = Array.isArray(obj.plan) ? obj.plan : []
      return { text: `${plan.length} step${plan.length === 1 ? '' : 's'} above ${str('base')}`, prose: true }
    }
    case 'git_merge':
      // The --no-ff flag is in the heading, so the summary is just what came in.
      return { text: str('ref'), prose: false }
    case 'git_stash': {
      // The operation is in the heading; the summary is what it acted on - the
      // label being saved, or the entry being restored/dropped.
      const op = str('op') || 'push'
      if (op === 'push') return str('message') ? { text: str('message'), prose: true } : null
      if (op === 'list') return null
      return { text: str('ref') || 'stash@{0}', prose: false }
    }
    default:
      return null
  }
}

// summarizeToolSearchQuery renders a ToolSearch query as the thing it looks up.
// The `select:a,b` form is an exact list of tool names, and the wire spelling of
// an MCP one (`mcp__hydra__git_commit`) is transport detail - it reads as
// "hydra::git_commit", the same namespace::tool shape the card heading uses.
// Any other query is a keyword search, i.e. words the agent typed, so it stays
// verbatim and prose. The Raw view keeps the query as sent. (Exported for tests.)
// eslint-disable-next-line react-refresh/only-export-components
export function summarizeToolSearchQuery(query: string): { text: string; prose: boolean } {
  const select = /^\s*select:(.*)$/.exec(query)
  if (!select) return { text: query, prose: true }
  const names = select[1].split(',').map((n) => n.trim()).filter(Boolean)
  if (names.length === 0) return { text: query, prose: false }
  return { text: names.map(mcpToolLabel).join(', '), prose: false }
}

// summarizeToolInput produces the one-line preview shown on a collapsed tool
// card, favouring the fields agent tools actually carry, and reports whether
// the picked field is prose (see PROSE_INPUT_KEYS). name is the raw tool name,
// used to give the git tools an action-shaped summary (see summarizeGitInput).
function summarizeToolInput(input: unknown, name = ''): { text: string; prose: boolean } {
  if (input == null) return { text: '', prose: false }
  if (typeof input !== 'object') return { text: String(input), prose: false }
  const obj = input as Record<string, unknown>
  if (Object.keys(obj).filter((key) => !key.startsWith('_')).length === 0) return { text: '', prose: false }
  if (name === 'ToolSearch' && typeof obj.query === 'string') return summarizeToolSearchQuery(obj.query)
  const gitTool = /^mcp__hydra__(git_.+)$/.exec(name)
  if (gitTool) {
    const git = summarizeGitInput(gitTool[1], obj)
    if (git) return git
  }
  // A TaskUpdate reads best as "#id -> status: subject" (only the parts present).
  if (typeof obj.taskId === 'string' || typeof obj.taskId === 'number') {
    const status = typeof obj.status === 'string' ? obj.status : ''
    const subj = typeof obj.subject === 'string' ? obj.subject : ''
    return { text: `#${obj.taskId}${status ? ` -> ${status}` : ''}${subj ? `: ${subj}` : ''}`, prose: true }
  }
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'subject', 'summary', 'description', 'prompt', 'reason']) {
    if (typeof obj[key] === 'string' && obj[key]) return { text: obj[key] as string, prose: PROSE_INPUT_KEYS.has(key) }
  }
  try {
    return { text: JSON.stringify(input), prose: false }
  } catch {
    return { text: '', prose: false }
  }
}

function mergeToolInputHistory(previous: unknown, next: unknown): unknown {
  if (!next || typeof next !== 'object') return next
  const merged = { ...(next as Record<string, unknown>) }
  const raws: unknown[] = []
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    if (Array.isArray(obj._raw_events)) raws.push(...obj._raw_events)
    else if (obj._raw != null) raws.push(obj._raw)
  }
  collect(previous)
  collect(next)
  const unique = raws.filter((raw, index) => raws.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(raw)) === index)
  if (unique.length > 1) merged._raw_events = unique
  return merged
}

function interactiveShellTranscript(command: string, output: string): { command: string; output: string } | null {
  if (!/^(?:(?:\/usr\/bin|\/bin)\/)?(?:ba|z|)sh(?:\s+(?:-[il]*c\s+)?(?:(?:\/usr\/bin|\/bin)\/)?(?:ba|z|)sh)?$/.test(command.trim())) return null
  const clean = stripAnsi(output).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean.split('\n')
  const entered = lines.find((line) => line.trim() && !/^\[\d+\]\s+\d+\s*$/.test(line.trim()))?.trim()
  if (!entered || entered === 'exit') return null
  const rest = lines
    .slice(lines.indexOf(lines.find((line) => line.trim() === entered) ?? '') + 1)
    .filter((line) => line.trim() !== 'exit' && !/^[^\n]*[$#]\s+exit\s*$/.test(line))
    .join('\n')
    .trimEnd()
  return { command: entered, output: rest }
}

// Keep provider protocol identifiers in Raw while making MCP calls scan like
// namespace-qualified operations in the normal card header.
// sendMessageRecipient pulls the agent a SendMessage call is addressed to. The
// tool echoes the id under both `to` and the legacy `recipient` (and mirrors
// `message` as `content`) - the card shows it once and hides the duplicates.
const SEND_MESSAGE_ECHO_KEYS = new Set(['recipient', 'content', 'type'])
function sendMessageRecipient(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of ['to', 'recipient', 'agent_id', 'agentId']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
  }
  return ''
}

// A SendMessage result is a JSON envelope, not prose:
//   {"success":true,"message":"Agent \"<id>\" had no active task; resumed ...
//    Output: /tmp/.../tasks/<id>.output","resumedAgentId":"<id>","pin":{...}}
// parseSendMessageResult turns it into what the card actually shows - the
// sentence, the recipient it names, and whether the agent was resumed (i.e. it
// is working again, see reopenMessagedSubagent). Null for anything that isn't
// that envelope, so an unrecognised result falls back to the plain panel.
interface SendMessageResult {
  ok: boolean
  message: string
  outputFile: string
  recipient: string
  resumed: boolean
}
function parseSendMessageResult(text?: string): SendMessageResult | null {
  if (!text || !text.trim().startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.success !== 'boolean' && typeof obj.message !== 'string') return null
  let message = typeof obj.message === 'string' ? obj.message : ''
  // The output-file path is machine plumbing - keep it out of the sentence (the
  // Raw view still has it).
  let outputFile = ''
  const outputAt = /\s*Output:\s*(\S+)\s*$/.exec(message)
  if (outputAt) {
    outputFile = outputAt[1]
    message = message.slice(0, outputAt.index).trim()
  }
  const resumedAgentId = typeof obj.resumedAgentId === 'string' ? obj.resumedAgentId : ''
  const pin = obj.pin && typeof obj.pin === 'object' ? (obj.pin as Record<string, unknown>) : null
  const pinnedId = pin && typeof pin.id === 'string' ? pin.id : ''
  return {
    ok: obj.success !== false,
    message,
    outputFile,
    recipient: resumedAgentId || pinnedId,
    resumed: resumedAgentId !== '',
  }
}

// GIT_TOOL_LABELS names the mcp__hydra__git_* tools after the action they take.
// They are Hydra's own git plumbing - the sanctioned replacement for raw git,
// which is gate-denied - so the generic "MCP hydra::git_cherry_pick" rendering
// buries the verb behind transport detail that means nothing to the reader.
// Lowercase and named after the git subcommand they run ("git add", not "Git
// stage"): these ARE git commands, so the label the reader already knows beats a
// prettified synonym they have to map back.
const GIT_TOOL_LABELS: Record<string, string> = {
  git_commit: 'git commit',
  git_add: 'git add',
  git_reset: 'git reset',
  git_revert: 'git revert',
  git_cherry_pick: 'git cherry-pick',
  git_rebase: 'git rebase',
  git_rebase_continue: 'git rebase --continue',
  git_rebase_abort: 'git rebase --abort',
  git_merge: 'git merge',
  git_merge_continue: 'git merge --continue',
  git_merge_abort: 'git merge --abort',
  git_stash: 'git stash',
}

// gitToolHeading is GIT_TOOL_LABELS plus the flags this particular call used, so
// the heading reads as the command that ran ("git reset --hard") instead of
// making you open the card to find out which variant it was. Only flags that
// change what the command DOES are promoted; the operands (a target commit, a
// path list) stay in the summary and body.
function gitToolHeading(tool: string, input: Record<string, unknown> | null): string {
  const label = GIT_TOOL_LABELS[tool] ?? tool
  if (!input) return label
  if (tool === 'git_reset') {
    // The path form (`reset -- <paths>`) takes no mode; only the HEAD-moving form
    // does, and there soft is git's default.
    if (Array.isArray(input.unstage) && input.unstage.length > 0) return label
    const mode = typeof input.mode === 'string' && input.mode ? input.mode : 'soft'
    return `${label} --${mode}`
  }
  if (tool === 'git_commit' && input.amend === true) return `${label} --amend`
  if (tool === 'git_merge' && input.no_ff === true) return `${label} --no-ff`
  if (tool === 'git_stash') {
    // The sub-operation IS the command here - "git stash" alone says nothing
    // about whether work was parked or restored.
    const op = typeof input.op === 'string' && input.op ? input.op : 'push'
    return `${label} ${op}`
  }
  return label
}

// mcpToolLabel spells an MCP tool as "server::tool" - the wire name's `mcp__`
// prefix and `__` separators are protocol noise. Anything that isn't an MCP
// name is returned unchanged.
function mcpToolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]}::${mcp[2]}` : name
}

function displayToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return (mcp[1] === 'hydra' ? GIT_TOOL_LABELS[mcp[2]] : '') || `MCP ${mcpToolLabel(name)}`
  return ({ SendMessage: 'Send Message', ResumeAgent: 'Resume Agent', CloseAgent: 'Close Agent', UpdatePlan: 'Update Plan' } as Record<string, string>)[name] ?? name
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

// parseToolResult flattens a tool_result block's content into displayable text
// plus any inline images (an image-read returns image blocks, not text - item
// 4). Base64 sources become data URLs; url sources are used verbatim.
function parseToolResult(content: unknown): { text: string; images: string[] } {
  const images: string[] = []
  // A ToolSearch result is a list of `tool_reference` blocks - the loaded tool's
  // NAME and nothing else, no text anywhere - so the card used to render the
  // whole schema load as "(no output)". They become the one line that says what
  // the call actually did (namespaced like the header, see mcpToolLabel).
  const loaded: string[] = []
  const collect = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(collect).filter(Boolean).join('\n')
    if (c && typeof c === 'object') {
      const b = c as ClaudeContentBlock & {
        source?: { type?: string; media_type?: string; data?: string; url?: string }
        tool_name?: string
      }
      if (b.type === 'image' && b.source) {
        const s = b.source
        if (s.type === 'base64' && s.data) images.push(`data:${s.media_type ?? 'image/png'};base64,${s.data}`)
        else if (s.type === 'url' && s.url) images.push(s.url)
        return ''
      }
      if (b.type === 'tool_reference' && b.tool_name) {
        loaded.push(mcpToolLabel(b.tool_name))
        return ''
      }
      if (typeof b.text === 'string') return b.text
    }
    return ''
  }
  const text = stripToolUseError(collect(content))
  if (loaded.length === 0) return { text, images }
  // One name reads as a sentence; several are worth counting, since a keyword
  // search returns however many tools matched.
  const summary = loaded.length === 1 ? `Loaded ${loaded[0]}` : `Loaded ${loaded.length} tools: ${loaded.join(', ')}`
  return { text: text ? `${summary}\n${text}` : summary, images }
}

// scrubRawImageData prepares a tool_result block for the Raw panel: everything
// verbatim EXCEPT an image block's base64, which is swapped for its size. The
// pixels are already decoded into the card's rendered image, and a screenshot is
// megabytes of base64 - keeping it here would hold those bytes a second time and
// bury the block's actual shape. media_type and the block structure stay true.
// Returns the block itself (no copy) when there is nothing to scrub, which is
// every non-image result.
function isBase64ImageBlock(b: unknown): b is { type: string; source: { type?: string; media_type?: string; data: string } } {
  if (!b || typeof b !== 'object') return false
  const block = b as { type?: string; source?: { data?: unknown } }
  return block.type === 'image' && typeof block.source?.data === 'string'
}
function scrubRawImageData(block: ClaudeContentBlock): unknown {
  const content = block.content
  if (!Array.isArray(content) || !content.some(isBase64ImageBlock)) return block
  return {
    ...block,
    content: content.map((b) =>
      isBase64ImageBlock(b)
        ? { ...b, source: { ...b.source, data: `<${formatBytes(Math.round((b.source.data.length * 3) / 4))} base64, rendered above>` } }
        : b,
    ),
  }
}

// rawUseBlock / rawResultBlock are what a card keeps for its Raw panel: the
// provider's block, images scrubbed, or nothing at all for one Hydra made up.
// `synthetic` is Hydra's own marker, so it is dropped from what Raw prints.
function keptRawBlock(block: ClaudeContentBlock, value: unknown): unknown {
  if (block.synthetic) return undefined
  if (!('synthetic' in block) || !value || typeof value !== 'object') return value
  const rest = { ...(value as ClaudeContentBlock) }
  delete rest.synthetic
  return rest
}

// inEntry puts a block back inside the ENTRY the CLI recorded it in - the line's
// envelope (type, uuid, timestamp, cwd, sidechain markers, the message's id and
// usage) with `message.content` narrowed to this one block.
//
// Raw used to show the bare block, which meant everything the CLI wrote around
// it was invisible: `cwd` - the only record of which directory a command ran in
// - was there in the transcript all along and could not be seen. Wrapping,
// rather than copying chosen fields up, keeps Raw honest as the CLI adds fields
// nobody here has heard of yet.
//
// Narrowed to one block because a card is one tool call: an assistant message
// routinely carries several tool_use blocks (plus its text), and each of those
// is its own card, showing its own entry.
function inEntry(entry: unknown, block: unknown): unknown {
  if (block === undefined || !entry || typeof entry !== 'object') return block
  const out = { ...(entry as Record<string, unknown>) }
  const message = out.message && typeof out.message === 'object' ? (out.message as Record<string, unknown>) : {}
  out.message = { ...message, content: [block] }
  return out
}
// providerEntry is the recorded line a card should show its block inside of.
// An event parsed straight off the wire IS that line; one rebuilt from the
// backend timeline is not, and carries the real entry separately (or nothing at
// all, for a provider whose raw shape is handled elsewhere - Codex's `_raw`).
function providerEntry(ev: ProviderEvent): unknown {
  return ev.synthesizedEvent ? ev.entry : ev
}
function rawUseBlock(block: ClaudeContentBlock, entry?: unknown): unknown {
  return inEntry(entry, keptRawBlock(block, block))
}
function rawResultBlock(block: ClaudeContentBlock, entry?: unknown): unknown {
  return inEntry(entry, keptRawBlock(block, scrubRawImageData(block)))
}

// eventEditPatch pulls an Edit's unified patch off a user envelope, from
// whichever wire shape delivered it: pre-extracted by the daemon on the
// normalized path, or dug out of the raw stream-json line's tool_use_result on
// the legacy one. Returns null for every other tool - the oldString/newString
// pair is what tells an Edit's result apart from a Write's (whose patch is the
// whole new file, already rendered as the card's content).
//
// The envelope carries one result with nothing naming which block it belongs
// to, so it is only attributable when the message holds a single tool_result
// (matching the daemon's own rule).
function eventEditPatch(ev: ProviderEvent, blocks: ClaudeContentBlock[]): EditHunk[] | null {
  if (blocks.filter((b) => b.type === 'tool_result').length !== 1) return null
  if (ev.editPatch !== undefined) return ev.editPatch
  const res = ev.tool_use_result ?? ev.toolUseResult
  if (!res || typeof res !== 'object') return null
  const r = res as { oldString?: unknown; newString?: unknown; structuredPatch?: unknown }
  if (typeof r.oldString !== 'string' || typeof r.newString !== 'string') return null
  return parseEditPatch(r.structuredPatch)
}

// toolRawJson builds the Raw panel's text for a tool card - the provider's own
// tool_use / tool_result blocks, as sent (item: raw passthrough).
//
// Codex is the exception: its native items are not Anthropic blocks, so the
// daemon hands them over under `_raw` / `_raw_events` on the input and THAT is
// its true raw - it wins where present. Cards Hydra synthesizes itself (a plan
// checkpoint, a codex event with no captured block) keep the older
// input/result rendering, since there is no wire payload to show.
// (Exported for tests.)
// eslint-disable-next-line react-refresh/only-export-components
export function toolRawJson(input: unknown, rawUse: unknown, rawResult: unknown, result: string | undefined): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  if (Array.isArray(obj?._raw_events)) return JSON.stringify({ events: obj._raw_events }, null, 2)
  if (obj?._raw && typeof obj._raw === 'object') {
    const raw: Record<string, unknown> = { ...(obj._raw as Record<string, unknown>) }
    if (result !== undefined && !('aggregatedOutput' in raw) && !('result' in raw)) raw.result = result
    return JSON.stringify(raw, null, 2)
  }
  if (rawUse !== undefined || rawResult !== undefined) {
    const raw: Record<string, unknown> = { tool_use: rawUse }
    // A call still running has no result block yet - show whatever output is
    // streaming in rather than nothing.
    if (rawResult !== undefined) raw.tool_result = rawResult
    else if (result !== undefined) raw.result = result
    return JSON.stringify(raw, null, 2)
  }
  const raw: Record<string, unknown> = { input }
  if (result !== undefined) raw.result = result
  return JSON.stringify(raw, null, 2)
}

// Decoded intrinsic sizes of tool-result images, cached module-wide so a
// re-render (or the same image in another card) never re-decodes.
const imageDimsCache = new Map<string, { w: number; h: number }>()

// useImageDims eagerly decodes the given image sources - as soon as the result
// arrives, while the card is still collapsed - and returns the cache of their
// intrinsic sizes. Rendering the <img> with width/height attributes lets
// layout reserve the correct box BEFORE the pixels are decoded, so the card's
// open animation (Expandable measures scrollHeight at open) sees the true
// height. Without this an image Read opened at its text-only height and
// snapped tall once the image landed after the animation.
function useImageDims(srcs: string[] | undefined): Map<string, { w: number; h: number }> {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!srcs?.length) return
    let cancelled = false
    for (const src of srcs) {
      if (imageDimsCache.has(src)) continue
      const img = new Image()
      img.onload = () => {
        if (img.naturalWidth > 0) imageDimsCache.set(src, { w: img.naturalWidth, h: img.naturalHeight })
        if (!cancelled) bump((n) => n + 1)
      }
      img.src = src
    }
    return () => {
      cancelled = true
    }
  }, [srcs])
  return imageDimsCache
}

// --- Plan / to-do panel (TodoWrite) -----------------------------------------

// restoredPlan reads the persisted plan for an agent as display TodoItems, so
// the panel can seed from it on mount / reconnect (see planStore).
function restoredPlan(projectId: string | null, agentId: string): TodoItem[] {
  return toTodoItems(loadPlan(projectId, agentId))
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
// TodoLi is one checklist row (icon + text), styled by status. When the task
// carries a description, the row is clickable: a hover-revealed chevron expands
// an animated description block beneath it.
function TodoLi({ t }: { t: TodoItem }) {
  const [open, setOpen] = useState(false)
  const hasDesc = !!t.description
  return (
    <li>
      <div
        className={`group flex items-start gap-1.5 ${hasDesc ? 'cursor-pointer' : ''}`}
        onClick={hasDesc ? () => setOpen((o) => !o) : undefined}
      >
        {t.status === 'completed' ? (
          <CheckCircle2 className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-500" />
        ) : t.status === 'in_progress' ? (
          <LoaderCircle className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin text-amber-500" />
        ) : (
          <Circle className="mt-0.5 w-3.5 h-3.5 shrink-0 text-stone-300 dark:text-stone-600" />
        )}
        <span
          className={`flex-1 min-w-0 ${
            t.status === 'completed'
              ? 'line-through text-stone-400 dark:text-stone-500'
              : t.status === 'in_progress'
                ? 'font-medium text-stone-700 dark:text-stone-200'
                : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
        </span>
        {hasDesc && (
          <ChevronRight
            className={`mt-0.5 w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-[transform,opacity] duration-200 ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-70'}`}
          />
        )}
      </div>
      {hasDesc && (
        <Expandable open={open}>
          <div className="pl-5 pr-1 pt-0.5 pb-0.5 text-[11px] leading-snug text-stone-500 dark:text-stone-400 whitespace-pre-wrap break-words">
            {t.description}
          </div>
        </Expandable>
      )}
    </li>
  )
}

// useChipWidth measures the natural (fit-content) width of a floating card's
// collapsed header chip via an invisible clone, so open/close can animate the
// card between PIXEL endpoints. Transitioning from `width: fit-content`
// cannot work here: the moment the list content mounts, fit-content already
// resolves to the open width, so the transition's start equals its end and
// the card snaps wide instead of gliding.
function useChipWidth(): [React.RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setW(el.offsetWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// `paired`: the sub-agent selector is on screen too, so the two cards split
// the row - half the pane each, the longer label truncating - instead of
// growing across it. Without that they overlap on a narrow pane and whichever
// is on top swallows the other's clicks; the plan used to drop to a second row
// for that, which cost it its fixed top-right corner. Halving applies open as
// well as collapsed: exempting an open card just moves the swallowed clicks to
// the other card's chip. The cap only bites below ~544px of pane - wider than
// that, both cards get their full designed width.
// memo: this sits next to the composer, whose `input` state re-renders ChatPane
// on every keystroke. The plan only changes on a TodoWrite (stable `todos`
// identity between those), and the layout flags are stable while typing, so the
// panel - and its chip-width measurement - skips the per-keystroke churn.
const PlanPanel = memo(function PlanPanel({ todos, narrow, paired, fadeIn }: { todos: TodoItem[]; narrow: boolean; paired: boolean; fadeIn: boolean }) {
  // Frozen at mount: fade in only when the plan APPEARS live (a first
  // TodoWrite mid-conversation), not on every reload's replay.
  const [animateIn] = useState(fadeIn)
  const [chipRef, chipW] = useChipWidth()
  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  const allDone = total > 0 && done === total
  // Completed items fold behind a "(N completed)" toggle so the in-progress /
  // pending work sits in view without scrolling past the done ones. Collapsed by
  // default - except when everything's done, where folding them away would leave
  // a card the user just expanded with nothing in it. That is only the DEFAULT:
  // the toggle still folds them away by hand, and closing + reopening the card
  // starts over from the default (see the header button).
  const completed = todos.filter((t) => t.status === 'completed')
  const active = todos.filter((t) => t.status !== 'completed')
  const [showDone, setShowDone] = useState(allDone)
  // Default collapsed when the pane is too narrow to sit a card alongside the
  // transcript, or when every item is checked off (a finished plan is just
  // noise expanded).
  const [open, setOpen] = useState(!narrow && !allDone)
  // Follow the narrow/wide flip and the all-done flip (collapse when it gets
  // tight or the plan completes, re-open when it widens or work resumes) while
  // still letting the user toggle in between - a render-phase sync like the
  // settings fields use. The all-done flip also flips the completed section, so
  // expanding a finished plan shows the checked-off items rather than an empty
  // body, and resuming work puts the active ones back in view.
  const [prevNarrow, setPrevNarrow] = useState(narrow)
  const [prevAllDone, setPrevAllDone] = useState(allDone)
  if (prevNarrow !== narrow || prevAllDone !== allDone) {
    setPrevNarrow(narrow)
    if (prevAllDone !== allDone) setShowDone(allDone)
    setPrevAllDone(allDone)
    setOpen(!narrow && !allDone)
  }

  return (
    // Collapsed, the card is its fit-content header chip ("Plan 1/3 >");
    // opening glides the width (the measured chip px -> w-64, see useChipWidth)
    // alongside the Expandable height. Always the top-right corner; sharing the
    // row with the selector caps it at half the pane (see `paired`) rather than
    // moving it.
    <div
      // See the selector's data-chat-overlay: both float over the transcript's
      // top edge and alignToLastMessage clears whichever is on screen.
      data-chat-overlay=""
      style={{ width: open ? 256 : chipW ?? undefined }}
      className={`absolute top-2 right-3 ${paired ? 'max-w-[calc(50%-1rem)]' : 'max-w-[calc(100%-1.5rem)]'} overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 bg-white/90 dark:bg-[#2b2b28]/90 shadow-lg backdrop-blur transition-[width] duration-200 ${animateIn ? 'animate-chat-item-in' : ''} ${open ? 'z-30' : 'z-20'}`}
    >
      {/* Invisible clone of the header at natural width - the collapsed chip
          width the open/close transition animates from/to (border included so
          the border-box width matches the card's). */}
      <div
        aria-hidden
        ref={chipRef}
        className="invisible absolute -left-[9999px] top-0 w-max border flex items-center gap-1.5 px-2.5 py-1.5"
      >
        <ListChecks className="w-3.5 h-3.5 shrink-0" />
        <span className="text-xs font-semibold shrink-0">Plan</span>
        <span className="shrink-0 text-[11px] tabular-nums">{done}/{total}</span>
        <ChevronRight className="w-3 h-3 shrink-0" />
      </div>
      <button
        onClick={() => {
          // Reopening starts the completed section from its default again
          // (open when the plan is finished), so a fold the user did last time
          // doesn't leave the reopened card empty. Reset on the way OPEN, not
          // on close - reshuffling the body mid-close animation shows.
          if (!open) setShowDone(allDone)
          setOpen((o) => !o)
        }}
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
        {/* Fixed w-64 (the card's OPEN width): Expandable measures scrollHeight
            the moment it opens, while the card is still gliding out from its
            narrow chip width - without a fixed inner width the text wraps into
            a huge column, the height animates to that, then snaps back down
            once the width lands. */}
        <div className="w-64 max-h-72 overflow-y-auto px-2.5 pb-2 space-y-1 text-xs">
          {completed.length > 0 && (
            <>
              <button
                onClick={() => setShowDone((v) => !v)}
                className="flex w-full items-center gap-1 text-left text-[11px] text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
              >
                <ChevronRight className={`w-3 h-3 shrink-0 transition-transform duration-200 ${showDone ? 'rotate-90' : ''}`} />
                <span>{completed.length} completed</span>
              </button>
              <Expandable open={showDone}>
                <ul className="space-y-1 pt-1">
                  {completed.map((t, i) => <TodoLi key={`c${i}`} t={t} />)}
                </ul>
              </Expandable>
            </>
          )}
          {active.length > 0 && (
            <ul className="space-y-1">
              {active.map((t, i) => <TodoLi key={`a${i}`} t={t} />)}
            </ul>
          )}
        </div>
      </Expandable>
    </div>
  )
})

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

// Claude models offered by the in-chat model dropdown. Sent verbatim to the
// CLI's set_model control request, so these must be aliases (or full model ids)
// it accepts. The two Opus versions use full ids rather than the bare `opus`
// alias so they map to distinct labels in modelDisplayLabel's substring match
// (bare `opus` is a substring of both claude-opus-5 and claude-opus-4-8).
const CLAUDE_MODELS = [
  { id: 'fable', label: 'Fable' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]
const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
]

// Effective context window (tokens) for a model, used to turn a turn's prompt
// size into a "context left" percentage (item 40). Opus, Sonnet and Fable all
// expose a 1M window; only Haiku is 200k. A flat 200k constant (the old value)
// read >100% used on the 1M models once a conversation passed 200k tokens, so
// the window has to follow the model. An unknown model (before the first
// system:init lands) defaults to 1M, since every offered model except Haiku is
// 1M - the model is also persisted per-agent now, so this is rarely hit.
function contextWindowTokens(model: string): number {
  return model.toLowerCase().includes('haiku') ? 200_000 : 1_000_000
}

// contextInputTokens sums the prompt-side tokens of a usage sample (everything
// the model had to read: fresh input + cache reads + cache writes), which is the
// size of the context the last message was sent with. Output tokens are excluded
// - they land in the NEXT turn's input, not this one's prompt.
function contextInputTokens(u: TokenUsage | undefined): number {
  if (!u) return 0
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

// modelDisplayLabel shortens a full model id ("claude-fable-5") to its alias
// label ("Fable") for the dropdown trigger.
function modelDisplayLabel(model: string): string {
  // An empty Codex model is meaningful: app-server interprets an omitted
  // model as the user's configured default and does not echo its concrete id
  // in thread lifecycle responses. Say that explicitly instead of suggesting
  // Hydra failed to load the selector state.
  if (!model) return 'Default'
  const lower = model.toLowerCase()
  for (const m of CLAUDE_MODELS) {
    if (lower.includes(m.id)) return m.label
  }
  for (const m of CODEX_MODELS) if (lower.includes(m.id)) return m.label
  return model.replace(/^claude-/, '')
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

// A step folding away shrinks the transcript by its own height, which clamps
// scrollTop down - and a scrollTop that drops on its own is exactly what a user
// scrolling up looks like. onScroll already forgives a shrink it can SEE
// (scrollHeight went down between two scroll events), but a fold overlaps with
// the next step arriving, so the two height changes can coalesce into one event
// where the height is unchanged and only scrollTop moved: read as a scroll-up,
// which unpinned the view and stopped the chat following a live turn from the
// first fold onwards. So a fold declares itself for the length of its animation
// and onScroll trusts that over the geometry.
let selfReflowUntil = 0
function markSelfReflow(ms = 400) {
  selfReflowUntil = Math.max(selfReflowUntil, Date.now() + ms)
}
function inSelfReflow(): boolean {
  return Date.now() < selfReflowUntil
}

// Expandable animates its child open/closed by transitioning a MEASURED
// max-height (0 <-> content height). We moved off the grid-rows 0fr/1fr trick
// because, with a nested scroll container inside (a CodePanel's max-h-64 <pre>),
// the grid container's height ran ahead of the resolved fr track mid-transition,
// leaving a transient empty gap below the content - the "weird" half-open frame.
// Measuring clips exactly and reveals linearly. After opening we release
// max-height to 'none' so later content growth (streamed output) isn't capped.
function Expandable({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const mounted = useDelayedUnmount(open)
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  // max-height is driven imperatively (not via React state / JSX style) so a
  // re-render from streamed content can't clobber the animated value, and to
  // avoid a synchronous setState in the layout effect.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // First commit: set the initial state without animating (before paint).
    if (first.current) {
      first.current = false
      el.style.maxHeight = open ? 'none' : '0px'
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.transition = ''
      el.style.maxHeight = open ? 'none' : '0px'
      return
    }
    el.style.transition = 'max-height 0.22s ease'
    // scrollHeight is the full content height regardless of the current clip.
    const h = el.scrollHeight
    if (open) {
      el.style.maxHeight = '0px'
      void el.offsetHeight // force reflow so the next change transitions
      el.style.maxHeight = `${h}px`
      const onEnd = (e: TransitionEvent) => {
        if (e.propertyName !== 'max-height') return
        el.style.maxHeight = 'none' // release the cap so later growth isn't clipped
        el.removeEventListener('transitionend', onEnd)
      }
      el.addEventListener('transitionend', onEnd)
      return () => el.removeEventListener('transitionend', onEnd)
    }
    // Collapsing: pin the current height, then animate to 0.
    el.style.maxHeight = `${h}px`
    void el.offsetHeight
    el.style.maxHeight = '0px'
  }, [open])
  return (
    <div ref={ref} className={className} style={{ overflow: 'hidden' }}>
      {mounted ? children : null}
    </div>
  )
}

// CodePanel renders a block of code (a Bash command, JSON input) syntax
// highlighted on the shared quiet panel.
//
// Multi-line code gets a line-number gutter (the "Code line numbers" browser
// preference, on by default): these panels wrap rather than scroll sideways, so
// without numbers a long shell line that wraps looks exactly like the next step
// of the script. A single line has nothing to disambiguate, so it stays bare.
function CodePanel({ code, lang }: { code: string; lang: string }) {
  const lineNumbers = useChatCodeLinesStore((s) => s.lineNumbers)
  const html = useMemo(() => highlightHtml(code, lang), [code, lang])
  if (lineNumbers && code.trimEnd().includes('\n')) return <NumberedCodePanel code={code} lang={lang} />

  const cls = `${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-y-auto px-2.5 py-1.5 text-stone-800 dark:text-stone-200`
  if (html != null) {
    return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre className={cls}>{code}</pre>
}

// OutputPanel renders a tool's textual output on the shared quiet panel,
// syntax highlighted when a language is known (item 3, e.g. a Read of a .ts
// file). The card border/status carries failure semantics; keeping the output
// neutral means a long mostly-successful script does not become a wall of red.
function OutputPanel({ text, lang }: { text: string; lang: string; isError?: boolean }) {
  // Code output (a Read of a known extension) is stripped of any stray ANSI and
  // syntax highlighted; terminal output (bash) keeps its ANSI colours, rendered
  // to spans. Neither path ever shows raw escape garbage.
  const html = useMemo(
    () => (lang ? highlightHtml(stripAnsi(text), lang) : hasAnsi(text) ? ansiToHtml(text) : null),
    [text, lang],
  )
  const cls = `${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-y-auto px-2.5 py-1.5 text-stone-600 dark:text-stone-300`
  if (html != null) return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />
  return <pre className={cls}>{stripAnsi(text) || '(no output)'}</pre>
}

// SHELL_STREAM_CAP bounds a running card's accumulated live output (chars): a
// runaway command streams without limit, but the DOM node must not grow forever.
// tailCap keeps the newest chars, matching the daemon's tail-capped durable copy.
const SHELL_STREAM_CAP = 200_000
function tailCap(s: string, max: number): string {
  return s.length <= max ? s : '[... earlier output truncated ...]\n' + s.slice(s.length - max)
}

// ShellCommandBash renders the command line with bash highlighting and a leading
// "$" prompt, so a "!command" card reads unmistakably as a shell command. Falls
// back to plain mono text when highlighting fails.
function ShellCommandBash({ command }: { command: string }) {
  const html = useMemo(() => highlightHtml(command, 'bash'), [command])
  return (
    <code className="min-w-0 flex-1 truncate font-mono text-xs text-stone-700 dark:text-stone-200" title={command}>
      <span className="mr-1 select-none text-[#c96442]">$</span>
      {html != null ? <span dangerouslySetInnerHTML={{ __html: html }} /> : command}
    </code>
  )
}

// ShellCommandCard renders a chat "!command" the user ran from the composer.
// It reuses the agent tool-card chrome (the same collapsible container, rotating
// chevron and Expandable open/close animation) with a shell-specific header (a
// "$" prompt + bash-highlighted command + run status), and is right-aligned like
// a user turn so it reads as something the user did, not the agent. Output
// streams in live while running (see the shell_output frame handler). The same
// output is also delivered to the agent as a user turn, so this card is the
// human-facing view of that turn rather than a plain bubble.
function ShellCommandCard({ command, output, exitCode, truncated, timedOut, stopped, running, onStop }: {
  command: string
  output: string
  exitCode?: number
  truncated?: boolean
  timedOut?: boolean
  stopped?: boolean
  running?: boolean
  onStop?: () => void
}) {
  const [open, setOpen] = useState(true)
  const failed = !running && !timedOut && !stopped && typeof exitCode === 'number' && exitCode !== 0
  const hasOutput = output.trim().length > 0
  const toggle = () => setOpen((o) => !o)
  return (
    <div className="flex justify-end">
      <div
        className={`w-full max-w-[85%] overflow-hidden rounded-lg border text-xs ${
          failed
            ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
            : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
        }`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-stone-600 dark:text-stone-300 cursor-pointer select-none hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        >
          <ChevronRight
            className={`w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <ShellCommandBash command={command} />
          {running ? (
            <span className="shrink-0 self-center flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400/90">
                <LoaderCircle className="w-3 h-3 animate-spin" /> running
              </span>
              {onStop && (
                // Only mounted while a command is actually running, so this is not
                // the per-transcript-row cost the native-title carve-out avoids.
                <Tooltip content="Stop the command">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onStop() }}
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-stone-500 hover:bg-red-500/10 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400 transition-colors cursor-pointer"
                  >
                    <CircleStop className="w-3 h-3" /> stop
                  </button>
                </Tooltip>
              )}
            </span>
          ) : timedOut ? (
            <span className="shrink-0 self-center text-[10px] font-medium text-amber-600 dark:text-amber-400">timed out</span>
          ) : stopped ? (
            <span className="shrink-0 self-center text-[10px] font-medium text-amber-600 dark:text-amber-400">stopped</span>
          ) : (
            <span className={`shrink-0 self-center text-[10px] font-medium ${failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-500'}`}>
              exit {exitCode ?? 0}
            </span>
          )}
        </div>
        <Expandable open={open}>
          <div className="px-2.5 pb-2 space-y-1.5">
            {hasOutput ? (
              <OutputPanel text={output} lang="" isError={failed} />
            ) : (
              <div className={`${PANEL_CLASS} px-2.5 py-1.5 font-mono text-[11px] italic text-stone-400 dark:text-stone-500`}>
                {running ? 'Waiting for output...' : '(no output)'}
              </div>
            )}
            {truncated && (
              <div className="px-1 text-[10px] text-stone-400 dark:text-stone-500">
                Output truncated to the last part of a longer log.
              </div>
            )}
          </div>
        </Expandable>
      </div>
    </div>
  )
}

function WebSearchOutput({ text }: { text: string }) {
  const parsed = (() => {
    const match = /(?:^|\n)Links:\s*(\[[\s\S]*?\])\s*(?:\n\n|$)/.exec(text)
    if (!match) return { body: text, links: [] as { title: string; url: string }[] }
    try {
      const links = JSON.parse(match[1]) as unknown
      if (!Array.isArray(links)) return { body: text, links: [] as { title: string; url: string }[] }
      const clean = links.filter((v): v is { title: string; url: string } =>
        !!v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string' && typeof (v as { url?: unknown }).url === 'string')
      return { body: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim(), links: clean }
    } catch {
      return { body: text, links: [] as { title: string; url: string }[] }
    }
  })()
  return (
    <div className="space-y-2 break-words leading-relaxed chat-font">
      {parsed.links.length > 0 && (
        <div className="rounded-md border border-stone-200 dark:border-white/[0.06] bg-[#fdfcf9] dark:bg-[#1d1c1a] px-2.5 py-2 font-sans">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500">Sources</div>
          <ul className="space-y-1">
            {parsed.links.map((link, i) => <li key={`${link.url}:${i}`}><a className="text-blue-600 dark:text-blue-400 hover:underline" href={link.url} target="_blank" rel="noreferrer">{link.title}</a></li>)}
          </ul>
        </div>
      )}
      {parsed.body && <Markdown text={parsed.body} />}
    </div>
  )
}

function FileChangesPanel({ changes, worktree }: { changes: unknown; worktree: string | null }) {
  if (!Array.isArray(changes)) return null
  const showFileHeaders = changes.length > 1
  return (
    <div className="space-y-1.5">
      {changes.map((raw, i) => {
        const change = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const path = typeof change.path === 'string' ? trimWorktreePaths(change.path, worktree) : `file ${i + 1}`
        const kindObj = change.kind && typeof change.kind === 'object' ? change.kind as Record<string, unknown> : null
        const kind = typeof kindObj?.type === 'string' ? kindObj.type : 'update'
        const diff = typeof change.diff === 'string' ? change.diff : ''
        const ChangeIcon = kind === 'add' ? SquarePlus : kind === 'delete' ? SquareMinus : SquareDot
        return (
          <div key={`${path}:${i}`} className="overflow-hidden rounded-md border border-stone-200 dark:border-white/[0.07]">
            {showFileHeaders && (
              <div className="flex items-center gap-1.5 border-b border-stone-200 dark:border-white/[0.07] bg-stone-50/80 dark:bg-white/[0.025] px-2.5 py-1.5">
                <FileText className="h-3 w-3 shrink-0 text-blue-500" />
                <span className="min-w-0 truncate font-medium text-stone-700 dark:text-stone-200">{path}</span>
                <ChangeIcon className={`h-3.5 w-3.5 shrink-0 ${kind === 'add' ? 'text-emerald-500' : kind === 'delete' ? 'text-red-500' : 'text-amber-500'}`} aria-label={kind} />
              </div>
            )}
            {diff && <UnifiedDiffPanel diff={diff} lang={langFromPath(path)} kind={kind} />}
          </div>
        )
      })}
    </div>
  )
}

function UnifiedDiffPanel({ diff, lang, kind }: { diff: string; lang: string; kind: string }) {
  const rows = useMemo(() => {
    // Codex uses the same field for two distinct representations: updates are
    // unified diffs, while add/delete items contain the complete file text.
    // Only unified-diff mode has a structural prefix to remove. Inferring that
    // from each line corrupts full files whose content begins with space/+/-.
    const unified = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff)
    // Plain loop (not flatMap with captured counters): the react-hooks
    // immutability rule flags reassigning closure-captured `let`s during render.
    let oldLine = kind === 'delete' ? 1 : 0
    let newLine = kind === 'add' ? 1 : 0
    const out: { text: string; added: boolean; removed: boolean; oldNo: string; newNo: string }[] = []
    for (const line of diff.replace(/\n$/, '').split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        continue
      }
      const hasAddedMarker = unified && line.startsWith('+') && !line.startsWith('+++')
      const hasRemovedMarker = unified && line.startsWith('-') && !line.startsWith('---')
      const added = kind === 'add' || hasAddedMarker
      const removed = kind === 'delete' || hasRemovedMarker
      const oldNo = added ? '' : String(oldLine++)
      const newNo = removed ? '' : String(newLine++)
      out.push({ text: (hasAddedMarker || hasRemovedMarker || (unified && line.startsWith(' '))) ? line.slice(1) : line, added, removed, oldNo, newNo })
    }
    return out
  }, [diff, kind])
  const highlighted = useMemo(() => highlightLines(rows.map((r) => r.text).join('\n'), lang || 'plaintext'), [rows, lang])
  return (
    <div className="bg-white dark:bg-[#20201e] font-mono text-[11px] leading-4">
      {rows.map((row, i) => (
        <div key={i} className={`grid ${kind === 'add' || kind === 'delete' ? 'grid-cols-[2.25rem_1fr]' : 'grid-cols-[2.25rem_2.25rem_1fr]'} ${row.added ? 'bg-emerald-50 dark:bg-emerald-950/25' : row.removed ? 'bg-red-50 dark:bg-red-950/25' : ''}`}>
          {kind !== 'add' && <span className="select-none border-r border-stone-200/70 dark:border-white/[0.05] px-1 text-right text-stone-400 dark:text-stone-600">{row.oldNo}</span>}
          {kind !== 'delete' && <span className="select-none border-r border-stone-200/70 dark:border-white/[0.05] px-1 text-right text-stone-400 dark:text-stone-600">{row.newNo}</span>}
          <span className={`min-w-0 whitespace-pre-wrap break-words px-2 ${row.added ? 'text-emerald-900 dark:text-emerald-200' : row.removed ? 'text-red-900 dark:text-red-200' : 'text-stone-700 dark:text-stone-300'}`} dangerouslySetInnerHTML={{ __html: highlighted[i] ?? '' }} />
        </div>
      ))}
    </div>
  )
}

// GutterCodePanel renders code lines beside a line-number gutter, one grid row
// per source line so a long line WRAPS under its own number instead of scrolling
// the whole block sideways. Highlighting runs over the whole body (multi-line
// constructs colourise correctly) and is split back into per-line HTML
// (highlightLines, which falls back to escaped plain lines for an unknown lang).
function GutterCodePanel({ nums, code, lang }: { nums: string[]; code: string[]; lang: string }) {
  const lines = useMemo(() => highlightLines(code.join('\n'), lang || 'plaintext'), [code, lang])
  return (
    <div className={`${PANEL_CLASS} max-h-64 overflow-y-auto py-1.5`}>
      {/* data-copy-code / data-copy-line: the rows are grid cells, not block
          elements, so nothing in this panel tells a copy where the lines end -
          the chat's copy-as-markdown handler would hand over the whole script
          on one line. See lib/copyMarkdown. */}
      <div data-copy-code className="grid grid-cols-[auto_1fr] text-[11px] leading-4 font-mono">
        {nums.map((n, i) => (
          <Fragment key={i}>
            {/* min-h keeps an empty line (blank code, blank gutter) one row tall. */}
            <span className="min-h-4 select-none text-right px-2 text-stone-400 dark:text-stone-600 border-r border-stone-200 dark:border-white/[0.06]">{n}</span>
            <span data-copy-line className="min-w-0 whitespace-pre-wrap break-words px-2.5 text-stone-800 dark:text-stone-200" dangerouslySetInnerHTML={{ __html: lines[i] ?? '' }} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

// NumberedCodePanel renders code with a 1..N line-number gutter and syntax
// highlighting - the shape a Read shows - used for a Write tool's file content.
function NumberedCodePanel({ code, lang }: { code: string; lang: string }) {
  const body = code.replace(/\n$/, '')
  const parts = useMemo(() => {
    const lines = body.split('\n')
    return { nums: lines.map((_, i) => String(i + 1)), code: lines }
  }, [body])
  return <GutterCodePanel nums={parts.nums} code={parts.code} lang={lang} />
}

// ReadOutputPanel renders a Read's `cat -n` output (each line prefixed with its
// file line number + a tab) as a proper neutral line-number gutter plus syntax-
// highlighted code. The numbers are split OUT of the code before highlighting, so
// the highlighter can't colour them as numeric literals (item 43: the file line
// numbers rendered in the "number" token colour instead of a plain gutter). The
// gutter shows the file's REAL line numbers (honouring a Read offset), not 1..N.
// Falls back to the plain OutputPanel when the text isn't the cat -n shape.
function ReadOutputPanel({ text, lang }: { text: string; lang: string }) {
  const parsed = useMemo(() => {
    const lines = text.replace(/\n$/, '').split('\n')
    const nums: string[] = []
    const code: string[] = []
    let matched = 0
    for (const l of lines) {
      const m = /^\s{0,6}(\d+)\t(.*)$/.exec(l)
      if (m) { nums.push(m[1]); code.push(m[2]); matched++ } else { nums.push(''); code.push(l) }
    }
    return { nums, code, ok: lines.length > 0 && matched > lines.length / 2 }
  }, [text])
  if (!parsed.ok) return <OutputPanel text={text} lang={lang} />
  return <GutterCodePanel nums={parsed.nums} code={parsed.code} lang={lang} />
}

// FileViewBody renders one file view's slice of a read-shaped shell command's
// output (see lib/fileViewCommand): the file's own line numbers in the gutter,
// highlighted by its extension. A `cat -n` brings its numbers with it, and a
// plain `tail` knows no line numbers at all - it still gets the highlighting.
function FileViewBody({ section }: { section: FileViewSection }) {
  const lang = langFromPath(section.path)
  const text = section.lines.join('\n')
  if (section.lines.length === 0) return <OutputPanel text="" lang="" />
  if (section.numbered) return <ReadOutputPanel text={text} lang={lang} />
  if (section.start == null) return <OutputPanel text={text} lang={lang} />
  const start = section.start
  return <GutterCodePanel nums={section.lines.map((_, i) => String(start + i))} code={section.lines} lang={lang} />
}

// FileViewSections renders the file content a read-shaped shell command printed,
// one block per file it looked at. Each block is captioned with the step that
// produced it: the card header calls this a Read, so the command it is really a
// Read of belongs where you can see it without opening the Raw JSON - and with
// several files in one call, that caption is also what tells them apart.
function FileViewSections({ sections }: { sections: FileViewSection[] }) {
  return (
    <div className="space-y-1.5">
      {sections.map((section, i) => (
        <div key={i}>
          {/* Plain non-interactive truncated text: native title is the right
              tool here (see the tooltip conventions in CLAUDE.md). */}
          <div
            className="mb-0.5 truncate font-mono text-[10px] text-stone-400 dark:text-stone-500 select-none"
            title={section.command}
          >
            {section.command}
          </div>
          <FileViewBody section={section} />
        </div>
      ))}
    </div>
  )
}

// One rendered line of a shell script's sectioned output.
interface ScriptOutputRow {
  // The line's number in the file it came from ('' when it has none).
  num: string
  // The line's content, already highlighted.
  html: string
  // The `path:` a multi-file search printed in front of the line, shown lowlit
  // so the file it names does not read as part of the line's code.
  prefix?: string
  // 'code' is a line of some file, 'marker' a separator the script echoed, and
  // 'plain' output nothing could be said about.
  tone: 'code' | 'marker' | 'plain'
}

// scriptMatchRows renders a search's output: the file line numbers grep printed
// in the gutter, the rest highlighted as the file it came from. Consecutive
// lines from the SAME file are highlighted together - a search prints
// non-contiguous lines, so this is as much context as the highlighter can
// honestly be given, and it keeps a multi-file search from colouring one file's
// lines by another's language.
function scriptMatchRows(section: Extract<ScriptSection, { kind: 'matches' }>): ScriptOutputRow[] {
  const only = section.match.paths.length === 1 ? section.match.paths[0] : ''
  const rows: ScriptOutputRow[] = []
  let run: MatchLine[] = []
  let runLang = ''
  const flush = () => {
    if (run.length === 0) return
    const html = highlightLines(run.map((l) => l.text).join('\n'), runLang || 'plaintext')
    run.forEach((l, i) => rows.push({ num: l.num, html: html[i] ?? '', prefix: l.path || undefined, tone: 'code' }))
    run = []
  }
  for (const line of parseMatchLines(section.lines, section.match.paths)) {
    if (line.separator) {
      flush()
      rows.push({ num: '', html: '', tone: 'plain' })
      continue
    }
    const lang = langFromPath(line.path || only)
    if (lang !== runLang) flush()
    runLang = lang
    run.push(line)
  }
  flush()
  return rows
}

// scriptOutputRows turns the sections of a shell script's output (lib/
// shellSections) into the rows the panel below renders: file content highlighted
// by its own extension and numbered by its own line numbers, the script's `echo`
// separators coloured as the strings they are, and anything unattributed left as
// the plain terminal text it was.
function scriptOutputRows(sections: ScriptSection[]): ScriptOutputRow[] {
  const rows: ScriptOutputRow[] = []
  for (const section of sections) {
    if (section.kind === 'matches') {
      rows.push(...scriptMatchRows(section))
      continue
    }
    if (section.kind !== 'view') {
      // 'plaintext' is not a grammar, so this is just the escaped lines - which
      // is what both a separator and unattributable output want.
      const escaped = highlightLines(section.lines.join('\n'), 'plaintext')
      const marker = section.kind === 'marker'
      escaped.forEach((html) => rows.push({
        num: '',
        html: marker ? `<span class="token string">${html}</span>` : html,
        tone: marker ? 'marker' : 'plain',
      }))
      continue
    }
    const view = section.view
    // A `cat -n` brought its own numbers; a range knows where it started; a
    // plain `tail` counts back from an end nothing here knows, so it gets the
    // highlighting without the gutter.
    const nums: string[] = []
    const code: string[] = []
    for (const line of section.lines) {
      const numbered = view.numbered ? /^\s{0,6}(\d+)\t(.*)$/.exec(line) : null
      nums.push(numbered ? numbered[1] : view.start != null && !view.numbered ? String(view.start + code.length) : '')
      code.push(numbered ? numbered[2] : line)
    }
    const html = highlightLines(code.join('\n'), langFromPath(view.path) || 'plaintext')
    nums.forEach((num, i) => rows.push({ num, html: html[i] ?? '', tone: 'code' }))
  }
  return rows
}

// ScriptOutputPanel renders a Bash step's output as the sections its own script
// produced (see lib/shellSections) instead of as one anonymous wall of terminal
// text: each stretch highlighted as the file it came from, numbered by that
// file's line numbers, with the `echo` separators between them coloured as the
// strings the script printed.
//
// It stays ONE panel with one scrollbar - this is still the command's output,
// read top to bottom - and the gutter column only appears when some line in it
// actually has a number to show.
function ScriptOutputPanel({ sections }: { sections: ScriptSection[] }) {
  const rows = useMemo(() => scriptOutputRows(sections), [sections])
  const gutter = rows.some((r) => r.num !== '')
  return (
    <div className={`${PANEL_CLASS} max-h-64 overflow-y-auto py-1.5`}>
      {/* data-copy-code / data-copy-line: the rows are grid cells, not block
          elements, so without them a copy hands over every line run together
          (see lib/copyMarkdown). */}
      <div data-copy-code className={`grid ${gutter ? 'grid-cols-[auto_1fr]' : 'grid-cols-[1fr]'} text-[11px] leading-4 font-mono`}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {/* min-h keeps an empty line (blank code, blank gutter) one row tall. */}
            {gutter && (
              <span className="min-h-4 select-none text-right px-2 text-stone-400 dark:text-stone-600 border-r border-stone-200 dark:border-white/[0.06]">{row.num}</span>
            )}
            <span
              data-copy-line
              className={`min-w-0 min-h-4 whitespace-pre-wrap break-words px-2.5 ${row.tone === 'plain' ? 'text-stone-600 dark:text-stone-300' : 'text-stone-800 dark:text-stone-200'}`}
            >
              {row.prefix && <span className="text-stone-400 dark:text-stone-500">{row.prefix}:</span>}
              <span dangerouslySetInnerHTML={{ __html: row.html }} />
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

// EditDiffPanel shows an Edit as a unified diff instead of two disembodied
// blobs: lines the edit leaves alone are context, the rest are -/+ rows, and
// the characters that actually changed are marked with the same word-diff
// highlight the diff viewer uses (lib/wordDiff).
//
// The rows come from the CLI's own patch when the result carried one - which is
// what puts the file's REAL line numbers in the gutter and adds the few lines
// of surrounding context the agent never quoted. While the call is still
// running (or against a provider that sends no patch) the two strings are
// diffed here instead and the gutter is dropped: nothing in a fragment says
// where in the file it sits, and 1..N numbers would be a lie. See lib/editDiff.
//
// A "replace all" chip surfaces the replace_all flag.
const EDIT_NUM_CLASS = 'min-h-4 select-none text-right pr-1.5 text-stone-400 dark:text-stone-600 border-r border-stone-200 dark:border-white/[0.06]'
function EditDiffPanel({ oldStr, newStr, lang, replaceAll, hunks }: { oldStr: string; newStr: string; lang: string; replaceAll?: boolean; hunks?: EditHunk[] | null }) {
  const rows = useMemo(() => buildEditRows(oldStr, newStr, hunks), [oldStr, newStr, hunks])
  const numbered = useMemo(() => hasLineNumbers(rows), [rows])
  // Each side is highlighted as ONE run of code, not line by line, so a
  // multi-line construct (a block comment, a template string) colourises
  // correctly - and each side is reassembled whole (context lines belong to
  // both) so neither is highlighted as if the other side's lines were missing.
  const html = useMemo(() => {
    const oldSrc: string[] = []
    const newSrc: string[] = []
    const pick = rows.map((r) => {
      if (r.type !== 'add') oldSrc.push(r.content)
      if (r.type !== 'del') newSrc.push(r.content)
      return r.type === 'del' ? oldSrc.length - 1 : newSrc.length - 1
    })
    const oldLines = highlightLines(oldSrc.join('\n'), lang || 'plaintext')
    const newLines = highlightLines(newSrc.join('\n'), lang || 'plaintext')
    return rows.map((r, i) => (r.type === 'del' ? oldLines[pick[i]] : newLines[pick[i]]) ?? '')
  }, [rows, lang])
  return (
    <div className="space-y-1">
      {replaceAll && (
        <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400/90 select-none">replace all</div>
      )}
      <div className={`${PANEL_CLASS} max-h-64 overflow-auto py-1.5`}>
        {/* data-copy-code / data-copy-line: grid cells are not block elements,
            so without them a copy hands over every line run together (see
            lib/copyMarkdown). The -/+ marker sits INSIDE the copied cell and
            the line numbers outside it, so what you copy is a diff you can
            paste, not a column of numbers. */}
        <div data-copy-code className={`grid ${numbered ? 'grid-cols-[auto_auto_1fr]' : 'grid-cols-[1fr]'} text-[11px] leading-4 font-mono`}>
          {rows.map((row, i) => {
            if (row.type === 'gap') {
              return (
                <span key={i} className="col-span-full select-none px-2 text-stone-400 dark:text-stone-600 border-y border-stone-200/70 dark:border-white/[0.06] my-0.5">
                  ...
                </span>
              )
            }
            const isAdd = row.type === 'add'
            const isDel = row.type === 'del'
            const bg = isAdd ? 'bg-green-50 dark:bg-green-500/15' : isDel ? 'bg-red-50 dark:bg-red-500/15' : ''
            const marker = isAdd ? '+' : isDel ? '-' : ' '
            const markerCls = isAdd ? 'text-green-600 dark:text-green-400' : isDel ? 'text-red-600 dark:text-red-400' : 'text-stone-300 dark:text-stone-700'
            const code = row.ranges?.length
              ? renderWordDiffHtml(html[i], row.content, row.ranges, isAdd ? WORD_ADD_CLASS : WORD_DEL_CLASS)
              : html[i]
            return (
              <Fragment key={i}>
                {numbered && (
                  <>
                    {/* Each number column carries its own right-hand rule, so
                        the old and new sides are separated the same way the
                        diff viewer's unified gutter separates them (see
                        UNIFIED_LINE_NUM_CLASS). min-h keeps a blank line one
                        row tall. */}
                    <span className={`${EDIT_NUM_CLASS} pl-2 ${bg}`}>{row.oldNum ?? ''}</span>
                    <span className={`${EDIT_NUM_CLASS} pl-1.5 ${bg}`}>{row.newNum ?? ''}</span>
                  </>
                )}
                <span data-copy-line className={`min-w-0 whitespace-pre-wrap break-words pl-1.5 pr-2 text-stone-800 dark:text-stone-200 ${bg}`}>
                  <span className={`select-none mr-1 ${markerCls}`}>{marker}</span>
                  <span dangerouslySetInnerHTML={{ __html: code }} />
                </span>
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// parseMemory splits a memory Read's result into its point-in-time reminder,
// its YAML frontmatter, and its markdown body - stripping the cat -n line-number
// gutter the Read tool adds ("     1\t---" -> "---").
function parseMemory(raw: string): { reminder: string | null; yaml: string; body: string } {
  let text = raw
  let reminder: string | null = null
  const m = text.match(/<system-reminder>([\s\S]*?)<\/system-reminder>\s*/i)
  if (m) {
    reminder = m[1].trim()
    text = (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length))
  }
  // Drop the line-number prefix ("<up to 6 spaces>N\t") each Read line carries.
  text = text
    .split('\n')
    .map((l) => l.replace(/^\s{0,6}\d+\t/, ''))
    .join('\n')
    .trim()
  let yaml = ''
  let body = text
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    yaml = fm[1]
    body = text.slice(fm[0].length).trim()
  }
  return { reminder, yaml, body }
}

// MemoryPanel renders a Claude auto-memory Read nicely (item: memory cards): the
// point-in-time <system-reminder> as a callout under the header, the YAML
// frontmatter as a highlighted code box, and the body as normal markdown prose -
// no line-number gutter.
function MemoryPanel({ text }: { text: string }) {
  const { reminder, yaml, body } = useMemo(() => parseMemory(text), [text])
  const yamlHtml = useMemo(() => (yaml ? highlightHtml(yaml, 'yaml') : null), [yaml])
  const codeCls = `${PANEL_CLASS} whitespace-pre-wrap break-words font-mono text-[11px] leading-4 max-h-64 overflow-auto px-2.5 py-1.5 text-stone-800 dark:text-stone-200`
  return (
    <div className="space-y-2">
      {reminder && (
        <div className="flex gap-1.5 rounded-md border border-amber-200/70 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200/90">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>{reminder}</span>
        </div>
      )}
      {yaml && (
        yamlHtml != null
          ? <pre className={codeCls} dangerouslySetInnerHTML={{ __html: yamlHtml }} />
          : <pre className={codeCls}>{yaml}</pre>
      )}
      {body && (
        <div className="break-words leading-relaxed chat-font">
          <Markdown text={body} />
        </div>
      )}
    </div>
  )
}

// LabeledField is a small label over a value block - the shape the
// Output panel header uses, reused for the Task tool's subject/description/output.
function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">{label}</div>
      {children}
    </div>
  )
}

// TaskToolFields renders a TaskCreate / TaskUpdate input as labeled fields -
// subject and description as markdown prose - instead of raw JSON. A TaskUpdate's
// id/status ride on a compact line above.
function TaskToolFields({ input }: { input: Record<string, unknown> }) {
  const taskId = typeof input.taskId === 'string' || typeof input.taskId === 'number' ? String(input.taskId) : ''
  const status = typeof input.status === 'string' ? (input.status as string) : ''
  const subject = typeof input.subject === 'string' ? (input.subject as string) : ''
  const description = typeof input.description === 'string' ? (input.description as string) : ''
  const proseCls = 'break-words leading-relaxed chat-font'
  return (
    <div className="space-y-1.5">
      {(taskId || status) && (
        <div className="text-[11px] text-stone-500 dark:text-stone-400">
          {taskId && <span className="font-medium">#{taskId}</span>}
          {status && <span>{taskId ? ' -> ' : ''}{status}</span>}
        </div>
      )}
      {subject && (
        <LabeledField label="Subject"><div className={proseCls}><Markdown text={subject} /></div></LabeledField>
      )}
      {description && (
        <LabeledField label="Description"><div className={proseCls}><Markdown text={description} /></div></LabeledField>
      )}
    </div>
  )
}

// gitAddSpecs narrows a git_add `files` array to the {path, ranges} entries the
// tool actually accepts, so both the header summary and the field panel read it
// the same way.
function gitAddSpecs(input: Record<string, unknown>): { path: string; lines: string[] }[] {
  const files = Array.isArray(input.files) ? input.files : []
  return files.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const spec = raw as Record<string, unknown>
    const path = typeof spec.path === 'string' ? spec.path : ''
    if (!path) return []
    const ranges = Array.isArray(spec.ranges) ? spec.ranges : []
    const lines = ranges
      .map((range) => (Array.isArray(range) ? (range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`) : ''))
      .filter(Boolean)
    return [{ path, lines }]
  })
}

// GitToolFields renders an mcp__hydra__git_* input as the operation it describes
// instead of raw JSON. The commit message gets a real text box - it is prose the
// agent wrote and the single most-read part of the card - and the staging mode is
// stated outright, because "which of my changes did that actually capture?" is
// the question the JSON never answered: `git add -A` is the default, so the
// interesting cases (a path list, or a pre-built index) have to be visible.
function GitToolFields({ tool, input, worktree }: { tool: string; input: Record<string, unknown>; worktree: string | null }) {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const strs = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
  const path = (p: string) => collapseHome(trimWorktreePaths(p, worktree))
  const note = 'text-[11px] text-stone-500 dark:text-stone-400'
  const sha = (value: string) => <span className="font-mono text-[11px] text-stone-600 dark:text-stone-300">{value}</span>

  // A "- " bulleted path row. LowlitPath is a FRAGMENT of two spans (dir + name),
  // so it must sit inside its own element: dropping it straight into a flex row
  // makes the gap apply BETWEEN the directory and the filename.
  const bullet = (key: string, body: ReactNode) => (
    <div key={key} className="flex items-baseline gap-1.5">
      <span className="select-none text-stone-400 dark:text-stone-500">-</span>
      {body}
    </div>
  )

  if (tool === 'git_commit') {
    const paths = strs('paths')
    // What the commit captured, stated as fact - but only when it wasn't the
    // default. `git add -A` is what the tool does unless told otherwise, so
    // saying so on every commit is noise; the interesting cases (a path list, or
    // a pre-built index) still get a line.
    const staging = input.staged === true
      ? 'Committed the already-staged changes; nothing else was staged'
      : paths.length > 0
        ? 'Staged only the paths below, then committed'
        : ''
    return (
      <div className="space-y-1.5">
        {staging && <div className={note}>{staging}</div>}
        {/* No label: a commit message is the obvious content of a commit card,
            and the panel already frames it. Rendered as markdown with paragraph
            reflow (hardBreaks={false}) - messages are hard-wrapped at ~72
            columns, so a <br> per source newline would shred every paragraph. */}
        <div className={`${PANEL_CLASS} break-words px-2.5 py-1.5 text-[11px] leading-relaxed text-stone-700 dark:text-stone-200 chat-font`}>
          <Markdown text={str('message')} hardBreaks={false} />
        </div>
        {paths.length > 0 && (
          <div className="space-y-0.5">{paths.map((p) => bullet(p, <span><LowlitPath path={path(p)} /></span>))}</div>
        )}
      </div>
    )
  }

  if (tool === 'git_add') {
    // Multi-file only - a single-file add says everything in its header, so the
    // card hides this panel entirely rather than repeating it (see gitAddSimple).
    const specs = gitAddSpecs(input)
    return (
      <div className="space-y-0.5">
        {specs.map((s) =>
          bullet(
            s.path,
            <span>
              <LowlitPath path={path(s.path)} />
              {s.lines.length > 0 && (
                <span className="ml-1.5 font-mono text-[10px] text-stone-500 dark:text-stone-400">lines {s.lines.join(', ')}</span>
              )}
            </span>,
          ),
        )}
      </div>
    )
  }

  if (tool === 'git_reset') {
    const unstage = strs('unstage')
    if (unstage.length > 0) {
      return (
        <div className="space-y-1.5">
          <div className={note}>Unstaged these paths; the branch did not move</div>
          <div className="space-y-0.5">{unstage.map((p) => bullet(p, <span><LowlitPath path={path(p)} /></span>))}</div>
        </div>
      )
    }
    const mode = str('mode') || 'soft'
    const modeNote: Record<string, string> = {
      soft: 'changes kept, still staged',
      mixed: 'changes kept, unstaged',
      hard: 'uncommitted changes discarded',
    }
    return (
      <div className={note}>
        Moved the branch to {sha(str('to') || 'HEAD')} &middot; {modeNote[mode] ?? mode}
      </div>
    )
  }

  if (tool === 'git_revert' || tool === 'git_cherry_pick') {
    return (
      <div className={note}>
        {tool === 'git_revert' ? <>Added a new commit undoing {sha(str('commit'))}</> : <>Applied {sha(str('commit'))} as a new commit</>}
      </div>
    )
  }

  if (tool === 'git_stash') {
    const op = str('op') || 'push'
    const entry = str('ref') || 'stash@{0}'
    const note2 = {
      push: <>Set the uncommitted changes aside; the worktree is now clean</>,
      pop: <>Restored {entry} and removed the entry</>,
      apply: <>Restored {entry}, keeping the entry</>,
      drop: <>Discarded {entry}</>,
      list: <>Listed this head&rsquo;s stash entries</>,
    }[op]
    return (
      <div className={note}>
        {note2 ?? <>Stash {op}</>}
        {op !== 'list' ? <> &middot; private to this head</> : null}
      </div>
    )
  }

  if (tool === 'git_merge') {
    // Direction is the thing worth stating: the tool only ever merges INTO this
    // head's branch, never the other way, so name both ends.
    return (
      <div className={note}>
        Merged {sha(str('ref'))} into this branch
        {input.no_ff === true ? <> &middot; forced a merge commit</> : null}
      </div>
    )
  }

  if (tool === 'git_rebase') {
    const plan = Array.isArray(input.plan) ? input.plan : []
    return (
      <div className="space-y-1.5">
        <div className={note}>Rewrote {plan.length} commit{plan.length === 1 ? '' : 's'} above {sha(str('base'))}</div>
        <div className="space-y-0.5">
          {plan.map((raw, index) => {
            const step = (raw ?? {}) as Record<string, unknown>
            const message = typeof step.message === 'string' ? step.message.split('\n')[0] : ''
            return bullet(
              `${String(step.commit)}:${index}`,
              <span className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
                <span className="font-medium text-stone-600 dark:text-stone-300">{String(step.action ?? '')}</span>
                {sha(String(step.commit ?? ''))}
                {message && <span className="truncate text-stone-500 dark:text-stone-400 chat-font">{message}</span>}
              </span>,
            )
          })}
        </div>
      </div>
    )
  }
  return null
}

// AgentChip is the recipient of a SendMessage - the sub-agent's label (and its
// short id) as a pill that opens that agent's chat when we can resolve it.
function AgentChip({
  label,
  id,
  running,
  onOpenChat,
}: {
  label: string
  id: string
  running?: boolean
  onOpenChat?: () => void
}) {
  const body = (
    <>
      <Bot className="w-3 h-3 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
      <span className="truncate">{label}</span>
      {id && <span className="shrink-0 font-mono text-[10px] text-stone-400 dark:text-stone-500">{id.slice(0, 8)}</span>}
      {running && <LoaderCircle className="w-3 h-3 shrink-0 animate-spin text-violet-500/80 dark:text-violet-400/80" />}
      {onOpenChat && <MessageSquare className="w-3 h-3 shrink-0" />}
    </>
  )
  const cls =
    'flex max-w-full items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2 py-0.5 text-[11px] text-stone-500 dark:text-stone-400'
  return onOpenChat ? (
    <button
      onClick={(e) => { e.stopPropagation(); onOpenChat() }}
      className={`${cls} cursor-pointer hover:text-stone-700 dark:hover:text-stone-200`}
      title="Open this agent's chat"
    >
      {body}
    </button>
  ) : (
    <span className={`${cls} select-none`}>{body}</span>
  )
}

// SendMessageFields renders a SendMessage input as who it went to plus the
// message itself, as prose - the raw JSON (with its echoed recipient/content
// duplicates) said the same thing three times and buried the actual message.
function SendMessageFields({
  input,
  recipientLabel,
  recipientId,
  recipientRunning,
  onOpenChat,
}: {
  input: Record<string, unknown>
  recipientLabel: string
  recipientId: string
  recipientRunning?: boolean
  onOpenChat?: () => void
}) {
  const message = typeof input.message === 'string' ? input.message : typeof input.content === 'string' ? input.content : ''
  const summary = typeof input.summary === 'string' ? input.summary : ''
  // Anything the tool carried beyond the fields rendered below (and the echoed
  // duplicates) still shows, so a new field never silently disappears.
  const extra = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !SEND_MESSAGE_ECHO_KEYS.has(key) && key !== 'to' && key !== 'summary' && key !== 'message' && !key.startsWith('_'),
    ),
  )
  const proseCls = 'break-words leading-relaxed chat-font'
  return (
    <div className="space-y-1.5">
      {recipientId && (
        <LabeledField label="To">
          <AgentChip label={recipientLabel} id={recipientId} running={recipientRunning} onOpenChat={onOpenChat} />
        </LabeledField>
      )}
      {summary && (
        <LabeledField label="Summary"><div className={proseCls}><Markdown text={summary} /></div></LabeledField>
      )}
      {message && (
        <LabeledField label="Message">
          <div className={`${PANEL_CLASS} px-2.5 py-1.5 ${proseCls} text-stone-700 dark:text-stone-200`}>
            <Markdown text={message} />
          </div>
        </LabeledField>
      )}
      {Object.keys(extra).length > 0 && <CodePanel code={JSON.stringify(extra, null, 2)} lang="json" />}
    </div>
  )
}

// SendMessageOutcome renders the tool's JSON reply as the one line it means:
// whether the message landed, and (when it resumed a finished agent) a way into
// that agent's chat to watch it work.
function SendMessageOutcome({
  result,
  recipientRunning,
  onOpenChat,
}: {
  result: SendMessageResult
  recipientRunning?: boolean
  onOpenChat?: () => void
}) {
  return (
    <div className={`${PANEL_CLASS} px-2.5 py-1.5 space-y-1`}>
      <div className="flex items-start gap-1.5">
        {result.ok ? (
          <Check className="w-3.5 h-3.5 shrink-0 mt-px text-emerald-600/80 dark:text-emerald-400/80" />
        ) : (
          <X className="w-3.5 h-3.5 shrink-0 mt-px text-red-500 dark:text-red-400" />
        )}
        <span className="break-words leading-relaxed text-stone-700 dark:text-stone-200">
          {result.message || (result.ok ? 'Message delivered.' : 'Message failed.')}
        </span>
      </div>
      {result.resumed && onOpenChat && (
        <button
          onClick={onOpenChat}
          className="flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
        >
          {recipientRunning && <LoaderCircle className="w-3 h-3 animate-spin text-violet-500/80 dark:text-violet-400/80" />}
          <span>{recipientRunning ? 'Working - open its chat' : 'Open its chat'}</span>
          <MessageSquare className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

// GitMark is git's own logo, which lucide does not carry - the simple-icons set
// does (the same one the forge marks come from, see ProviderIcon). title=""
// suppresses the SVG <title> ("Git") those marks render by default: that is a
// native OS tooltip, and the card header it sits in is interactive.
function GitMark({ className }: { className?: string }) {
  return <SiGit className={className} title="" aria-hidden />
}

// Per-tool icons for the card header; anything unlisted gets the wrench. Typed
// by the props actually passed below rather than as a lucide icon, so a
// simple-icons mark (GitMark) fits the same map.
const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
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
  SendMessage: Send,
  TaskCreate: ListPlus,
  TaskUpdate: ListChecks,
  UpdatePlan: ListChecks,
  // The git tools are keyed by raw name (see GIT_TOOL_LABELS); a generic wrench
  // gives no hint that the card rewrote the branch.
  mcp__hydra__git_commit: GitMark,
  mcp__hydra__git_add: GitMark,
  mcp__hydra__git_reset: GitMark,
  mcp__hydra__git_revert: GitMark,
  mcp__hydra__git_cherry_pick: GitMark,
  mcp__hydra__git_rebase: GitMark,
  mcp__hydra__git_rebase_continue: GitMark,
  mcp__hydra__git_rebase_abort: GitMark,
  mcp__hydra__git_merge: GitMerge,
  mcp__hydra__git_merge_continue: GitMerge,
  mcp__hydra__git_merge_abort: GitMerge,
  mcp__hydra__git_stash: Archive,
}

function LowlitPath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  return <>{dir && <span className="text-stone-400/70 dark:text-stone-500/70">{dir}</span>}<span className="text-stone-400 dark:text-stone-500">{name}</span></>
}

// memo'd so composer keystrokes (a sibling state change) don't re-render every
// tool card in the transcript (item 16). Props are stable per settled item.
// recipient* / openSub describe a SendMessage's target agent. They are passed
// as primitives (plus the stable openSubView callback) so the memo comparison
// still holds - an object prop would re-render every card on each parent render.
const ToolCard = memo(function ToolCard({
  item,
  worktree,
  shellCwd = null,
  recipientId = '',
  recipientLabel = '',
  recipientRunning = false,
  openSub,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  worktree: string | null
  // The directory this command ran in, tracked across the session's shell (see
  // lib/shellCwd) - null when it isn't known.
  shellCwd?: string | null
  recipientId?: string
  recipientLabel?: string
  recipientRunning?: boolean
  openSub?: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [imgLightbox, setImgLightbox] = useState<number | null>(null)
  // The thumbnail clicked, so the lightbox flies the picture out of it.
  const [imgOrigin, setImgOrigin] = useState<Element | null>(null)
  // Eagerly decode result images (the card mounts collapsed the moment the
  // result lands), so opening later measures the true expanded height.
  const imageDims = useImageDims(item.resultImages)
  const pending = item.result === undefined && !item.ended
	const visibleResult = item.result ?? item.runningOutput
  const rawInput = (typeof item.input === 'object' && item.input !== null ? item.input : null) as
    | Record<string, unknown>
    | null
	const input = useMemo(() => {
		if (!rawInput || (!('_raw' in rawInput) && !('_raw_events' in rawInput))) return rawInput
		const visible = { ...rawInput }
		delete visible._raw
		delete visible._raw_events
		return visible
	}, [rawInput])
  const command = typeof input?.command === 'string' ? (input.command as string) : ''
	const commandCwd = typeof input?.cwd === 'string' ? input.cwd : ''
  // The host_run MCP tool is the escape hatch's first-class form: its `command`
  // IS the host command, with no shell of the agent's in between (which is what
  // the `hydra host-run` CLI spelling could never guarantee). It renders as a
  // Bash-shaped card because that is what it is - one shell command - it just
  // runs somewhere else.
  const isHostRunTool = item.name === 'mcp__hydra__host_run' && command !== ''
  const isBash = (item.name === 'Bash' && command !== '') || isHostRunTool
  // `hydra host-run` is the same escape hatch typed into Bash: the agent is not
  // running this itself, it is asking the USER to run it on the host. Show the
  // command it is asking for rather than the CLI wrapper it typed, and give the
  // card its own host identity (see the header) so it never reads as an
  // ordinary Bash step.
  const hostRunScript = isHostRunTool ? command : item.name === 'Bash' ? parseHostRunScript(command) : null
  const isHostRun = hostRunScript !== null
  // The host command runs in the head's worktree whatever the agent's own cwd
  // was, so a `cd` preamble would be a lie - drop it for a host run.
  //
  // Worktree paths are trimmed BEFORE formatting, not just on the way to the
  // panel: agents habitually open a script with `cd <the worktree>`, which trims
  // to the no-op `cd .` - and only the formatter knows that a no-op cd (and the
  // `&&` chaining it) is noise worth dropping.
  const bashSource = trimWorktreePaths(hostRunScript ?? command, worktree)
  const bashIndent = useChatBashIndentStore((s) => s.indent)
  // The directory the command ran in, as a `cd` line above the script. The
  // agent's shell persists across its whole session, so the tracked directory
  // (lib/shellCwd) is often nowhere near the worktree - and a command reads
  // completely differently depending on where it ran: `cd web && node x.ts`
  // fails in web/ and works at the root. Shown only when it differs from the
  // worktree, is known, and the script does not immediately set it itself; a
  // host run always runs in the worktree whatever the agent's shell is doing.
  //
  // A command that OPENS with `cd <the worktree>` pins itself there, so the
  // shell's directory does not matter and nothing is prepended. That leading cd
  // trims to `cd .` and is dropped as noise - but a `cd .` the agent wrote
  // literally (Codex, whose `.` means the cwd it reported) is a different thing
  // and still gets its reported directory shown.
  const rawSource = unwrapBashLoginCommand(hostRunScript ?? command)
  const pinnedToWorktree = dropNoopCd(bashSource) !== bashSource && !/^[ \t]*cd[ \t]+(['"]?)\.\/?\1[ \t]*(?:&&|;|\n)/.test(rawSource)
  const effectiveCwd = commandCwd || shellCwd || ''
  const cwdPreamble =
    isHostRun || pinnedToWorktree || !effectiveCwd || effectiveCwd === worktree
      ? ''
      : collapseHome(trimWorktreePaths(effectiveCwd, worktree))
  const displayedCommand = isBash ? formatBashForDisplay(bashSource, cwdPreamble, bashIndent) : ''
  const executableCommand = isBash ? formatBashForDisplay(bashSource, '', bashIndent) : ''
  const interactiveTranscript = isBash && !isHostRunTool && visibleResult !== undefined ? interactiveShellTranscript(executableCommand, visibleResult) : null
  const visibleCommand = interactiveTranscript?.command ?? displayedCommand
  const renderedResult = interactiveTranscript?.output ?? visibleResult
  const description = isHostRunTool
    ? typeof input?.why === 'string'
      ? (input.why as string)
      : ''
    : isBash && typeof input?.description === 'string'
      ? (input.description as string)
      : ''

  // A Bash step that only LOOKS at files (`sed -n 40,110p f`, `cat f`, `head
  // -50 f`) is a Read spelled in shell - the shape every agent without a Read
  // tool has to use. Such a card takes the Read presentation: the file and its
  // line range in the header, and the output rendered as numbered, syntax-
  // highlighted source instead of a wall of anonymous terminal text.
  //
  // The parse is of the COMMAND alone, so the header settles the moment the call
  // starts rather than flipping shape when the output lands; the split of the
  // output is separate, and when it disagrees with the script only the body
  // falls back to the plain command + output panels (see lib/fileViewCommand).
  //
  // Plain consts, not useMemo: both derive from `item`, which the reducer
  // mutates in place (see the ToolCard memo note), and a manual dependency on a
  // mutated value makes the React compiler skip optimizing the WHOLE card. It
  // memoizes these for us instead.
  const fileViewSteps = isBash && !isHostRun ? parseFileViewScript(unwrapBashLoginCommand(bashSource)) : null
  const fileViews = fileViewSteps?.flatMap((s) => (s.kind === 'view' ? [s.view] : [])) ?? []
  const isReadShell = fileViews.length > 0
  // Deduped: several ranges of ONE file are one file in the header.
  const readShellPaths: string[] = []
  for (const view of fileViews) {
    const path = collapseHome(trimWorktreePaths(view.path, worktree))
    if (!readShellPaths.includes(path)) readShellPaths.push(path)
  }
  const fileViewSections =
    fileViewSteps && renderedResult !== undefined && !item.isError
      ? splitFileViewOutput(fileViewSteps, stripAnsi(renderedResult))
      : null

  // A script that is not ALL reads still says a great deal about its own output.
  // The constant `echo`s an agent puts between its steps mark where each
  // command's output begins, and the command in between names the file its lines
  // came from - so the wall of terminal text can be given back its structure:
  // file content highlighted by extension, grep's own line numbers in a gutter,
  // the separators coloured as strings (see lib/shellSections).
  //
  // Only where the Read presentation above did not already claim the output, and
  // never over ANSI colour (a `grep --color` line is not the file's own text) or
  // an error (stderr interleaves with stdout in an order no parse of the script
  // can predict, so every section boundary would be a guess).
  const scriptSteps = isBash && fileViewSections === null ? parseScriptSteps(unwrapBashLoginCommand(bashSource)) : null
  const scriptSections =
    scriptSteps && renderedResult !== undefined && !item.isError && !hasAnsi(renderedResult)
      ? splitScriptOutput(scriptSteps, renderedResult)
      : null

  // Read specifics (items 1, 3, 5): the file it read, a "memory <name>" alias
  // for auto-memory files, the line range for the header, whether the input is
  // "simple" (fully described by the header, so the Input panel is hidden), and
  // the language to highlight its output by.
  const isRead = item.name === 'Read'
  const readPath = isRead && typeof input?.file_path === 'string' ? (input.file_path as string) : ''
  const mem = isRead ? memoryName(readPath) : null
  // The bare git_* name for a Hydra git tool ('' for anything else).
  const gitTool = /^mcp__hydra__(git_.+)$/.exec(item.name)?.[1] ?? ''
  // A single-file git_add's subject is a file, so it gets the same lowlit-path
  // treatment as a Read/Edit rather than a flat monospace run - its path just
  // lives one level down, in files[].path. A multi-file add keeps the plain "N
  // files" summary instead: listing every path here overflows the header, and
  // the body's bulleted list is where they belong.
  const gitAddSpecList = gitTool === 'git_add' && input ? gitAddSpecs(input) : []
  const gitAddPaths = gitAddSpecList.length === 1 ? [gitAddSpecList[0].path] : []
  // Read's "lines N-M" slot doubles as git_add's staged line ranges: the path
  // renders lowlit like any other file, so the ranges ride alongside it rather
  // than forcing the whole summary back into monospace.
  // Only for the single-file form: ranges pooled across several files would read
  // as one list belonging to none of them.
  const gitAddLines = gitAddSpecList.length === 1 ? gitAddSpecList[0].lines : []
  // A read-shaped shell command fills the same slot from its own range. Only
  // when it looked at ONE file: several ranges pooled in the header would read
  // as one list belonging to none of them (as for git_add above), and each
  // section states its own command anyway.
  const lineInfo = isRead
    ? readLineInfo(input)
    : fileViews.length === 1
      ? fileViewLineInfo(fileViews[0])
      : gitAddLines.length > 0
        ? `lines ${gitAddLines.join(', ')}`
        : ''
  const simpleRead =
    isRead && input != null && Object.keys(input).every((k) => k === 'file_path' || k === 'offset' || k === 'limit')
  const outputLang = isRead ? langFromPath(readPath) : ''

  // Write / Edit specifics: render the payload richly rather than as raw JSON -
  // a Write's whole file content as a numbered code block, an Edit's
  // old_string/new_string side by side. Both syntax-highlight by the target
  // file's extension.
  const filePath = typeof input?.file_path === 'string' ? (input.file_path as string) : ''
  // A tool's image output is laid out at its logical size. A data-URL image
  // carries no name, so the density hint comes from the path that produced it
  // (shot@2x.png) - see lib/imageDensity.
  const imageDensity = densityFromPath(readPath || filePath)
  const isWrite = item.name === 'Write' && typeof input?.content === 'string'
  const isEdit = item.name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string'
  const fileLang = isWrite || isEdit ? langFromPath(filePath) : ''

  // Task tools carry a prose subject, not a path/command - shown in the header.
  const isTaskTool = item.name === 'TaskCreate' || item.name === 'TaskUpdate'
  const isWebSearch = item.name === 'WebSearch'
  const isFileChanges = Array.isArray(input?.changes)
  const isGlob = item.name === 'Glob' && typeof input?.pattern === 'string'
  const isWebFetch = item.name === 'WebFetch' && typeof input?.url === 'string'

  // SendMessage: a note to another agent, so the card reads as who it went to +
  // what was said, and its JSON reply becomes a sentence (items: rich message
  // card). The recipient's label/liveness are resolved by the caller.
  const isSendMessage = item.name === 'SendMessage' && input != null
  const messageTo = isSendMessage ? sendMessageRecipient(input) || recipientId : ''
  const messageResult = isSendMessage ? parseSendMessageResult(visibleResult) : null
  const openRecipientChat = openSub && recipientId ? () => openSub(recipientId) : undefined
  const recipientName = recipientLabel || (messageTo ? messageTo.slice(0, 8) : 'agent')

  // A Bash header shows the human description when the agent provided one (the
  // script itself lives in the expanded card); a memory Read shows "memory
  // <name>"; other tools show their primary argument, worktree-relative and
  // home-collapsed.
  const summarized = summarizeToolInput(input, item.name)
  const changedPaths = isFileChanges
    ? (input!.changes as unknown[]).flatMap((raw) => raw && typeof raw === 'object' && typeof (raw as { path?: unknown }).path === 'string' ? [trimWorktreePaths((raw as { path: string }).path, worktree)] : [])
    : []
  const summary = mem
    ? `memory ${mem}`
    : isWebSearch
      ? (typeof input?.query === 'string' && input.query.trim() ? input.query : 'Preparing search…')
    : isFileChanges
      ? changedPaths.join(', ')
      : collapseHome(trimWorktreePaths(isBash ? description || visibleCommand.replace(/\n/g, ' ') : summarized.text, worktree))
  // File paths render in the UI sans font (item 23/2); code-like summaries (a
  // Bash command, a Grep pattern) stay monospace. A memory alias / Bash
  // description / task subject / prose input field (a ScheduleWakeup prompt)
  // are prose (sans) already.
  const isPathSummary =
    isReadShell ||
    (!isBash && !mem && !!input && (isFileChanges || gitAddPaths.length > 0 || typeof input.file_path === 'string' || typeof input.path === 'string'))
  const summaryPaths = isReadShell
    ? readShellPaths
    : isFileChanges
      ? changedPaths
      : gitAddPaths.length > 0
        ? gitAddPaths.map((p) => collapseHome(trimWorktreePaths(p, worktree)))
        : isPathSummary
          ? [collapseHome(trimWorktreePaths(String(input?.file_path ?? input?.path ?? ''), worktree))]
          : []
  const summaryMono = !mem && !isPathSummary && !isTaskTool && !isWebFetch && !isWebSearch && !(isBash && description) && !summarized.prose
  // The Input panel is redundant for a plain Read (item 1) - everything it holds
  // is already in the header - and for a tool with no arguments at all (an empty
  // `{}` input, e.g. EnterPlanMode), where a `{}` panel is pure noise. Bash shows
  // its Command panel unlabelled (item 13).
  const emptyInput = input == null || Object.keys(input).length === 0
  // A single-file git_add is the same case as a plain Read: its header already
  // carries the path and the line ranges, so the panel would only repeat them.
  const gitAddSimple = gitTool === 'git_add' && gitAddPaths.length === 1
  // A read-shaped shell command whose output split cleanly needs no Command
  // panel either: every section is captioned with the step that produced it, so
  // the panel would print the same script twice.
  const hideInput = simpleRead || emptyInput || gitAddSimple || fileViewSections !== null
  // Whether an input/command panel renders above the output. When it doesn't
  // (a plain Read), the "Output" header is redundant and dropped (item 32).
  const hasInput = fileViewSections !== null ? false : isBash || !hideInput
  const Icon = isHostRun ? ShieldAlert : isReadShell ? FileText : TOOL_ICONS[item.name] ?? Wrench

  // The security gate may have parked THIS call for the user (a host-run, an
  // unvetted MCP tool, ...). When it has, the card answers for itself instead of
  // making you find the toast - and opens itself, since a question you cannot see
  // is not a question.
  const approval = usePendingToolApproval(item.name, input, item.result === undefined)
  const awaitingApproval = approval !== null
  // Adjusted during render rather than in an effect (React's "adjust state when a
  // prop changes" pattern): no cascading second render, and the card can still be
  // collapsed again afterwards - a plain `open || awaitingApproval` would nail it
  // open for as long as the request is parked.
  // Starts false even when the request is already parked on first render (the
  // page was opened DURING the wait) - the mismatch on that first pass is what
  // opens the card.
  const [sawApproval, setSawApproval] = useState(false)
  if (awaitingApproval !== sawApproval) {
    setSawApproval(awaitingApproval)
    if (awaitingApproval) setOpen(true)
  }

  const rawJson = useMemo(
    () => (showRaw ? toolRawJson(item.input, item.rawUse, item.rawResult, visibleResult) : ''),
    [showRaw, item.input, item.rawUse, item.rawResult, visibleResult],
  )
  // The patch's lines get the same worktree-path trim as every other path the
  // card prints, and the copy is memoized so the diff rows aren't rebuilt on
  // every render.
  const editHunks = useMemo(
    () => item.editPatch?.map((h) => ({ ...h, lines: h.lines.map((l) => trimWorktreePaths(l, worktree)) })),
    [item.editPatch, worktree],
  )

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        item.isError
          ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
          : awaitingApproval
            ? 'border-amber-300/80 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/[0.06]'
            : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
      }`}
    >
      {/* Header row: the WHOLE row toggles open (so when collapsed the entire
          card is the click target); the Raw button stops propagation so it
          doesn't also collapse. Body clicks (below) never toggle - only the
          header does, which is what you want once expanded. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
        className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-stone-600 dark:text-stone-300 cursor-pointer select-none hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        <div className="flex flex-1 min-w-0 items-baseline gap-1.5 text-left">
          <ChevronRight
            className={`w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <Icon className={`w-3 h-3 shrink-0 self-center ${item.isError ? 'text-red-500 dark:text-red-400' : isHostRun ? 'text-red-500/90 dark:text-red-400/90' : 'text-stone-400 dark:text-stone-500'}`} />
          <span className="font-medium shrink-0">{isHostRun ? 'Host run' : isReadShell ? 'Read' : gitTool ? gitToolHeading(gitTool, input) : displayToolName(item.name)}</span>
          {/* A host run leaves the sandbox - say so in the collapsed header, where
              it can't be missed, not only in the body. */}
          {isHostRun && (
            <span className="shrink-0 self-center rounded px-1 py-px text-[10px] font-semibold bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300">
              outside sandbox
            </span>
          )}
          {/* Who a message went to belongs in the collapsed header - it is the
              first thing you want to know about a SendMessage. */}
          {isSendMessage && messageTo && (
            <span className="shrink-0 flex items-baseline gap-1 text-stone-400 dark:text-stone-500">
              <span aria-hidden>&#8594;</span>
              <span className="max-w-40 truncate text-stone-500 dark:text-stone-400">{recipientName}</span>
            </span>
          )}
          {isSendMessage && recipientRunning && (
            <LoaderCircle className="w-3 h-3 shrink-0 self-center animate-spin text-violet-500/80 dark:text-violet-400/80" />
          )}
          {isPathSummary ? (
            <span className="truncate">
              {summaryPaths.map((path, index) => <span key={`${path}:${index}`}>{index > 0 && <span className="text-stone-400 dark:text-stone-500">, </span>}<LowlitPath path={path} /></span>)}
            </span>
          ) : (
            <span className={`truncate ${summaryMono ? 'font-mono' : ''} text-stone-400 dark:text-stone-500`}>{summary}</span>
          )}
          {lineInfo && <span className="shrink-0 text-stone-400/70 dark:text-stone-500/70">{lineInfo}</span>}
        </div>
        {(pending || awaitingApproval) && (
          <span className="shrink-0 self-center text-[10px] text-amber-600 dark:text-amber-400/90 animate-pulse">
            {awaitingApproval ? 'needs approval' : 'running'}
          </span>
        )}
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowRaw((r) => !r) }}
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
          {/* The parked-approval row sits ABOVE the command, so the buttons are
              never below a long script you'd have to scroll past. */}
          {approval && <ToolApproval approval={approval} />}
          {showRaw ? (
            <CodePanel code={rawJson} lang="json" />
          ) : (
            <>
              {isBash && !fileViewSections ? (
                <div>
                  {interactiveTranscript && (
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
                      Terminal input (inferred from echo)
                    </div>
                  )}
                  {isHostRun && !interactiveTranscript && (
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
                      Command to run on the host
                    </div>
                  )}
                  <CodePanel code={trimWorktreePaths(visibleCommand, worktree)} lang="bash" />
                </div>
              ) : isWebSearch && typeof input?.query === 'string' && input.query.trim() ? (
                <div className={`${PANEL_CLASS} px-2.5 py-1.5 text-stone-700 dark:text-stone-200`}>{input.query}</div>
              ) : isWebSearch && pending ? (
                <div className={`${PANEL_CLASS} px-2.5 py-1.5 text-stone-400 dark:text-stone-500`}>Preparing search…</div>
              ) : isGlob ? (
                <div className={`${PANEL_CLASS} px-2.5 py-1.5 font-mono text-stone-700 dark:text-stone-200`}>{input!.pattern as string}</div>
              ) : isWebFetch ? (
                <div className={`${PANEL_CLASS} px-2.5 py-1.5 space-y-1.5`}><a href={input!.url as string} target="_blank" rel="noreferrer" className="block break-all text-blue-600 dark:text-blue-400 hover:underline"><UrlText url={input!.url as string} /></a>{typeof input!.prompt === 'string' && <div className="text-stone-600 dark:text-stone-300">{input!.prompt as string}</div>}</div>
              ) : isFileChanges ? (
                <FileChangesPanel changes={input?.changes} worktree={worktree} />
              ) : isWrite ? (
                <NumberedCodePanel code={trimWorktreePaths(input!.content as string, worktree)} lang={fileLang} />
              ) : isEdit ? (
                <EditDiffPanel
                  oldStr={trimWorktreePaths(input!.old_string as string, worktree)}
                  newStr={trimWorktreePaths(input!.new_string as string, worktree)}
                  lang={fileLang}
                  replaceAll={input!.replace_all === true}
                  hunks={editHunks}
                />
              ) : isSendMessage && input ? (
                <SendMessageFields
                  input={input}
                  recipientLabel={recipientName}
                  recipientId={messageTo}
                  recipientRunning={recipientRunning}
                  onOpenChat={openRecipientChat}
                />
              ) : isTaskTool && input ? (
                <TaskToolFields input={input} />
              ) : gitTool && input && !hideInput ? (
                <GitToolFields tool={gitTool} input={input} worktree={worktree} />
              ) : hideInput ? null : (
                <CodePanel code={trimWorktreePaths(JSON.stringify(item.input, null, 2) ?? '', worktree)} lang="json" />
              )}
				{(renderedResult !== undefined || (item.resultImages && item.resultImages.length > 0)) && (
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
                      {item.resultImages.map((src, i) => {
                        // width/height attrs (from the eager decode) + h-auto:
                        // layout reserves the image's aspect box before the
                        // browser paints the pixels - see useImageDims. The size
                        // is LOGICAL (physical px / the @2x density in the read
                        // path), so a 2x capture lays out like a 1x one, sharper.
                        const dims = imageDims.get(src)
                        const logical = dims && logicalSize(dims, imageDensity)
                        return (
                          <img
                            key={i}
                            src={src}
                            width={logical?.w}
                            height={logical?.h}
                            alt="Tool output image"
                            onClick={(e) => { setImgOrigin(e.currentTarget); setImgLightbox(i) }}
                            // A ring, NOT a border: with border-box sizing (the
                            // Tailwind default) a 1px border eats 2px out of the
                            // content box the width attr set, so a 420px shot was
                            // resampled into 418x199.047 - a fractional rescale
                            // that softens every pixel. A ring is a box-shadow
                            // and costs no layout, so the image draws 1:1.
                            // min-h while the size is still unknown (a slow
                            // url-source image opened before the eager decode
                            // finished): the open measures a visible loading
                            // box instead of a sliver.
                            className={`max-w-full h-auto rounded-md ring-1 ring-stone-200 dark:ring-white/[0.08] cursor-zoom-in ${dims ? '' : 'min-h-32 w-full'}`}
                          />
                        )
                      })}
                    </div>
                  )}
					{renderedResult !== undefined && !(renderedResult === '' && item.resultImages?.length) && (
                    messageResult && !item.isError
                      ? <SendMessageOutcome result={messageResult} recipientRunning={recipientRunning} onOpenChat={openRecipientChat} />
                    : mem && !item.isError
						? <MemoryPanel text={renderedResult} />
                      : isTaskTool && !item.isError
							? <div className="break-words leading-relaxed chat-font"><Markdown text={renderedResult} /></div>
                        : isWebSearch && !item.isError
                          ? <WebSearchOutput text={renderedResult} />
                        : isWebFetch && !item.isError
                          ? <div className="break-words leading-relaxed chat-font"><Markdown text={renderedResult} /></div>
                        : fileViewSections
                          ? <FileViewSections sections={fileViewSections} />
                        : scriptSections
                          ? <ScriptOutputPanel sections={scriptSections} />
                        : isRead && !item.isError
								? <ReadOutputPanel text={renderedResult} lang={outputLang} />
								: <OutputPanel text={renderedResult} lang={outputLang} isError={item.isError} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Expandable>
      {/* Read of an image returns image blocks (item 4); clicking one opens it
          full-size in the shared lightbox, like an attachment image. */}
      {imgLightbox !== null && item.resultImages && item.resultImages.length > 0 && (
        <Lightbox
          items={item.resultImages.map((url, i) => ({ url, filename: `image ${i + 1}`, size: 0, dpi: imageDensity }))}
          index={Math.min(imgLightbox, item.resultImages.length - 1)}
          origin={imgOrigin}
          onIndexChange={setImgLightbox}
          onClose={() => setImgLightbox(null)}
        />
      )}
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
  const rawJson = useMemo(
    () => (showRaw ? toolRawJson(item.input, item.rawUse, item.rawResult, item.result) : ''),
    [showRaw, item.input, item.rawUse, item.rawResult, item.result],
  )
  // A malformed ExitPlanMode input (no plan text) falls back to the generic card.
  if (!parsed) return <ToolCard item={item} worktree={null} />

  return (
    <div className="rounded-lg border border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03] text-xs overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
        className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-stone-600 dark:text-stone-300 cursor-pointer select-none hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        <div className="flex flex-1 min-w-0 items-baseline gap-1.5 text-left">
          <ChevronRight
            className={`w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <ClipboardList className="w-3 h-3 shrink-0 self-center text-stone-400 dark:text-stone-500" />
          <span className="font-medium shrink-0">Plan</span>
          {parsed.fileName && (
            <span className="truncate font-mono text-stone-400 dark:text-stone-500">{parsed.fileName}</span>
          )}
        </div>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowRaw((r) => !r) }}
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

  // While streaming, the "Thinking..." label now lives inside the live "working"
  // indicator's brackets (see item 48), so this card surfaces only the live tail
  // - the last couple of thought lines. A silent (empty) thought renders nothing
  // here at all, avoiding a second "Thinking..." line whose appearing/vanishing
  // shifted the layout.
  if (streaming) {
    if (!tail) return null
    return (
      <div className="text-xs mt-1 italic text-stone-400 dark:text-stone-500 whitespace-pre-wrap break-words line-clamp-2">
        {tail}
      </div>
    )
  }

  return (
    <div className="text-xs">
      <button
        onClick={toggle}
        disabled={empty}
        className={`group flex w-full items-center gap-1.5 text-left ${empty ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <span className="shrink-0 font-medium text-stone-400 dark:text-stone-500 group-hover:text-stone-600 dark:group-hover:text-stone-300 transition-colors">
          {settledLabel}
        </span>
        {!open && snippet && (
          <span className="truncate italic text-stone-400/80 dark:text-stone-500/80">{snippet}</span>
        )}
        {!empty && (
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-stone-400/70 dark:text-stone-500/70 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
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
                {settledLabel}
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

// SubagentLinks bundles what rendering NESTED sub-agents needs, threaded from
// the pane into SubagentCard -> SubagentTimeline (and recursively down): the
// toolUse -> sub map that upgrades an inner Task/Agent tool card into the
// spawned sub-agent's own card, the tool lookup for its status/report, the set
// of settled-but-waiting-on-children agents, and the open-chat-view hook.
interface SubagentLinks {
  subByToolUse: Record<string, SubagentView>
  taskToolByUse: Record<string, ToolItem>
  awaitingChildren: Set<string>
  openSubView: (key: string) => void
}

// shellCwdsFor follows the working directory across a list of chat items, so
// each Bash card can show where its command actually ran (lib/shellCwd). The
// agent's shell is ONE process for the whole session: a `cd` in an early step is
// still in force much later, and a command that reads as nonsense at the
// worktree ("cd web" failing) makes sense once you can see the shell was already
// there. A sub-agent has its own shell, so each timeline tracks its own.
function shellCwdsFor(items: ChatItem[], worktree: string | null): Map<string, string | null> {
  const steps: ShellStep[] = []
  for (const it of items) {
    if (it.kind !== 'tool' || it.name !== 'Bash') continue
    const input = (typeof it.input === 'object' && it.input !== null ? it.input : {}) as Record<string, unknown>
    if (typeof input.command !== 'string' || !input.command) continue
    steps.push({
      id: it.toolUseId,
      command: input.command,
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
      output: it.result ?? it.runningOutput,
      cwdAfter: it.cwdAfter,
      failed: it.isError === true,
      background: input.run_in_background === true,
    })
  }
  return trackShellCwds(steps, worktree)
}

// SubagentTimeline renders a sub-agent's inner steps (thinking / tool calls /
// replies), shared by the folded SubagentCard and the full SubagentChatView.
// skipId drops one inner item (the assistant message shown separately as the
// Report) so it does not appear twice.
function SubagentTimeline({
  sub,
  worktree,
  skipId,
  links,
  // Whether this timeline may fold its own runs of steps. Off inside a folded
  // SubagentCard: that card ALREADY hides the whole timeline behind its own
  // "N steps" disclosure, so grouping inside it stacked a second fold with the
  // same word on it - you clicked "4 steps" and were handed "3 steps". One fold
  // per level. The full sub-agent chat view has no outer fold, so it groups.
  fold = false,
}: {
  sub: SubagentView
  worktree: string | null
  skipId?: number
  links?: SubagentLinks
  fold?: boolean
}) {
  const cwds = useMemo(() => shellCwdsFor(sub.items, worktree), [sub.items, worktree])
  // A sub-agent's own steps fold exactly like the main transcript's (see
  // planStepRows) - its inner runs are the same wall, one level down.
  const grouped = useChatStepsStore((s) => s.grouped)
  const rows = planStepRows(
    sub.items.filter((it) => it.id !== skipId),
    links?.subByToolUse ?? {},
    fold && grouped,
  )
  const renderItem = (it: ChatItem) => {
    if (it.kind === 'thinking') return <ThinkingCard key={it.id} text={it.text} durationMs={it.durationMs} />
    if (it.kind === 'tool') {
      // A tool_use that spawned a sub-agent of THIS sub-agent (a nested
      // spawn): upgrade it into the spawned agent's own card, exactly like
      // the main flow upgrades its Task cards - instead of leaking the raw
      // prompt JSON + launch boilerplate as a plain tool card.
      const nested = links?.subByToolUse[it.toolUseId]
      if (links && nested && nested.agentId !== sub.agentId)
        return (
          <SubagentCard
            key={it.id}
            sub={nested}
            tool={it}
            worktree={worktree}
            links={links}
            onOpenChat={() => links.openSubView(nested.agentId)}
          />
        )
      if (it.name === 'ExitPlanMode') return <PlanCard key={it.id} item={it} />
      return <ToolCard key={it.id} item={it} worktree={worktree} shellCwd={cwds.get(it.toolUseId) ?? null} />
    }
    if (it.kind === 'assistant')
      return (
        <div key={it.id} className="chat-leading-xs chat-font">
          <Markdown text={it.text} />
        </div>
      )
    return null
  }
  return (
    <>
      {rows.map((r) =>
        r.row === 'item' ? (
          renderItem(r.item)
        ) : (
          <StepGroup key={`steps-${r.id}`} items={r.items} liveFrom={null} renderRow={renderItem} />
        ),
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

// NoticePill renders a task-notification chip. A notice that resolves to a
// sub-agent is CLICKABLE (opens that agent's chat); a background command's
// notice (it carried an <output-file>) is EXPANDABLE, fetching and showing the
// command's output beneath the pill.
function NoticePill({ text, onOpenChat, outputFile, requestTaskOutput }: {
  text: string
  onOpenChat?: () => void
  outputFile?: string
  requestTaskOutput?: (file: string) => Promise<{ content?: string; error?: string }>
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ content?: string; error?: string } | null>(null)
  const expandable = !onOpenChat && !!outputFile && !!requestTaskOutput
  const clickable = !!onOpenChat || expandable
  const onClick = () => {
    if (onOpenChat) {
      onOpenChat()
      return
    }
    if (!expandable) return
    if (open || result != null) {
      setOpen(!open)
      return
    }
    // First expand: fetch the output BEFORE opening, so the reveal animation
    // measures the real content. Opening around a small "loading" placeholder
    // made the panel glide to placeholder height and then jump to full size
    // when the output landed (the same first-open jump image reads had before
    // their dimensions were reserved). The pill's chevron spins while fetching.
    if (loading) return
    setLoading(true)
    requestTaskOutput!(outputFile!).then((res) => {
      setResult(res)
      setLoading(false)
      setOpen(true)
    })
  }
  const pill = (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className={`flex max-w-[90%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 select-none ${
        clickable ? 'cursor-pointer hover:bg-stone-200/70 dark:hover:bg-white/[0.08] hover:text-stone-700 dark:hover:text-stone-200 transition-colors' : ''
      }`}
      title={text}
    >
      {expandable &&
        (loading ? (
          <LoaderCircle className="w-3 h-3 shrink-0 animate-spin text-stone-400 dark:text-stone-500" />
        ) : (
          <ChevronRight className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        ))}
      <span className="truncate">{text}</span>
      {onOpenChat && <MessageSquare className="w-3 h-3 shrink-0" />}
    </div>
  )
  if (!expandable) return <div className="flex justify-center">{pill}</div>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-center">{pill}</div>
      <Expandable open={open}>
        <div className="w-full">
          {result?.error ? (
            <div className="text-center py-1 text-[11px] text-stone-400 dark:text-stone-500">{result.error}</div>
          ) : (
            <OutputPanel text={result?.content ?? ''} lang="" />
          )}
        </div>
      </Expandable>
    </div>
  )
}

// isLaunchBoilerplate spots the async/background-agent launch acknowledgement
// ("Async agent launched successfully ... internal metadata ...") - that is NOT
// the real report, just the handle returned to the parent at spawn time.
function isLaunchBoilerplate(s: string): boolean {
  return /Async agent launched successfully|internal metadata/i.test(s)
}

// Codex exposes all collaboration controls through collabAgentToolCall. Only a
// spawn owns a child conversation; wait/send/resume/close are ordinary tool
// calls and must not create empty sub-agent cards. Claude's Agent tool has no
// `_raw.tool` discriminator, but its prompt/subagent_type shape is a spawn.
function isAgentSpawnInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  const raw = input._raw && typeof input._raw === 'object' ? input._raw as Record<string, unknown> : null
  const rawTool = typeof raw?.tool === 'string' ? raw.tool.replace(/[_-]/g, '').toLowerCase() : ''
  if (rawTool) return rawTool === 'spawnagent'
  return typeof input.prompt === 'string' || typeof input.subagent_type === 'string'
}

function isAgentStatusOnlyResult(tool: ToolItem | undefined, result: string): boolean {
  return tool?.name === 'Agent' && /^(?:completed|complete|done|success|succeeded)$/i.test(result.trim())
}

// subReport resolves what a sub-agent reported back. Normally that is the Task
// tool_result; but for a background/async agent the tool_result is only the
// launch boilerplate, so the sub-agent's own final assistant message is the real
// report (#62). itemId is set only in that latter case, letting the timeline skip
// the message so it is not shown twice.
function subReport(sub: SubagentView, tool?: ToolItem): SubReport | null {
  const res = tool?.result?.trim()
  if (tool?.isError && res) return { text: cleanSubagentReport(tool!.result!), isError: true }
  if (res && !isLaunchBoilerplate(res) && !isAgentStatusOnlyResult(tool, res)) return { text: cleanSubagentReport(tool!.result!), isError: false }
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
function SubagentReport({ report }: { report: SubReport }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-stone-400 dark:text-stone-500 select-none">
        Report
      </div>
      {report.isError ? (
        <OutputPanel text={report.text} lang="" isError />
      ) : (
        <div className="chat-leading-xs chat-font">
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
  onOpenChat,
  openLabel,
}: {
  label: string
  desc?: string
  report: SubReport | null
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
            <div className="chat-leading-xs chat-font">
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
  onOpenChat,
  finishedBadge,
  links,
}: {
  sub: SubagentView
  tool?: ToolItem
  worktree: string | null
  onOpenChat?: () => void
  finishedBadge?: boolean
  links?: SubagentLinks
}) {
  const running = isSubRunning(sub, tool)
  // Settled itself, but sub-agents IT spawned are still working: the harness
  // "finishes" an agent the moment its turn ends, even mid-wait on background
  // children, so a plain "finished" here misreads. Keep the card visually live
  // until the whole subtree is quiet.
  const waiting = !running && !!links?.awaitingChildren.has(sub.agentId)
  const active = running || waiting
  // Collapsed by default so a sub-agent never dominates the main conversation
  // (#62); the user expands the card to see its prompt, steps and report.
  const [open, setOpen] = useState(false)
  // The step timeline is collapsed by default (prompt + report are the resting
  // view); the user expands it to inspect the sub-agent's inner work.
  const [stepsOpen, setStepsOpen] = useState(false)

  const { label, desc } = subCardLabels(sub, tool)
  const steps = sub.items.length
  const report = active ? null : subReport(sub, tool)

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        tool?.isError
          ? 'border-red-300/70 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
          : active
            ? 'border-violet-300/70 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/[0.05]'
            : 'border-stone-200/90 bg-white/55 dark:border-white/[0.07] dark:bg-white/[0.03]'
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
        className="flex w-full items-center gap-1.5 pl-2.5 pr-2 text-stone-600 dark:text-stone-300 cursor-pointer select-none hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          {active ? (
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
          ) : waiting ? (
            <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] font-medium text-violet-600 dark:text-violet-400/90">
              <LoaderCircle className="w-3 h-3 animate-spin" />
              waiting on sub-agents
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
        </div>
        {onOpenChat && (
          <Tooltip content="Open sub-agent chat" side="top">
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChat() }}
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
              <div className="break-words chat-leading-xs chat-font">
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
                  <SubagentTimeline sub={sub} worktree={worktree} skipId={reportSkipId(sub, report)} links={links} />
                </div>
              </Expandable>
            </div>
          )}
          {report && <SubagentReport report={report} />}
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
  links,
}: {
  sub: SubagentView
  tool?: ToolItem
  worktree: string | null
  links?: SubagentLinks
}) {
  const running = isSubRunning(sub, tool)
  // Same as SubagentCard: settled itself but spawned sub-agents still working.
  const waiting = !running && !!links?.awaitingChildren.has(sub.agentId)
  const { label, desc } = subLabels(sub, tool)
  const report = running || waiting ? null : subReport(sub, tool)
  return (
    <>
      <div className="flex items-baseline gap-2 pt-8 text-stone-600 dark:text-stone-300">
        <Bot className="w-4 h-4 shrink-0 self-center text-violet-500/80 dark:text-violet-400/80" />
        <span className="text-sm font-semibold">{label}</span>
        {desc && <span className="truncate text-xs text-stone-400 dark:text-stone-500">{desc}</span>}
        {running || waiting ? (
          <span className="ml-auto shrink-0 self-center flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400/90">
            <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
            {running ? 'working' : 'waiting on sub-agents'}
          </span>
        ) : (
          <span className="ml-auto shrink-0 self-center flex items-center gap-1 text-[11px] text-stone-400 dark:text-stone-500">
            <Check className="w-3.5 h-3.5" />
            finished
          </span>
        )}
      </div>
      {/* The sub-agent's task is its "user" turn: render it as a user message
          bubble (like the main conversation's), no "Prompt" heading. This is the
          full view only - the folded SubagentCard keeps its labelled Prompt. */}
      {sub.prompt && (
        <div className="flex flex-col items-end gap-1">
          <div className={`${USER_BUBBLE_CLASS} leading-relaxed chat-font`}>
            <Markdown text={sub.prompt} />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 text-xs">
        <SubagentTimeline sub={sub} worktree={worktree} skipId={reportSkipId(sub, report)} links={links} fold />
      </div>
      {report && <SubagentReport report={report} />}
      {/* whitespace-nowrap for the same reason as the main working line: the
          label swaps between "Working..." and the longer "Waiting on
          sub-agents...", and a wrap there would shift the mark. */}
      {(running || waiting) && (
        <div className="flex items-center gap-1.5 text-[11px] select-none whitespace-nowrap">
          <WorkSpark />
          <span className="chat-text-shimmer font-medium min-w-0 truncate optical-center">{running ? 'Working...' : 'Waiting on sub-agents...'}</span>
        </div>
      )}
    </>
  )
}

// ChatViewSelector is the top-left dropdown listing the current agents - the
// main conversation plus the sub-agent tree (children indented under the
// sub-agent that spawned them) with live status - switching which conversation
// the pane shows. Rendered only once sub-agents exist; floats over the
// timeline like the jump-to-bottom button.
//
// There is no separate header chip: the card ALWAYS renders the full list, and
// the collapsed state is the list clipped to just the current row (the card's
// height is one row and the list is translated up by that row's offset).
// Opening glides the translate to 0 while the height and width expand, so the
// chip visually slides down into its slot in the tree as the other rows are
// revealed around it - and picking a row morphs the card back down onto the
// row that was just clicked.
function ChatViewSelector({
  chatView,
  subagents,
  taskToolByUse,
  awaitingChildren,
  onSelect,
  fadeIn,
  paired,
}: {
  chatView: string
  subagents: Record<string, SubagentView>
  taskToolByUse: Record<string, ToolItem>
  awaitingChildren: Set<string>
  onSelect: (key: string) => void
  fadeIn: boolean
  // The plan panel is on screen too: split the row in half rather than let this
  // card's chip - as wide as its current row's label - grow under the plan's
  // corner. See PlanPanel's `paired`.
  paired: boolean
}) {
  const [open, setOpen] = useState(false)
  // Frozen at mount: fade in only when the selector APPEARS live (the first
  // sub-agent spawning mid-conversation), not on every reload's replay.
  const [animateIn] = useState(fadeIn)
  const [chipRef, chipW] = useChipWidth()
  // The morph's collapse target. Mirrors chatView, but updates the instant a
  // row is picked: onSelect round-trips through the parent's state, and
  // collapsing toward the OLD row for that render would visibly start the
  // morph at the wrong slot.
  const [localView, setLocalView] = useState(chatView)
  const [prevChatView, setPrevChatView] = useState(chatView)
  if (prevChatView !== chatView) {
    setPrevChatView(chatView)
    setLocalView(chatView)
  }
  const toolOf = (sub: SubagentView) => (sub.toolUseId ? taskToolByUse[sub.toolUseId] : undefined)
  const busy = (sub: SubagentView) => isSubRunning(sub, toolOf(sub)) || awaitingChildren.has(sub.agentId)
  // The full tree, main conversation first, children indented under their
  // parent. A sub with nothing to show yet (no meta, no prompt, no steps - a
  // transcript file seen before any of its content) is left out until it has
  // substance, unless it IS the current view (the collapse target must exist).
  interface SelectorRow {
    key: string
    label: string
    desc: string
    depth: number
    sub?: SubagentView
  }
  const rows: SelectorRow[] = [{ key: 'main', label: 'Main conversation', desc: '', depth: 0 }]
  {
    const kids: Record<string, SubagentView[]> = {}
    const roots: SubagentView[] = []
    for (const sub of Object.values(subagents)) {
      if (sub.parentAgentId && subagents[sub.parentAgentId]) (kids[sub.parentAgentId] ??= []).push(sub)
      else roots.push(sub)
    }
    const walk = (sub: SubagentView, depth: number) => {
      if (sub.agentType || sub.description || sub.prompt || sub.items.length > 0 || sub.agentId === localView) {
        const { label, desc } = subLabels(sub, toolOf(sub))
        rows.push({ key: sub.agentId, label, desc, depth, sub })
      }
      for (const c of kids[sub.agentId] ?? []) walk(c, depth + 1)
    }
    for (const r of roots) walk(r, 0)
  }
  const currentRow = rows.find((r) => r.key === localView) ?? rows[0]
  const pick = (key: string) => {
    setLocalView(key)
    setOpen(false)
    onSelect(key)
  }

  // The morph itself, driven imperatively (like Expandable) so live re-renders
  // can't clobber an in-flight glide: card height between one-row and
  // full-list PIXEL endpoints, list translateY between -currentRow.offsetTop
  // and 0. Runs every render; unchanged geometry writes nothing, geometry that
  // shifted without an open/selection change (a sub spawning, a label landing)
  // snaps without animating.
  const cardRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastGeom = useRef<{ h: number; y: number } | null>(null)
  const prevMorph = useRef<{ open: boolean; view: string } | null>(null)
  useLayoutEffect(() => {
    const card = cardRef.current
    const list = listRef.current
    const row = rowRefs.current.get(currentRow.key)
    if (!card || !list || !row) return
    // The card is border-box; row/list heights are its content.
    const borders = card.offsetHeight - card.clientHeight
    const h = (open ? list.offsetHeight : row.offsetHeight) + borders
    const y = open ? 0 : -row.offsetTop
    const prev = prevMorph.current
    const intent = prev == null || prev.open !== open || prev.view !== currentRow.key
    prevMorph.current = { open, view: currentRow.key }
    if (!intent && lastGeom.current && lastGeom.current.h === h && lastGeom.current.y === y) return
    lastGeom.current = { h, y }
    const animate =
      prev != null && intent && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Width rides the same transition (the JSX only sets the width VALUE).
    card.style.transition = animate ? 'width 0.2s ease, height 0.22s ease' : 'width 0.2s ease'
    list.style.transition = animate ? 'transform 0.22s ease' : ''
    card.style.height = `${h}px`
    list.style.transform = y ? `translateY(${y}px)` : ''
  })

  // Click-away closes: once open, the toggle has morphed down to the current
  // row's slot, so the old muscle-memory spot (top-left) may be over a
  // different row - clicking anywhere outside should just dismiss.
  //
  // Except the other corner card (the plan panel): it has no click-away of its
  // own, so without this exemption closing the plan also dismissed this card -
  // one click shutting two things - while closing this one left the plan up.
  // Each card now owns its own open state, and click-away still means anything
  // in the transcript or composer.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (target instanceof Element && target.closest('[data-chat-overlay]')) return
      if (cardRef.current && !cardRef.current.contains(target)) setOpen(false)
    }
    // Capture phase: a panel that stops mousedown propagation (scroll/drag
    // handlers) must still dismiss the dropdown.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  const rowIcon = (r: SelectorRow) =>
    r.sub ? (
      <Bot className="w-3.5 h-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
    ) : (
      <MessageSquare className="w-3.5 h-3.5 shrink-0 text-stone-400 dark:text-stone-500" />
    )
  const rowBusy = (r: SelectorRow) => (r.sub ? busy(r.sub) : false)

  return (
    // A floating card styled like the PlanPanel, corner-anchored; while open
    // it takes the higher z so it layers over the plan panel's chip on a
    // narrow pane instead of anything relocating. Collapsed width is the
    // current row's natural (fit-content) width, measured off the invisible
    // clone below (see useChipWidth).
    <div
      ref={cardRef}
      // Floats over the top of the transcript, so alignToLastMessage has to
      // scroll a message clear of it rather than flush to the pane's top.
      data-chat-overlay=""
      style={{ width: open ? 288 : chipW ?? undefined }}
      className={`absolute top-2 left-3 ${paired ? 'max-w-[calc(50%-1rem)]' : 'max-w-[calc(100%-1.5rem)]'} overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 bg-white/90 dark:bg-[#30302e]/90 shadow-lg backdrop-blur text-xs ${animateIn ? 'animate-chat-item-in' : ''} ${open ? 'z-30' : 'z-20'}`}
    >
      {/* Invisible clone of the CURRENT row at natural width - the collapsed
          width the open/close transition animates from/to. Mirrors the row's
          flow exactly (same paddings/gaps; ml-auto resolves to 0 at w-max). */}
      <div
        aria-hidden
        ref={chipRef}
        className="invisible absolute -left-[9999px] top-0 w-max border flex items-center gap-1.5 py-1.5 pr-2.5"
        style={{ paddingLeft: 12 }}
      >
        {rowIcon(currentRow)}
        <span className="max-w-48 truncate font-medium">{currentRow.label}</span>
        {currentRow.desc && <span className="max-w-44 truncate">{currentRow.desc}</span>}
        <span className="ml-auto shrink-0 flex items-center gap-1">
          {rowBusy(currentRow) && <LoaderCircle className="w-3 h-3 shrink-0" />}
          {currentRow.key === 'main' && <ChevronRight className="w-3 h-3 shrink-0" />}
        </span>
      </div>
      {/* No wrapper padding: collapsed, the card clips to exactly one row, so
          the chip's edges are the row's own padding in every state. */}
      <div ref={listRef} className="will-change-transform">
        {rows.map((r) => {
          const isCurrent = r.key === currentRow.key
          return (
            <button
              key={r.key}
              ref={(el) => {
                if (el) rowRefs.current.set(r.key, el)
                else rowRefs.current.delete(r.key)
              }}
              onClick={() => (isCurrent ? setOpen((o) => !o) : pick(r.key))}
              title={isCurrent ? 'Switch agent chat' : undefined}
              aria-expanded={isCurrent ? open : undefined}
              // Collapsed, the non-current rows are clipped out of view - keep
              // them out of the tab order too.
              tabIndex={!open && !isCurrent ? -1 : undefined}
              // Tree indent. Only the CURRENT row flattens while collapsed (it
              // IS the chip, and a nested agent's chip should sit flush) and
              // glides into its indented slot on open; the other rows keep a
              // static indent so nothing else shifts sideways during the morph.
              style={{ paddingLeft: !open && isCurrent ? 12 : 12 + r.depth * 14 }}
              className={`flex w-full items-center gap-1.5 pr-2.5 py-1.5 text-left cursor-pointer text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/[0.07] ${
                isCurrent ? 'transition-all duration-200' : 'transition-colors'
              } ${open && isCurrent ? 'bg-stone-100/80 dark:bg-white/[0.06] text-stone-800 dark:text-stone-100' : ''}`}
            >
              {rowIcon(r)}
              <span className="max-w-48 shrink-0 truncate font-medium">{r.label}</span>
              {r.desc && <span className="min-w-0 max-w-44 truncate text-stone-400 dark:text-stone-500">{r.desc}</span>}
              <span className="ml-auto shrink-0 flex items-center gap-1">
                {rowBusy(r) && (
                  <LoaderCircle className="w-3 h-3 shrink-0 animate-spin text-violet-500/80 dark:text-violet-400/80" />
                )}
                {r.key === 'main' && (
                  <ChevronRight
                    className={`w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
                  />
                )}
              </span>
            </button>
          )
        })}
      </div>
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
// The free-text notes riding alongside the picked options, keyed by question
// text - the shape AskUserQuestion's own `annotations` input field takes.
type QuestionAnnotations = Record<string, { notes: string }>

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

// What the CLI writes in place of the quoted value for a question the user
// left unpicked but attached a note to, and the marker introducing that note.
const NO_OPTION_PICKED = '(no option selected)'
const NOTE_MARKER = ' notes: '
// The sentences the CLI wraps the answer list in. A note is the last thing in
// its entry, so recovering one means knowing where the list stops.
const ANSWER_TAILS = ['. You can now continue with these answers in mind.', '. Read the answers carefully']

// deriveAnswered reconstructs which options (and any free-text "Other", and any
// note) each question resolved to, from the recorded tool_result text. On a
// resume the card's local selection state is gone - all we have is the durable
// result, which embeds the answers as `"<question>"="<comma-joined labels>"`
// pairs, each optionally trailed by ` notes: <note>` (the shape the real CLI's
// AskUserQuestion result produces, mirrored by the simulation). Matching those
// labels back to option indices lets a replayed card highlight the chosen
// options just as it did right after answering.
// A question's notes, keyed by the row each belongs to: an option's index as a
// string, or "other". A key being present is what makes the note box open, so
// an empty string is a note being written and a missing key is no note at all.
type NoteMap = Record<string, string>
const noteKey = (at: number | 'other') => String(at)

// The protocol carries ONE note per question, so several are merged into one
// string as "<label>: <text>" segments (a single note stays plain, which is
// what most answers are). splitNotes is the inverse, for a replayed card: it
// looks for those labels at a segment boundary, and hands the whole string to
// the last selected row if it can't find any - a note is display-only by then,
// so a graceful miss beats a wrong split.
const NOTE_JOIN = '; '
function splitNotes(slots: { key: string; label: string }[], merged: string): NoteMap {
  if (slots.length === 0 || merged === '') return {}
  const fallback = () => ({ [slots[slots.length - 1].key]: merged })
  if (slots.length === 1) return fallback()
  const marks = slots
    .map(({ key, label }) => {
      if (merged.startsWith(label + ': ')) return { key, start: 0, text: label.length + 2 }
      const at = merged.indexOf(NOTE_JOIN + label + ': ')
      if (at === -1) return null
      return { key, start: at, text: at + NOTE_JOIN.length + label.length + 2 }
    })
    .filter((m) => m !== null)
    .sort((a, b) => a.start - b.start)
  if (marks.length === 0) return fallback()
  const out: NoteMap = {}
  marks.forEach((m, i) => {
    out[m.key] = merged.slice(m.text, i + 1 < marks.length ? marks[i + 1].start : merged.length)
  })
  return out
}

// eslint-disable-next-line react-refresh/only-export-components
export function deriveAnswered(
  specs: QuestionSpec[],
  answeredText: string,
): { selected: Set<number>[]; other: string[]; notes: NoteMap[] } {
  const selected = specs.map(() => new Set<number>())
  const other = specs.map(() => '')
  const notes: NoteMap[] = specs.map(() => ({}))
  const merged = specs.map(() => '')
  // Where every question's entry begins, so a note - which runs to the end of
  // its entry - knows to stop at the next question rather than swallowing it.
  const starts = specs.map((q) => answeredText.indexOf(`"${q.question}"=`))
  specs.forEach((q, qi) => {
    const start = starts[qi]
    if (start === -1) return
    let pos = start + `"${q.question}"=`.length
    let value = ''
    if (answeredText[pos] === '"') {
      const end = answeredText.indexOf('"', pos + 1)
      if (end === -1) return
      value = answeredText.slice(pos + 1, end)
      pos = end + 1
    } else if (answeredText.startsWith(NO_OPTION_PICKED, pos)) {
      pos += NO_OPTION_PICKED.length
    } else {
      return
    }
    if (answeredText.startsWith(NOTE_MARKER, pos)) {
      // The note ends at whichever comes first: the next question's entry, the
      // sentence the CLI closes the list with, or the end of the text.
      const bounds = [
        ...starts.filter((s) => s > pos),
        ...ANSWER_TAILS.map((t) => answeredText.indexOf(t, pos)).filter((i) => i !== -1),
        answeredText.length,
      ]
      const end = Math.min(...bounds)
      merged[qi] = answeredText.slice(pos + NOTE_MARKER.length, end).replace(/,\s*$/, '').trim()
    }
    // The labels were joined with ", " (see submit()). Consume the value left to
    // right, matching whole option labels (longest first, so a label that itself
    // contains ", " isn't mistaken for two) and dropping anything else into the
    // free-text "Other" field.
    let rest = value
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
    // Now the selection is known, the merged note can be split back over the
    // rows it came from, in the order submit() joined them.
    const slots = [...selected[qi]]
      .sort((a, b) => a - b)
      .map((oi) => ({ key: noteKey(oi), label: q.options[oi].label }))
    if (other[qi] !== '') slots.push({ key: noteKey('other'), label: other[qi] })
    notes[qi] = splitNotes(slots, merged[qi])
  })
  return { selected, other, notes }
}

// Pending "before" row positions for the note's slide, keyed by the row list
// they were measured in. Module-level rather than a ref because this is
// transient DOM measurement - written by the click that reorders the list and
// consumed by the very next layout effect, never something a render reads.
const questionFlipFrom = new Map<HTMLElement, Map<HTMLElement, number>>()

export function QuestionCard({
  specs,
  disabled,
  expired,
  answeredText,
  onSubmit,
}: {
  specs: QuestionSpec[]
  disabled: boolean
  // The turn that asked ended without an answer, so the CLI is no longer
  // listening on the control channel. The card stays fillable - onSubmit posts
  // the answers as a normal message instead - but says so, rather than offering
  // a Submit that quietly goes nowhere.
  expired?: boolean
  // Set once the head has recorded an answer (the tool_result text) - renders
  // the card settled even across a reconnect, where local state is lost.
  answeredText?: string
  // Returns true when the answers were actually handed to the socket.
  onSubmit: (answers: Record<string, string>, annotations: QuestionAnnotations) => boolean
}) {
  const [selected, setSelected] = useState<Set<number>[]>(() => specs.map(() => new Set<number>()))
  const [other, setOther] = useState<string[]>(() => specs.map(() => ''))
  // Free-text notes that ride ALONGSIDE the picked options rather than
  // replacing them ("Postgres, but keep the schema in one file") - the CLI's
  // AskUserQuestion takes these as `annotations[question].notes` and renders
  // them into the tool result next to the answer. One per picked row, so a
  // multi-select can qualify each of its choices separately; they are merged
  // into the single string the protocol carries on the way out.
  const [notes, setNotes] = useState<NoteMap[]>(() => specs.map(() => ({})))
  // Whether the "Other" row is selected, per question. Explicit state (not
  // derived from the text) so a typed-but-then-rejected free text can stay in
  // the box while a real option is picked instead.
  const [otherSel, setOtherSel] = useState<boolean[]>(() => specs.map(() => false))
  // Two ways a card settles locally, kept apart because one of them can be
  // taken back: `submitted` is an answer handed to the CLI's control channel
  // (optimistic - the daemon can still come back and say that request was
  // already retired), `sent` is answers posted as an ordinary message, which
  // is simply gone.
  const [submitted, setSubmitted] = useState(false)
  const [sent, setSent] = useState(false)
  // `submitted` stops counting the moment the card is known expired: that is
  // the daemon reporting it never delivered the answer (question_expired), so
  // the optimistic "Answered" was a lie and the card unlocks for the message
  // route. `sent` and a recorded result are final either way.
  const answered = (submitted && !expired) || sent || answeredText != null

  // On a resume the card mounts already-answered with no local selection - and
  // the same holds if it was answered in another tab. Recover the chosen
  // options from the recorded result so the settled card highlights them just
  // as it did right after answering. A live answer in this tab keeps its own
  // local selection, so only fall back when nothing was picked here.
  const derived = useMemo(
    () => (answeredText != null ? deriveAnswered(specs, answeredText) : null),
    [specs, answeredText],
  )
  const localEmpty =
    selected.every((s) => s.size === 0) &&
    other.every((v) => v.trim() === '') &&
    otherSel.every((v) => !v) &&
    notes.every((m) => Object.keys(m).length === 0)
  const showSelected = derived && localEmpty ? derived.selected : selected
  const showOther = derived && localEmpty ? derived.other : other
  const showOtherSel = derived && localEmpty ? derived.other.map((v) => v !== '') : otherSel
  const showNotes = derived && localEmpty ? derived.notes : notes

  // A note belongs with the choice it qualifies, so it trails whichever row you
  // picked rather than sitting at the foot of the card. Moving it is a FLIP:
  // every row keeps its size and only slides, so the question's height is the
  // same before, during and after - nothing below it jumps. Positions are
  // snapshotted in the click that reorders the list, so typing in the note
  // (which regrows it on every keystroke) never sets an animation going.
  function snapshotRows(origin: Element | null) {
    const el = origin?.closest<HTMLElement>('[data-question-rows]')
    if (!el) return
    const from = new Map<HTMLElement, number>()
    for (const row of Array.from(el.children)) from.set(row as HTMLElement, (row as HTMLElement).offsetTop)
    questionFlipFrom.set(el, from)
  }

  useLayoutEffect(() => {
    if (questionFlipFrom.size === 0) return
    const pending = new Map(questionFlipFrom)
    questionFlipFrom.clear()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    for (const [el, from] of pending) {
      for (const row of Array.from(el.children) as HTMLElement[]) {
        const was = from.get(row)
        if (was == null) continue
        const delta = was - row.offsetTop
        if (delta === 0) continue
        // Element.animate is absent in jsdom, where the slide is untestable
        // anyway - the reorder itself is what the tests assert.
        row.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
          duration: 200,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        })
      }
    }
  })

  function toggleOption(origin: Element | null, qi: number, oi: number) {
    if (answered) return
    snapshotRows(origin)
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
    // Picking a real option in a single-select takes over from "Other" (the
    // typed text stays in the box, just deselected), and carries any note over
    // with it - in a single-select there is only ever one answer for a note to
    // belong to, so stranding it on the row you just moved off would lose it.
    if (!specs[qi].multiSelect) {
      setOtherSel((prev) => prev.map((v, i) => (i === qi ? false : v)))
      moveNote(qi, noteKey(oi))
    }
  }

  // Select (or, when the dot itself is clicked, toggle) the "Other" row.
  // Clicking anywhere in the row and typing both select it; in a single-select
  // that clears the picked option, mirroring toggleOption's takeover.
  function selectOther(origin: Element | null, qi: number, next = true) {
    if (answered) return
    if (next !== otherSel[qi]) snapshotRows(origin)
    setOtherSel((prev) => prev.map((v, i) => (i === qi ? next : v)))
    if (next && !specs[qi].multiSelect) {
      setSelected((prev) => prev.map((s, i) => (i === qi ? new Set<number>() : s)))
      moveNote(qi, noteKey('other'))
    }
  }

  // Re-key a single-select's one note onto the row now holding the answer.
  function moveNote(qi: number, to: string) {
    setNotes((prev) =>
      prev.map((m, i) => {
        if (i !== qi) return m
        const from = Object.keys(m)
        if (from.length === 0 || (from.length === 1 && from[0] === to)) return m
        return { [to]: m[from[0]] }
      }),
    )
  }

  function setNote(qi: number, at: number | 'other', value: string | null) {
    setNotes((prev) =>
      prev.map((m, i) => {
        if (i !== qi) return m
        const next = { ...m }
        if (value === null) delete next[noteKey(at)]
        else next[noteKey(at)] = value
        return next
      }),
    )
  }

  // Whether `at` is part of the answer, and so whether a note on it counts.
  function rowPicked(qi: number, at: number | 'other') {
    return at === 'other' ? showOtherSel[qi] : showSelected[qi].has(at)
  }

  // The rows carrying a note, in the order submit() merges them.
  function notedSlots(qi: number) {
    const slots = [...showSelected[qi]]
      .sort((a, b) => a - b)
      .map((oi) => ({ key: noteKey(oi), label: specs[qi].options[oi].label }))
    if (showOtherSel[qi]) slots.push({ key: noteKey('other'), label: showOther[qi].trim() || 'Other' })
    return slots.filter((s) => (showNotes[qi][s.key] ?? '').trim() !== '')
  }

  // A note now always belongs to a picked row, so answering means picking
  // something - except for "Other" selected with only a note in it, which the
  // CLI records as `(no option selected) notes: ...` and handles fine.
  const complete = specs.every(
    (_, i) =>
      selected[i].size > 0 ||
      (otherSel[i] && (other[i].trim() !== '' || (notes[i][noteKey('other')] ?? '').trim() !== '')),
  )

  // The corner trigger that opens (or discards) the note on a row. Hidden until
  // the row is hovered or the trigger itself is focused, so an untouched card
  // is still just a list of options - but it is a real button in the tab order
  // either way, since a control that only exists on hover is unreachable by
  // keyboard.
  function noteTrigger(qi: number, at: number | 'other') {
    if (answered) return null
    const open = rowPicked(qi, at) && showNotes[qi][noteKey(at)] !== undefined
    return (
      <Tooltip content={open ? 'Discard note' : 'Add a note'} side="top" className="absolute right-1 top-1">
        <button
          type="button"
          aria-label={open ? 'Discard note' : 'Add a note'}
          onClick={(e) => {
            e.stopPropagation()
            snapshotRows(e.currentTarget)
            if (open) {
              // Closing drops the note entirely: one left in state but out of
              // sight would still be submitted.
              setNote(qi, at, null)
              return
            }
            // Opening from a row that is not picked picks it first, so the note
            // lands where you asked for it. In a single-select that also moves
            // any existing note here, which must not then be blanked.
            if (at === 'other') selectOther(e.currentTarget, qi)
            else if (!selected[qi].has(at)) toggleOption(e.currentTarget, qi, at)
            setNotes((prev) =>
              prev.map((m, i) =>
                i !== qi || m[noteKey(at)] !== undefined ? m : { ...m, [noteKey(at)]: '' },
              ),
            )
          }}
          className={`flex h-5 w-5 cursor-pointer items-center justify-center rounded text-stone-400 opacity-0 transition-opacity hover:bg-black/[0.04] hover:text-stone-600 focus-visible:opacity-100 group-hover:opacity-100 dark:text-stone-500 dark:hover:bg-white/10 dark:hover:text-stone-300 ${
            open ? 'opacity-100' : ''
          }`}
        >
          {open ? <X className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
        </button>
      </Tooltip>
    )
  }

  // The note itself, rendered inside the row it qualifies - under a hairline,
  // and indented to the row's LABEL rather than its edge (ml-8 = the px-2.5
  // padding plus the dot and its gap), so it reads as part of what that option
  // says rather than as another row that happens to share the box.
  function noteBody(qi: number, at: number | 'other') {
    const value = showNotes[qi][noteKey(at)]
    if (value === undefined || !rowPicked(qi, at)) return null
    return (
      <div className="mb-1.5 ml-8 mr-2.5 flex items-start gap-2 border-t border-dashed border-[#c96442]/30 pt-1 dark:border-[#e0a184]/25">
        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400 dark:text-stone-500" />
        {/* Auto-grows the same way the "Other" box does - an invisible span in
            the same grid cell drives the height. */}
        <div className="grid min-w-0 flex-1">
          <span aria-hidden className="col-start-1 row-start-1 invisible whitespace-pre-wrap break-words text-xs leading-4">
            {value + ' '}
          </span>
          <textarea
            rows={1}
            autoFocus={value === '' && !answered}
            value={value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNote(qi, at, e.target.value)}
            onKeyDown={(e) => {
              // Enter submits, as in the "Other" box; shift+Enter is a newline,
              // which a note wants more often than an option label does.
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              e.stopPropagation()
              submit()
            }}
            disabled={answered}
            placeholder="Note to go with your answer..."
            aria-label="Note to go with your answer"
            className="col-start-1 row-start-1 min-w-0 resize-none overflow-hidden bg-transparent p-0 text-xs leading-4 placeholder-stone-400 dark:placeholder-stone-500 outline-none disabled:opacity-100"
          />
        </div>
      </div>
    )
  }

  function submit() {
    if (!complete || answered || disabled) return
    const answers: Record<string, string> = {}
    const annotations: QuestionAnnotations = {}
    for (const [i, q] of specs.entries()) {
      const labels = [...selected[i]].sort((a, b) => a - b).map((oi) => q.options[oi].label)
      if (otherSel[i] && other[i].trim()) labels.push(other[i].trim())
      answers[q.question] = labels.join(', ')
      // The protocol carries one note per question, so several are merged into
      // "<label>: <text>" segments. A lone note stays plain - most answers have
      // exactly one, and labelling it would only restate the answer.
      const noted = notedSlots(i)
      if (noted.length === 1) annotations[q.question] = { notes: notes[i][noted[0].key].trim() }
      else if (noted.length > 1) {
        annotations[q.question] = {
          notes: noted.map((sl) => `${sl.label}: ${notes[i][sl.key].trim()}`).join(NOTE_JOIN),
        }
      }
    }
    if (!onSubmit(answers, annotations)) return
    if (expired) setSent(true)
    else setSubmitted(true)
  }

  return (
    <div className="max-w-xl rounded-xl border border-stone-200 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] p-3 space-y-3">
      {specs.map((q, qi) => {
        // The note lives INSIDE the row you picked, so a caveat is visibly part
        // of the answer it qualifies rather than a separate thing below it - and
        // a multi-select can carry one per pick.
        const rows: ReactNode[] = []
        const options = q.options.map((o, oi) => {
              const isSel = showSelected[qi].has(oi)
              // The border, background and rounding belong to a wrapper, not to
              // the clickable button: a <textarea> cannot live inside a
              // <button>, so the note has to be the button's SIBLING while
              // still sitting inside the same box.
              return (
                <div
                  key={oi}
                  className={`group relative rounded-lg border transition-colors ${
                    isSel
                      ? 'border-[#c96442]/60 bg-[#c96442]/[0.07]'
                      : 'border-stone-200 dark:border-white/[0.07] hover:border-stone-300 dark:hover:border-white/[0.15]'
                  } ${answered && !isSel ? 'opacity-50' : ''}`}
                >
                  <button
                    onClick={(e) => toggleOption(e.currentTarget, qi, oi)}
                    disabled={answered}
                    className={`flex w-full items-start gap-2 px-2.5 py-1.5 pr-7 text-left ${
                      answered ? 'cursor-default' : 'cursor-pointer'
                    }`}
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
                  {noteTrigger(qi, oi)}
                  {noteBody(qi, oi)}
                </div>
              )
            })
        // "Other" renders as one more option row: it has its own dot and is
        // selected by clicking the row, typing in it, or toggling the dot - and
        // a settled card highlights it like any picked option.
        const other = (() => {
              const isSel = showOtherSel[qi]
              return (
                <div
                  key="other"
                  onClick={(e) => selectOther(e.currentTarget, qi)}
                  className={`group relative w-full rounded-lg border transition-colors ${
                    answered ? 'cursor-default' : 'cursor-text'
                  } ${
                    isSel
                      ? 'border-[#c96442]/60 bg-[#c96442]/[0.07]'
                      : 'border-stone-200 dark:border-white/[0.07] hover:border-stone-300 dark:hover:border-white/[0.15]'
                  } ${answered && !isSel ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-start gap-2 px-2.5 py-1.5 pr-7">
                  <button
                    type="button"
                    disabled={answered}
                    aria-label={isSel ? 'Deselect Other' : 'Select Other'}
                    aria-pressed={isSel}
                    onClick={(e) => {
                      // The dot is the one spot that can also DEselect.
                      e.stopPropagation()
                      selectOther(e.currentTarget, qi, !otherSel[qi])
                    }}
                    className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                      q.multiSelect ? 'rounded' : 'rounded-full'
                    } ${isSel ? 'border-[#c96442] bg-[#c96442]' : 'border-stone-300 dark:border-stone-500'} ${
                      answered ? 'cursor-default' : 'cursor-pointer'
                    }`}
                  >
                    {isSel && <Check className="h-2.5 w-2.5 text-white" />}
                  </button>
                  {/* A textarea, not an input, so a long custom answer wraps
                      onto more lines instead of being clipped. It auto-grows
                      with no JS: an invisible span holding the same text sits
                      in the same grid cell and drives the height, so it also
                      re-fits when the pane is resized. */}
                  <div className="grid min-w-0 flex-1">
                    <span
                      aria-hidden
                      className="col-start-1 row-start-1 invisible whitespace-pre-wrap break-words text-xs leading-4"
                    >
                      {showOther[qi] + ' '}
                    </span>
                    <textarea
                      rows={1}
                      value={showOther[qi]}
                      onChange={(e) => {
                        const v = e.target.value
                        setOther((prev) => prev.map((p, i) => (i === qi ? v : p)))
                        // Typing claims the selection.
                        selectOther(e.currentTarget, qi)
                      }}
                      onFocus={(e) => selectOther(e.currentTarget, qi)}
                      onKeyDown={(e) => {
                        // Enter submits the card, like the composer (shift+Enter
                        // still inserts a newline). Ignored while an IME is
                        // composing, and a no-op if another question is still
                        // unanswered (submit() gates on `complete`).
                        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                        e.preventDefault()
                        e.stopPropagation()
                        submit()
                      }}
                      disabled={answered}
                      placeholder="Other..."
                      className="col-start-1 row-start-1 min-w-0 resize-none overflow-hidden bg-transparent p-0 text-xs leading-4 placeholder-stone-400 dark:placeholder-stone-500 outline-none disabled:opacity-100"
                    />
                  </div>
                  </div>
                  {noteTrigger(qi, 'other')}
                  {noteBody(qi, 'other')}
                </div>
              )
            })()
        options.forEach((row) => rows.push(row))
        rows.push(other)
        return (
          <div key={qi} className="space-y-1.5">
            <div className="flex items-baseline gap-1.5">
              {q.header && (
                <span className="shrink-0 rounded bg-[#c96442]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#a8522f] dark:text-[#e0a184]">
                  {q.header}
                </span>
              )}
              <span className="font-medium">{q.question}</span>
            </div>
            <div className="space-y-1" data-question-rows>
              {rows}
            </div>
          </div>
        )
      })}
      {expired && !answered && (
        <div className="text-[11px] text-stone-500 dark:text-stone-400">
          This turn ended before the question was answered, so the agent is no longer waiting on it - your answer goes
          back as an ordinary message instead.
        </div>
      )}
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
          {expired
            ? sent
              ? 'Sent'
              : 'Send as message'
            : answered
              ? 'Answered'
              : specs.length > 1
                ? 'Submit all'
                : 'Submit'}
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
  // The chip clicked, so the picture flies out of it instead of fading in.
  const [lightboxOrigin, setLightboxOrigin] = useState<Element | null>(null)
  // Nothing left after stripping the CLI's image placeholder (item 41) - don't
  // render an empty bubble.
  if (!body && attachments.length === 0 && !sending && !dimmed) return null
  const openable = openableAttachments(attachments)
  const lightboxItems = attachmentLightboxItems(attachments)
  return (
    <div className="flex flex-col items-end gap-1">
      {/* Copying out of a bubble is handled by the transcript's copy-as-markdown
          handler (copyTranscriptAsMarkdown), which also trims the trailing
          newlines the browser adds for the bubble's block padding. */}
      <div className={`${USER_BUBBLE_CLASS}${sending || dimmed ? ' opacity-75' : ''}`}>
        {body && <Markdown text={body} />}
        {attachments.length > 0 && (
          <AttachmentChips
            attachments={attachments}
            size="sm"
            className={body ? 'mt-2' : ''}
            onOpen={(id, origin) => {
              setLightboxOrigin(origin)
              setLightboxIndex(openable.findIndex((a) => a.id === id))
            }}
          />
        )}
      </div>
      {/* No "Sending..." row: the dimmed (opacity-75) bubble already signals the
          in-flight state, and a row that appears then vanishes on confirm shifted
          the whole transcript below it. */}
      {lightboxIndex !== null && lightboxItems.length > 0 && (
        <Lightbox
          items={lightboxItems}
          index={Math.min(lightboxIndex, lightboxItems.length - 1)}
          origin={lightboxOrigin}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  )
})

// ContextNoteCard renders a collapsed CLI-injected "session continued" preamble
// (item 39): a compact pill naming what it is - a context compaction the model
// was handed to carry state over - that expands to the full summary on click,
// instead of dumping the whole block into the flow. outOfContext picks the label.
const ContextNoteCard = memo(function ContextNoteCard({ text, outOfContext }: { text: string; outOfContext: boolean }) {
  const [open, setOpen] = useState(false)
  const label = outOfContext
    ? 'Continued from a previous conversation (ran out of context)'
    : 'Continued from a previous conversation'
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[92%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer select-none"
        aria-expanded={open}
      >
        <History className="w-3 h-3 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className="w-full max-w-[92%]">
        <Expandable open={open}>
          <div className="mt-1.5 max-h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-stone-200 dark:border-white/[0.08] bg-stone-50 dark:bg-white/[0.02] px-3 py-2 text-xs text-stone-600 dark:text-stone-300">
            <Markdown text={text} />
          </div>
        </Expandable>
      </div>
    </div>
  )
})

// SkillCard renders a Skill's auto-loaded SKILL.md body: a compact "Skill
// loaded: <name>" header that expands to the instructions as markdown. It's
// context the model was fed, not a user turn, so it stays collapsed by default
// (the launch itself is already shown by the Skill tool card above it).
const SkillCard = memo(function SkillCard({ name, text }: { name: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[92%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer select-none"
        aria-expanded={open}
      >
        <Sparkles className="w-3 h-3 shrink-0" />
        <span className="truncate">Skill loaded: {name}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className="w-full max-w-[92%]">
        <Expandable open={open}>
          <div className="mt-1.5 max-h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-stone-200 dark:border-white/[0.08] bg-stone-50 dark:bg-white/[0.02] px-3 py-2 text-xs text-stone-600 dark:text-stone-300">
            <Markdown text={text} />
          </div>
        </Expandable>
      </div>
    </div>
  )
})

// MetaCard is the generic fallback for machine-injected (isMeta) context that
// isn't a recognised skill body - collapsed behind an expander so a future
// injection kind never dumps raw text into the flow (no per-string matcher
// needed, just the isMeta flag).
const MetaCard = memo(function MetaCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[92%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.07] transition-colors cursor-pointer select-none"
        aria-expanded={open}
      >
        <Info className="w-3 h-3 shrink-0" />
        <span className="truncate">Injected context</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className="w-full max-w-[92%]">
        <Expandable open={open}>
          <div className="mt-1.5 max-h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-stone-200 dark:border-white/[0.08] bg-stone-50 dark:bg-white/[0.02] px-3 py-2 text-xs text-stone-600 dark:text-stone-300">
            <Markdown text={text} />
          </div>
        </Expandable>
      </div>
    </div>
  )
})

// routeMetaText classifies a machine-injected (isMeta) `user` text block into a
// ChatItem: a skill body -> a SkillCard, anything else -> a generic MetaCard.
// Shared by the live and history reducers so both agree. Returns null for empty
// text (nothing to show).
//
// It also returns null for the CLI's image-downscale notice - a note to the
// model about mapping coordinates back, useless to a reader. New conversations
// never record it (the daemon drops it, see claudestream.IsHiddenChatMessage),
// but it is already in existing event logs, and there it is worse than noise:
// having missed the live stream it was backfilled at the very END of the log, so
// it rendered as an "Injected context" card hanging off a finished answer, as if
// something had been injected after it.
function routeMetaText(text: string): DistributiveOmit<ChatItem, 'id'> | null {
  const t = text.trim()
  if (!t || isImageResizeNotice(t)) return null
  const skill = detectSkillBody(t)
  if (skill) return { kind: 'skill', name: skill.name, text: skill.body }
  return { kind: 'meta', text: t }
}

// reduceHistoryEvents reduces a batch of older (settled) conversation events -
// the load-older page (item 25) - into ChatItems ready to prepend. It mirrors
// the live reducer's settled-event handling (no streaming, model or
// control_request state): user turns (classified like routeUserText),
// assistant text/thinking/tool_use/question blocks with tool_result patching,
// and result footers. A TodoWrite is dropped (the plan panel already holds the
// latest state, not this older one). allocId hands out ids for the batch.
// Exported only for its regression test (the page-boundary result carry below);
// AgentChat is otherwise a component module.
// eslint-disable-next-line react-refresh/only-export-components
export function reduceHistoryEvents(events: ProviderEvent[], allocId: () => number, durations?: Map<string, number>, tsOut?: Map<number, number>, link?: ToolResultLink): ChatItem[] {
  const items: ChatItem[] = []
  // The current event's transcript timestamp, carried forward over entries
  // without one - stamped per pushed item (tsOut) for the commit-chip interleave.
  let lastTs: number | null = null
  const push = (raw: DistributiveOmit<ChatItem, 'id'>) => {
    const id = allocId()
    if (lastTs != null) tsOut?.set(id, lastTs)
    items.push({ ...claimOrphanResult(link, raw), id } as ChatItem)
  }
  const patchTool = (toolUseId: string, text: string, isError: boolean, images: string[], raw?: unknown, editPatch?: EditHunk[] | null, cwdAfter?: string) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'tool' && it.toolUseId === toolUseId) {
        it.result = text
        it.isError = isError
        it.resultImages = images.length ? images : undefined
        it.rawResult = raw
        it.editPatch = editPatch ?? undefined
        it.cwdAfter = cwdAfter
        return
      }
      if (it.kind === 'question' && it.toolUseId === toolUseId) {
        it.result = text
        return
      }
    }
    // No card in this batch: its tool_use is in a page not loaded yet (this
    // batch's own older neighbour). Hold the result for whichever batch builds
    // it - the card is created by a LATER, older page, so patching forward is
    // the only way it can ever show its result.
    stashOrphanResult(link, toolUseId, { result: text, isError, images, raw, editPatch })
  }
  // Distinct task-notifications already rendered in this batch: the CLI records
  // each one several times (queue-operation, attachment, sometimes a consumed
  // user turn) and only ONE chip should show (mirrors the live reducer's
  // seenNotif).
  const seenNotifs = new Set<string>()
  // task-ids whose completion already rendered as the canonical "Sub-agent
  // finished" chip (from a subagent_completed event). The user turn that
  // resumed the parent re-states the same notification; suppress that second
  // chip (mirrors the live reducer's renderedSubCompletions).
  const subCompletions = new Set<string>()
  const pushNotification = (text: string) => {
    const taskId = /<task-id>([\s\S]*?)<\/task-id>/.exec(text)?.[1]?.trim()
    const toolUseId = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(text)?.[1]?.trim()
    const taskStatus = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim()
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
    const outputFile = /<output-file>([\s\S]*?)<\/output-file>/.exec(text)?.[1]?.trim()
    if (taskId && subCompletions.has(taskId)) return
    const dedupKey = `${taskId ?? ''}\0${toolUseId ?? ''}\0${taskStatus ?? ''}\0${summary ?? ''}`
    if (seenNotifs.has(dedupKey)) return
    seenNotifs.add(dedupKey)
    push({ kind: 'notice', text: decodeEntities(summary || 'Background task update'), taskId, toolUseId, outputFile, noEntrance: true })
  }
  const routeUser = (rawText: string, isMeta?: boolean) => {
    // Machine-injected context (a skill body etc.) is not a user turn - route it
    // to a skill/meta card off the isMeta flag, before any content-sniffing.
    if (isMeta) {
      const meta = routeMetaText(rawText)
      if (meta) push(meta)
      return
    }
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
    if (isTaskNotification(text)) {
      pushNotification(text)
      return
    }
    const ctxNote = detectContextNote(text)
    if (ctxNote) {
      push({ kind: 'contextNote', text, outOfContext: ctxNote.outOfContext })
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
    const evTs = parseEventTs(ev)
    if (evTs != null) lastTs = evTs
    // A <task-notification> bookkeeping record (queue-operation XML on
    // `content`, attachment XML on `attachment.prompt`): render its chip in
    // place, like the live relay does.
    const notifText =
      (typeof ev.content === 'string' && isTaskNotification(ev.content) && ev.content) ||
      (typeof ev.attachment?.prompt === 'string' && isTaskNotification(ev.attachment.prompt) && ev.attachment.prompt) ||
      ''
    if (notifText) {
      pushNotification(notifText)
      continue
    }
    if (ev.type === 'hydra_subagent_completed' && ev.subagentNotice) {
      const notice = ev.subagentNotice
      if (notice.key) subCompletions.add(notice.key)
      push({ kind: 'notice', text: `${notice.label} finished${notice.description ? ': ' + notice.description : ''}`, subagentKey: notice.key, noEntrance: true })
      continue
    }
    // A queued message consumed into a running turn: its queued_command
    // attachment is its only durable record (no plain user event exists) -
    // rebuild the user bubble from it, settling the prior turn's footer like
    // any real user turn.
    const queuedText = queuedCommandText(ev)
    if (queuedText != null) {
      flushHistFooter()
      push({ kind: 'user', text: queuedText })
      continue
    }
    if (ev.type === 'shellcmd' && ev.shell) {
      // A "!command" the user ran, replayed from history: render its card (no
      // optimistic running state on a fresh load - it already completed).
      flushHistFooter()
      push({
        kind: 'shellCmd',
        command: ev.shell.command,
        output: ev.shell.output,
        exitCode: ev.shell.exit_code,
        truncated: ev.shell.truncated,
        timedOut: ev.shell.timed_out,
        stopped: ev.shell.stopped,
        running: false,
      })
      continue
    }
    if (ev.type === 'user') {
      const content = ev.message?.content
      if (typeof content === 'string') {
        if (content.trim()) routeUser(content, ev.isMeta)
        continue
      }
      const editPatch = eventEditPatch(ev, content ?? [])
      for (const block of content ?? []) {
        if (block.type === 'text' && block.text?.trim()) routeUser(block.text, ev.isMeta)
        else if (block.type === 'tool_result' && block.tool_use_id) {
          const p = parseToolResult(block.content)
          patchTool(block.tool_use_id, p.text, block.is_error === true, p.images, rawResultBlock(block, providerEntry(ev)), editPatch, ev.cwd)
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
          // A page of older history is settled by definition, so a question in
          // it that still has no answer never got one and its request is long
          // gone - mark it expired up front (this reducer carries no
          // control_request state at all, so it could never be answered here
          // anyway; the flag is what tells the card to say so).
          if (specs) push({ kind: 'question', toolUseId: block.id, input: block.input, specs, expired: true })
          else if (todos) { /* older plan state - the panel already shows the latest */ }
          // Task* ops fall through to a normal tool card (like any other tool);
          // only the panel state is latest-wins, and that is driven by the live
          // reducer's replay, not this older page.
          else push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input, rawUse: rawUseBlock(block, providerEntry(ev)) })
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

// ── Step folding ────────────────────────────────────────────────────────────
// A turn's machinery - the thoughts it had and the tool calls it made - is what
// turns a long transcript into a wall: a dozen one-line cards around each thing
// the agent actually SAID. So a run of consecutive machinery items folds into
// one quiet line ("12 steps · Bash, Read, Edit") that expands in place.
//
// The RUNNING step folds in too, and that is what makes a live turn calm rather
// than merely tidy: with it left outside, every step grew a card and then took
// it away again a second later, so the transcript pulsed all turn. Folded in,
// the group is one line from beginning to end - the count ticks up and the
// header says what it is doing. Nothing below it moves.
//
// A Task card that upgraded into a SubagentCard is a conversation of its own
// rather than a step, so it breaks the run.
function isFoldableStep(it: ChatItem, subByToolUse: Record<string, SubagentView>): boolean {
  if (it.kind === 'thinking') return true
  if (it.kind !== 'tool') return false
  if (subByToolUse[it.toolUseId]) return false
  // Two tools are addressed to the READER rather than to the machine: a plan
  // put up for approval, and a command run outside the sandbox on the user's
  // own machine. Neither is a step to skim past, so neither folds.
  if (it.name === 'ExitPlanMode' || it.name === 'mcp__hydra__host_run') return false
  return true
}

// A row of the transcript: either one item as before, or a folded run of them.
export type StepRow = { row: 'item'; item: ChatItem } | { row: 'group'; id: number; items: ChatItem[] }

// planStepRows splits the item list into rows, folding each qualifying run.
// A run earns a group only once it holds two or more tool calls: one card (with
// or without the thought that led to it) is not a wall, and hiding it behind
// "1 step" costs more than it saves.
// eslint-disable-next-line react-refresh/only-export-components
export function planStepRows(items: ChatItem[], subByToolUse: Record<string, SubagentView>, grouped: boolean): StepRow[] {
  if (!grouped) return items.map((item) => ({ row: 'item', item }))
  const rows: StepRow[] = []
  let run: ChatItem[] = []
  const flush = () => {
    if (run.length === 0) return
    if (run.filter((it) => it.kind === 'tool').length >= 2) rows.push({ row: 'group', id: run[0].id, items: run })
    else for (const it of run) rows.push({ row: 'item', item: it })
    run = []
  }
  for (const it of items) {
    if (isFoldableStep(it, subByToolUse)) {
      run.push(it)
      continue
    }
    flush()
    rows.push({ row: 'item', item: it })
  }
  flush()
  return rows
}

// stepSummary describes a folded run in the collapsed header: how many tool
// calls, which tools (most-used first, so the shape of the run reads at a
// glance), how long it spent thinking, and how many steps failed. The tool list
// is capped at three names - past that it stops being a summary.
//
// The failure count is the one thing a fold must not swallow: a red card that
// scrolled past is how you notice the agent hit a wall and went around it, so
// the header says so and expanding shows which.
// eslint-disable-next-line react-refresh/only-export-components
export function stepSummary(items: ChatItem[]): {
  label: string
  tools: string
  thinkingMs: number
  failed: number
  // The step in flight right now, named, so a folded group can say what it is
  // doing instead of only that it is doing something.
  running: string
} {
  const counts = new Map<string, number>()
  let thinkingMs = 0
  let failed = 0
  let running = ''
  for (const it of items) {
    if (it.kind === 'thinking') {
      thinkingMs += it.durationMs ?? 0
      continue
    }
    if (it.kind !== 'tool') continue
    if (it.isError) failed++
    if (it.result === undefined && !it.ended) running = displayToolName(it.name)
    const name = displayToolName(it.name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  // The WHOLE list, most-used first, and no "+N more": the header clips it with
  // a CSS ellipsis instead. Two truncations stacked (a cap at three names, then
  // `truncate` over the top) meant a narrow pane spent its last characters
  // saying "+2 mo..." rather than naming another tool, and a wide one hid tools
  // it had room for. Letting the list run costs no layout shift either - it is
  // the one flexible cell in a row of shrink-0 ones, so its length never moves
  // anything.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const tools = ranked.map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(' · ')
  return { label: `${total} step${total === 1 ? '' : 's'}`, tools, thinkingMs, failed, running }
}

// GrowIn mounts CLOSED and opens on the next frame, so the "N steps" line grows
// into place rather than popping in above the steps it now owns. It is the only
// motion a group makes on its own: nothing ever folds itself while you are
// looking at it (see StepGroup).
function GrowIn({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    markSelfReflow()
    const t = setTimeout(() => setOpen(true), 16)
    return () => clearTimeout(t)
  }, [])
  return (
    <Expandable open={open}>
      <div data-step-grow className="animate-chat-item-in">
        {children}
      </div>
    </Expandable>
  )
}

// useGroupApproval reports whether any step in the group is parked on a
// security-gate approval. Folding the running step away is fine while it is just
// working, but a step waiting on YOU must never be behind a count: the group
// opens itself so the card's Allow/Deny row is on screen (see ToolApproval).
function useGroupApproval(items: ChatItem[]): boolean {
  const ctx = useContext(ChatApprovalContext)
  const parked = useApprovalStore((s) => (ctx ? s.pending[ctx.agentId] : undefined))
  if (!parked?.length) return false
  return items.some(
    (it) =>
      it.kind === 'tool' &&
      it.result === undefined &&
      parked.some((a) =>
        approvalMatchesTool(a, it.name, (typeof it.input === 'object' ? it.input : null) as Record<string, unknown> | null),
      ),
  )
}

// StepGroup is the run itself: one line while closed, the rows it holds while
// open (rendered by the caller through renderRow).
//
// It NEVER folds itself while you are looking at it. A group born while you are
// watching a turn starts open - you are here to watch the work, and a collapse
// under your eyes moves the text you are reading (a long run is a 1000px shrink,
// and the pane deliberately has no browser scroll anchoring). It stays open for
// the rest of the visit unless you close it yourself.
//
// The tidying happens on the way back in: fold state is per-mount, so leaving
// the page and returning - or a reload - renders every group folded, which is
// what liveFrom (the transcript's first live item id) distinguishes. A replayed
// transcript has no live items, so it comes back quiet.
function StepGroup({
  items,
  liveFrom,
  renderRow,
}: {
  items: ChatItem[]
  liveFrom: number | null
  renderRow: (item: ChatItem, animate: boolean) => ReactNode
}) {
  // Whether the group came into being while the reader was watching, rather than
  // arriving with a replayed transcript. That decides both how it enters (the
  // header grows in above steps already on screen) and how it starts: open for a
  // live run, folded for history.
  const [bornLive] = useState(() => liveFrom != null && items.some((it) => it.id >= liveFrom))
  const [open, setOpen] = useState(bornLive)
  const { label, tools, thinkingMs, failed, running } = stepSummary(items)
  // A parked approval overrides the fold: the row you have to answer is inside.
  const needsApproval = useGroupApproval(items)
  const shown = open || needsApproval
  // Whether each step gets the entrance fade, decided ONCE - the first time the
  // group sees it - and then held, so a later render can't strip the class
  // mid-animation.
  //
  // A step fades in if it lands while the group is already open: that is a
  // message arriving, exactly as it would outside a group. It does NOT fade if
  // it is on screen because you just opened the group, or because the group was
  // born around steps that were already there - both are old work being
  // revealed, and a dozen cards fading in at once reads as a dozen things
  // happening at once. A step that arrived while the group was folded is old by
  // the time you open it, so it is settled here too.
  const [entered, setEntered] = useState<Map<number, boolean>>(() => new Map(items.map((it) => [it.id, false])))
  const fresh = items.filter((it) => !entered.has(it.id))
  if (fresh.length > 0) {
    // Render-phase adjustment (as in useDelayedUnmount): the decision has to be
    // in place for this render, not a frame later.
    const next = new Map(entered)
    for (const it of fresh) next.set(it.id, shown)
    setEntered(next)
  }
  const header = (
    <button
      // Closing the group shrinks the transcript, which clamps scrollTop down
      // and reads like a scroll-up to the pin logic - the same false positive a
      // fold used to cause (see markSelfReflow).
      onClick={() => {
        markSelfReflow()
        setOpen((o) => !o)
      }}
      className="group flex w-full items-center gap-1.5 text-left cursor-pointer"
      aria-expanded={shown}
    >
      <ChevronRight
        className={`w-3 h-3 shrink-0 text-stone-400/70 dark:text-stone-500/70 transition-transform duration-200 ${shown ? 'rotate-90' : ''}`}
      />
      <span className="shrink-0 font-medium text-stone-400 dark:text-stone-500 group-hover:text-stone-600 dark:group-hover:text-stone-300 transition-colors">
        {label}
      </span>
      {!shown && tools && <span className="min-w-0 truncate text-stone-400/80 dark:text-stone-500/80">{tools}</span>}
      {/* What it THOUGHT about is a settled-run detail: while the group is live
          the right-hand chip below is saying what it is doing, and a narrow pane
          has room for one of the two. */}
      {!shown && thinkingMs > 0 && !running && !needsApproval && (
        <span className="shrink-0 text-stone-400/70 dark:text-stone-500/70">
          · Thought for {formatDuration(Math.max(1000, Math.ceil(thinkingMs / 1000) * 1000))}
        </span>
      )}
      {!shown && failed > 0 && (
        <span className="shrink-0 text-red-500/80 dark:text-red-400/80">· {failed} failed</span>
      )}
      {/* What the group is doing right now, in the ToolCard's own words and
          colour so a folded step reads like the card it replaces.

          Everything but the count is for the FOLDED state only. Open, the cards
          are right there saying it themselves - the red one is red, the running
          one says "running", the parked one carries its own Allow/Deny row - so
          repeating any of it on the header is just a second voice. */}
      {!shown && (needsApproval || running) && (
        <span className="ml-auto pl-1.5 shrink-0 text-[10px] text-amber-600 dark:text-amber-400/90 animate-pulse">
          {needsApproval ? 'needs approval' : `running ${running}`}
        </span>
      )}
    </button>
  )
  return (
    <div className="text-xs">
      {bornLive ? <GrowIn>{header}</GrowIn> : header}
      {/* The rows sit tighter than the transcript's gap-3 so an expanded run
          still reads as one block rather than as loose messages. */}
      <Expandable open={shown}>
        <div className="flex flex-col gap-2 pt-2">
          {items.map((it) => renderRow(it, entered.get(it.id) ?? false))}
        </div>
      </Expandable>
    </div>
  )
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
  // The in-flight streamed reply, rendered as the list's last row so the
  // settled event can take that row over in place. Kept out of `items` so the
  // settled rows' memo survives a per-frame stream update.
  liveItem: ChatItem | null
  liveFromId: number | null
  renderItem: (item: ChatItem, shellCwd?: string | null) => ReactNode
  serif: boolean
  connected: boolean
  worktreePath: string | null
  subByToolUse: Record<string, SubagentView>
  subagents: Record<string, SubagentView>
  // Where each Bash command ran (lib/shellCwd). Handed to the rows one value at
  // a time rather than read through the ref, because it is the one input that
  // can change for an OLD row: a late result revealing a `cd` that failed, or
  // older history loading in and moving the baseline. Per-row values keep that
  // from re-rendering the whole transcript every time a command is appended.
  shellCwds: Map<string, string | null>
}

// One settled row, memo'd per item so appending a new message renders ONLY the
// new row - not the whole transcript. renderItem reads the live serif / connected
// / worktree / subagents values through a ref, so those are passed here purely as
// memo keys (unused in the body): a change to any of them re-renders every row so
// its output can't go stale, but a plain message append leaves them untouched and
// the existing rows bail. `animate` is stable per row (liveFromId is fixed once
// replay completes), so a new message doesn't re-trigger neighbours' entrance.
interface SettledRowProps {
  item: ChatItem
  animate: boolean
  renderItem: (item: ChatItem, shellCwd?: string | null) => ReactNode
  shellCwd: string | null
  serif: boolean
  connected: boolean
  worktreePath: string | null
  subByToolUse: Record<string, SubagentView>
  subagents: Record<string, SubagentView>
}
// Which items count as "a message" for the open-on-the-last-message scroll
// (see alignToLastMessage): what the agent last said to the user, or asked. Tool
// cards, commit chips, notices and the like are the machinery around that, not
// the thing you came back to read.
function isChatMessage(item: ChatItem): boolean {
  return item.kind === 'assistant' || item.kind === 'question'
}

const SettledRow = memo(
  function SettledRow({ item, animate, renderItem, shellCwd }: SettledRowProps) {
    return (
      <div
        // Marks the row as a scroll target for alignToLastMessage; absent on
        // rows it should skip, so a plain querySelectorAll finds the candidates.
        data-chat-message={isChatMessage(item) ? '' : undefined}
        className={animate ? 'animate-chat-item-in' : undefined}
      >
        {renderItem(item, shellCwd)}
      </div>
    )
  },
  (a, b) =>
    a.item === b.item &&
    a.animate === b.animate &&
    a.renderItem === b.renderItem &&
    a.shellCwd === b.shellCwd &&
    a.serif === b.serif &&
    a.connected === b.connected &&
    a.worktreePath === b.worktreePath &&
    a.subByToolUse === b.subByToolUse &&
    a.subagents === b.subagents,
)

const SettledMessages = memo(
  function SettledMessages({ items, liveItem, liveFromId, renderItem, serif, connected, worktreePath, subByToolUse, subagents, shellCwds }: SettledMessagesProps) {
    // Read straight from the store rather than as a prop: a zustand subscription
    // re-renders this component on its own, so flipping the setting refreshes
    // the list without threading the value through every memo comparator.
    const grouped = useChatStepsStore((s) => s.grouped)
    // animate is the ENTRANCE fade, for a message arriving live. A row inside a
    // step group is handed the group's own answer for it: a step that lands
    // while the group is open fades in like any other message, one revealed by
    // opening the group does not (see StepGroup).
    const row = (item: ChatItem, animate = true) => (
      <SettledRow
        key={item.id}
        item={item}
        animate={animate && liveFromId != null && item.id >= liveFromId && !('noEntrance' in item && item.noEntrance)}
        renderItem={renderItem}
        shellCwd={(item.kind === 'tool' && shellCwds.get(item.toolUseId)) || null}
        serif={serif}
        connected={connected}
        worktreePath={worktreePath}
        subByToolUse={subByToolUse}
        subagents={subagents}
      />
    )
    // The settled rows are memoized as ELEMENTS, not just per-row components: a
    // streamed reply re-renders this list once per animation frame (it is the
    // last row, see liveItem), and handing React the identical element objects
    // back lets it bail on each settled subtree instead of rebuilding an element
    // per row 60 times a second. The deps are exactly this component's memo keys
    // below.
    const rows = useMemo(
      () =>
        planStepRows(items, subByToolUse, grouped).map((r) =>
          r.row === 'item' ? (
            row(r.item)
          ) : (
            <StepGroup key={`steps-${r.id}`} items={r.items} liveFrom={liveFromId} renderRow={row} />
          ),
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `row` is a per-render closure over these same deps
      [items, grouped, liveFromId, renderItem, serif, connected, worktreePath, subByToolUse, subagents, shellCwds],
    )
    // ONE keyed list, live row included. It has to be the same list the settled
    // row lands in: a separate slot beside it would be a separate position, and
    // React would tear the live node down to build the settled one - which is
    // the whole thing this arrangement exists to avoid.
    return <>{liveItem ? [...rows, row(liveItem)] : rows}</>
  },
  (a, b) =>
    a.items === b.items &&
    a.liveItem === b.liveItem &&
    a.liveFromId === b.liveFromId &&
    a.renderItem === b.renderItem &&
    a.shellCwds === b.shellCwds &&
    a.serif === b.serif &&
    a.connected === b.connected &&
    a.worktreePath === b.worktreePath &&
    a.subByToolUse === b.subByToolUse &&
    a.subagents === b.subagents,
)

export function ChatPane({ agentId, agentType, projectId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh, onSelectCommit }: ChatProps) {
  const usesNormalizedEvents = agentType === 'claude' || agentType === 'codex'
  const [items, setItems] = useState<ChatItem[]>([])
  // Wall-clock time per item id (epoch ms) - the message side of the
  // commit-chip interleave. Stamped by the reducers: replayed events carry the
  // transcript's own timestamp (carried forward over ring lines, which have
  // none), live items use arrival time. A side map rather than a ChatItem
  // field so the many push/setItems sites stay untouched.
  const itemTsRef = useRef<Map<number, number>>(new Map())
  // ── Commit chips ─────────────────────────────────────────────────────────
  // The branch's commits (oldest first), rendered as notification chips
  // interleaved into the transcript (see mergedItems). Fetched on mount /
  // reconnect and again on every head_moved diff_refresh frame - git is the
  // durable record, so replay needs no persisted chat event.
  const [commitChips, setCommitChips] = useState<CommitChipItem[]>([])
  // Chip bookkeeping: `cache` keeps each sha's chip (and id) identity-stable
  // across refetches so SettledRow's memo holds; ids allocate far above the
  // live reducer's (from 1) and the history pager's (negative), so they never
  // collide. Chips from the first fetch are noEntrance - only commits that
  // land while the transcript is on screen animate in. inflight/again coalesce
  // concurrent fetches (a burst of head_moved frames) into one trailing rerun.
  const chipStateRef = useRef({
    cache: new Map<string, CommitChipItem>(),
    nextId: 2_000_000_000,
    sig: '',
    loadedOnce: false,
    inflight: false,
    again: false,
  })
  const fetchCommitsRef = useRef<() => void>(() => {})
  const fetchCommits = useCallback(() => {
    if (usesNormalizedEvents) return
    const st = chipStateRef.current
    if (st.inflight) {
      st.again = true
      return
    }
    st.inflight = true
    api.default.getAgentCommits(projectId ?? '', agentId)
      .then((commits) => {
        const firstLoad = !st.loadedOnce
        st.loadedOnce = true
        // Only rebuild state when the list actually changed, so an idle
        // refetch never re-renders the transcript.
        const sig = commits.map((c) => c.sha).join('\0')
        if (sig === st.sig) return
        st.sig = sig
        const chips = commits.map((c) => {
          let chip = st.cache.get(c.sha)
          if (!chip) {
            chip = {
              kind: 'commit',
              id: st.nextId++,
              sha: c.sha,
              shortSha: c.short_sha,
              subject: (c.subject ?? c.message).split('\n')[0].trim(),
              ts: Date.parse(c.timestamp) || 0,
              noEntrance: firstLoad || undefined,
            }
            st.cache.set(c.sha, chip)
          }
          return chip
        })
        chips.sort((a, b) => a.ts - b.ts)
        setCommitChips(chips)
      })
      .catch(() => {})
      .then(() => {
        st.inflight = false
        if (st.again) {
          st.again = false
          fetchCommitsRef.current()
        }
      })
  }, [agentId, projectId, usesNormalizedEvents])
  fetchCommitsRef.current = fetchCommits
  useEffect(() => {
    fetchCommits()
  }, [fetchCommits, reconnectAttempt])
  // Thinking-block durations the daemon measured, keyed by assistant message id
  // (delivered as hydra_thinking events - replayed from the head's sidecar on
  // connect, then live). The reducer reads this when it builds a thinking item;
  // a load-older batch reads it too (reduceHistoryEvents). A ref so both survive
  // re-renders and the whole connection's worth of durations stays in hand.
  const thoughtDurationsRef = useRef<Map<string, number>>(new Map())
  // The in-flight streamed content block (token streaming via stream_event
  // deltas), superseded by the complete assistant event that follows it. A
  // streamed REPLY renders as the transcript's last row (see liveItem); a
  // streamed THOUGHT renders as its own card below it.
  // `id` is the transcript-item id the block is rendered under, so the settled
  // event can take the row over in place (see liveId in the reducer).
  const [stream, setStream] = useState<{ kind: 'assistant' | 'thinking'; text: string; id: number } | null>(null)
  // The agent's current plan (its latest TodoWrite), shown in the floating
  // PlanPanel (item 17). Empty until the agent writes a to-do list.
  // Seeded from the persisted plan (planStore) so navigating away and back shows
  // the last known plan even when the replay window no longer includes the
  // TaskCreate events. Live events reconcile on top (see the reducer).
  const [todos, setTodos] = useState<TodoItem[]>(() =>
    loadPlan(projectId, agentId)
      .sort((a, b) => a.order - b.order)
      .map(({ content, status, activeForm, description }) => ({ content, status, activeForm, description })),
  )
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
  // True a beat after the replay settles: floating cards (plan, sub-agent
  // selector) that MOUNT after this fade in - they appeared live - while cards
  // restored by the replay itself render without the entrance animation (a
  // reload should not replay the fade every time).
  const liveUiRef = useRef(false)
  useEffect(() => {
    if (!replayDone) {
      liveUiRef.current = false
      return
    }
    const t = setTimeout(() => {
      liveUiRef.current = true
    }, 150)
    return () => clearTimeout(t)
  }, [replayDone])
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
  //
  // Undo/redo spans BOTH the typed text and the attachment chips: an image/file
  // paste (and its "[filename]" marker) calls preventDefault, so the browser's
  // native textarea undo never sees it and Ctrl+Z can't walk it back. `present`
  // is the live composer state; commit/undo/redo/reconcile/resetHistory drive the
  // snapshot stack (see composerHistory), mirroring the spawn box.
  const initialComposer = useRef<ReturnType<typeof makeSnapshot> | null>(null)
  if (!initialComposer.current) {
    initialComposer.current = makeSnapshot(
      loadAgentViewPrefs(projectId, agentId).chatDraft ?? '',
      loadChatAttachments(chatDraftKey(projectId, agentId)),
      0,
      0,
    )
  }
  const { present, commit, reconcile, reset: resetHistory, undo, redo } = useComposerHistory(initialComposer.current)
  const input = present.prompt
  const attachments = present.attachments
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
  const optimisticTextsRef = useRef<{ clientId: string; text: string }[]>([])
  // Client ids of "!command" cards shown optimistically as "running": when the
  // daemon's result event (a user_message carrying `shell`) arrives it settles
  // the matching card in place rather than appending a duplicate.
  const optimisticShellRef = useRef<Set<string>>(new Set())
  // Id of the optimistic "Set model to ..." confirmation (item 31), so the CLI's
  // real echo can supersede it. null when none is pending.
  const optimisticModelIdRef = useRef<number | null>(null)
  // Load-older infinite scroll (item 25): the uuid of the current oldest history
  // line (the paging anchor), a decreasing id space for prepended history (kept
  // well below the optimistic range so it never collides), an in-flight guard,
  // whether the transcript start has been reached, and the scrollHeight snapshot
  // used to keep the viewport anchored across a prepend.
  const oldestUuidRef = useRef<string | null>(null)
  const oldestEventCursorRef = useRef<string | null>(null)
  // Sub-agents whose full step history we've already asked the daemon for this
  // connection (opening their tab). A sub-agent's steps may live outside the
  // loaded main-conversation window, so its `items` would otherwise stay empty
  // until the user scrolled the main history back to where it ran.
  const requestedSubsRef = useRef<Set<string>>(new Set())
  const historyIdRef = useRef(-1_000_000)
  const loadingOlderRef = useRef(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [allHistoryLoaded, setAllHistoryLoaded] = useState(false)
  const pendingPrependRef = useRef<number | null>(null)
  // Composer attachments live in the undo history (`present.attachments`, above)
  // so a paste-turned-chip is undoable together with its text marker.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  // The chip clicked, so the picture flies out of it instead of fading in.
  const [lightboxOrigin, setLightboxOrigin] = useState<Element | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Current model, fed live by the event stream (system:init / set_model
  // confirmations). Seeded from AgentResponse.model - which the daemon captures
  // from the head's system:init line - so the selector shows the right model on
  // load instead of the "Model" placeholder, before the live stream re-confirms
  // it (see the serverModel effect below).
  const [model, setModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // Prompt-side tokens of the most recent message, i.e. how much context the
  // conversation currently occupies. Drives the "context left" chip beside the
  // model selector (item 40). Seeded to 0 and repopulated from replay on
  // reconnect (the latest message's usage wins).
  const [contextTokens, setContextTokens] = useState(0)
  const [slashCommands, setSlashCommands] = useState<string[]>([])
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // The currently-highlighted row in the slash popup, so keyboard nav can keep
  // it in view when the (now scrollable, uncapped) list overflows.
  const selectedSlashRef = useRef<HTMLButtonElement | null>(null)
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
  // Mirror of composerHeight the auto-grow effect compares against, so a
  // keystroke that doesn't change the height schedules no update at all (see
  // the effect for why React's own same-value bailout can't be relied on here).
  const composerHeightRef = useRef(composerHeight)
  const composerDragRef = useRef<{ startY: number; startRows: number; lineHeight: number } | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const normalizedAvailableRef = useRef(false)
  // Pending task_output requests (the expandable background-command chip
  // fetching its output file), resolved by the matching task_output frame.
  const taskOutputWaitersRef = useRef(new Map<string, (res: { content?: string; error?: string }) => void>())
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
  // rAF handle + last frame time for the smooth bottom-follow (see followBottom).
  const followRafRef = useRef<number | null>(null)
  const followPrevTimeRef = useRef(0)
  // The previous scroll event's offset, for telling an UPWARD user scroll apart
  // from our own (possibly lagging) pin-to-bottom writes - see onScroll.
  const prevScrollTopRef = useRef(0)
  // The previous scroll event's scrollHeight, so a content SHRINK that clamps
  // scrollTop down isn't misread as the user scrolling up - see onScroll.
  const prevScrollHeightRef = useRef(0)
  // Likewise the previous clientHeight: the pane growing (the composer shrinking
  // back down after a multi-line draft is deleted) also clamps scrollTop.
  const prevClientHeightRef = useRef(0)
  // Latest scroll offset + pin, mirrored on every scroll so deactivation (the
  // pane going display:none loses its scroll geometry) and unmount can persist
  // it (item 20).
  const lastScrollRef = useRef({ top: 0, pinned: true })

  const status = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.agent_status?.status)
  const isTurnRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  // Whether this agent still had unread changes when it was opened - the cue to
  // land on the top of its last message instead of pinned to the bottom (see
  // alignToLastMessage). null until the agent shows up in the list at all (on a
  // cold load the page can render before the list lands), so the first render
  // that KNOWS is the one that decides.
  //
  // Captured during render on purpose: opening an agent clears its unread flag
  // (__root's auto-clear effect), and effects run after render, so by the time
  // any effect of ours could read the store the answer would always be "read".
  const unreadNow = useAgentStore((s) => {
    const a = s.agents.find((x) => x.id === agentId)
    return a ? !!a.has_unread_changes : null
  })
  const [openedUnread, setOpenedUnread] = useState<{ key: string; unread: boolean | null }>(
    { key: `${agentId}\0${projectId}`, unread: unreadNow },
  )
  const unreadKey = `${agentId}\0${projectId}`
  if (openedUnread.key !== unreadKey) setOpenedUnread({ key: unreadKey, unread: unreadNow })
  else if (openedUnread.unread == null && unreadNow != null) setOpenedUnread({ key: unreadKey, unread: unreadNow })
  // Whether the chosen chat font (Settings -> Browser -> Fonts) is a serif. The
  // family itself arrives through the .chat-font class; this only picks the
  // serif TREATMENT - larger size, looser leading, real semibold - which reads
  // better for a serif and wrong for a sans. Still threaded through the memo
  // comparators below because it changes how every settled row renders.
  const serif = useChatIsSerif()
  // Which head the tool cards below can answer parked approvals for. Null with no
  // project (nothing to POST a decision to), which just leaves the toast.
  const approvalCtx = useMemo(() => (projectId ? { projectId, agentId } : null), [projectId, agentId])
  // Whether pasting an attachment also inserts its "[filename]" marker into the
  // composer (a Browser setting, default on).
  const pasteMarkers = usePasteMarkersStore((s) => s.enabled)
  // The head's worktree, for trimming absolute paths in tool cards (item 19).
  // Falls back to the archived list for a finished head.
  const worktreePath = useAgentStore(
    (s) => (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.worktree_path ?? null,
  )
  const branchName = useAgentStore(
    (s) => (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.branch_name ?? `hydra/${agentId}`,
  )
  // memo'd: <Markdown> is memo'd on its props, so a fresh object each render
  // would re-parse every rendered message on every keystroke in the composer.
  // agentId lets a markdown image resolve against this head's files.
  const chatLinkCtx = useMemo(
    () =>
      projectId
        ? { projectId, agentId, refStr: branchName, filePath: '', worktreePath: worktreePath ?? undefined }
        : undefined,
    [projectId, agentId, branchName, worktreePath],
  )
  // The server-persisted plan (AgentResponse.plan). On a fresh browser, this is
  // the only copy of the plan; seed it into localStorage (only when local is
  // empty) so the reconnect effect's loadPlan restores it. Runs when the value
  // arrives (the agent-list poll can land after mount).
  const serverPlan = useAgentStore(
    (s) => (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.plan,
  )
  useEffect(() => {
    const seeded = seedLocalPlan(projectId, agentId, serverPlan)
    if (seeded.length) {
      // Legitimate effect: seedLocalPlan writes to localStorage (a side effect that
      // belongs in an effect), and we adopt its result. Can't move to render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTodos(
        seeded
          .sort((a, b) => a.order - b.order)
          .map(({ content, status: st, activeForm, description }) => ({ content, status: st, activeForm, description })),
      )
    }
  }, [serverPlan, projectId, agentId])

  // The daemon-captured model (AgentResponse.model). Adopt it while the selector
  // is still on the placeholder, so the right model shows on load before any
  // live system:init lands. The live stream stays authoritative from there.
  const serverModel = useAgentStore(
    (s) => (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.model,
  )
  useEffect(() => {
    // Adopt the daemon-captured model only while the selector is still on its
    // placeholder (the `m || serverModel` functional update fills an empty value and
    // no more), so this never fights the authoritative live system:init - a benign,
    // intentional one-shot rather than a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (serverModel) setModel((m) => m || serverModel)
  }, [serverModel])

  // Smooth (paced) streaming - a Browser setting. Read inside the WS reducer's
  // per-frame flush via a ref so a mid-stream toggle takes effect on the next
  // frame without re-running the reducer effect.
  const smoothStream = useChatStreamStore((s) => s.smooth)

  const onStatusUpdateRef = useRef(onStatusUpdate)
  const onDiffRefreshRef = useRef(onDiffRefresh)
  // The current head status, read from inside the WS reducer closure (which is
  // pinned to its own render) to decide at replay_done whether a still-"working"
  // sub-agent is genuinely live or just stale replayed history (item 5).
  const isTurnRunningRef = useRef(isTurnRunning)
  // Whether an unanswered question replayed from history could still be live.
  // A head blocked on an AskUserQuestion is NOT "running": the elicitation
  // fires a Notification hook that parks it in needs_input (see
  // cli/trigger_hook.go), which is precisely the state a reload during a
  // pending question lands in. Any other resting state means the turn behind
  // the question is over and its answer channel with it (see expireQuestions).
  const questionMayBeLiveRef = useRef(false)
  const smoothStreamRef = useRef(smoothStream)
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate
    onDiffRefreshRef.current = onDiffRefresh
    isTurnRunningRef.current = isTurnRunning
    questionMayBeLiveRef.current = isTurnRunning || status === AgentStatus.NEEDS_INPUT
    smoothStreamRef.current = smoothStream
  })

  useEffect(() => {
    // Reconnect/re-navigation reset: this clears a dozen pieces of live state AND
    // several refs (normalizedAvailableRef, itemTsRef, thoughtDurationsRef...) in one
    // atomic pass before the transcript replays. The ref writes must stay in an
    // effect, so this whole reset stays here rather than moving to render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems([])
    normalizedAvailableRef.current = false
    itemTsRef.current = new Map()
    setStream(null)
    // Restore the persisted plan (not []) so a reconnect / re-navigation shows
    // the last known plan before the replay reconstructs it (planStore).
    setTodos(restoredPlan(projectId, agentId))
    setSubagents({})
    setReplayDone(false)
    setLiveFromId(null)
    // The replay re-emits the conversation's usage; the latest message wins.
    setContextTokens(0)
    // Durations are re-sent from the sidecar at the start of each connection.
    thoughtDurationsRef.current = new Map()
    // The transcript replay + the daemon's queue frame are authoritative for
    // this new connection, so drop the optimistic copies (queued bubbles and
    // in-flight "sending" messages) that would otherwise double them.
    setPendingSends([])
    optimisticTextsRef.current = []
    optimisticShellRef.current = new Set()
    optimisticIdRef.current = -1
    optimisticModelIdRef.current = null
    // Reset load-older paging for the fresh backfill.
    oldestUuidRef.current = null
    oldestEventCursorRef.current = null
    requestedSubsRef.current = new Set()
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
    // The request ids the daemon says the CLI is STILL blocked on, from the
    // pending_questions frame it sends just before replay_done - the authority
    // on which replayed question cards are answerable (see expireQuestions).
    // null means it didn't say (a driver-backed provider, or the simulation),
    // and the head-status heuristic decides instead.
    let livePendingQuestions: Set<string> | null = null
    // Assistant events arrive one content block per event but share the API
    // message id; if a CLI version ever re-emits blocks cumulatively, this
    // per-message seen-set keeps the reducer idempotent.
    const seenBlocks = new Map<string, Set<string>>()

    // --- Task* plan reconstruction (item 17, cont.) ------------------------
    // The plan is rebuilt from the agent's tool calls and republished to the
    // PlanPanel. The reducer itself lives in lib/planReducer (it is pure, and
    // tested there); here it is wired to the persisted plan on both ends - the
    // seed it starts from, and savePlan/setTodos on every change.
    const plan = createPlanBuilder(loadPlan(projectId, agentId), (entries) => {
      savePlan(projectId, agentId, entries)
      setTodos(toTodoItems(entries))
    })

    const pending: ChatItem[] = []
    // Tool results whose card belongs to a history page further back (see
    // ToolResultLink). Connection-scoped, like `items`: a reconnect rebuilds
    // the transcript from scratch, so the link starts empty with it.
    const toolResults = newToolResultLink()
    let flushScheduled = false
    const flush = () => {
      flushScheduled = false
      if (pending.length === 0) return
      const batch = pending.splice(0, pending.length)
      setItems((prev) => [...prev, ...batch])
    }
    // `forcedId` re-uses an id already on screen (the live streamed block's, see
    // liveId) so the settled row lands on the same React key and keeps its DOM.
    const push = (raw: DistributiveOmit<ChatItem, 'id'>, forcedId?: number) => {
      const id = forcedId ?? nextId++
      // Stamp the item's wall-clock time for the commit-chip interleave:
      // replayed events use the transcript's timestamp (prevEventTs carries it
      // forward over ring lines, which have none), live items arrival time.
      const ts = replaying ? prevEventTs : Date.now()
      if (ts != null) itemTsRef.current.set(id, ts)
      pending.push({ ...claimOrphanResult(toolResults, raw), id } as ChatItem)
      if (!replaying && !flushScheduled) {
        flushScheduled = true
        queueMicrotask(flush)
      }
      return id
    }
    // dropItem retracts a pushed item from wherever it currently lives - the
    // un-flushed batch or the committed state. Used to supersede an interim
    // notice (see handleTaskNotification).
    const dropItem = (id: number) => {
      const i = pending.findIndex((it) => it.id === id)
      if (i >= 0) {
        pending.splice(i, 1)
        return
      }
      itemTsRef.current.delete(id)
      setItems((prev) => prev.filter((it) => it.id !== id))
    }

    // Token-streaming buffer. Deltas can arrive far faster than the display
    // refreshes, so they accumulate here and the visible state is flushed once
    // per animation frame (~16ms at 60Hz, faster on high-refresh displays);
    // each refresh re-renders (and re-parses the markdown of) only the one
    // in-flight block, which stays small.
    //
    // streamBuf.text is the full received text; `revealed` is how many of its
    // chars are actually shown. With smooth streaming on (the default, a Browser
    // setting) each frame advances `revealed` toward the full length by a bounded
    // step, so a bursty upstream (the claude CLI flushes ~250-char deltas ~5x/sec)
    // is drained as steady, continuous typing instead of landing in chunks. The
    // step is proportional to the backlog (so it never falls arbitrarily behind)
    // with a floor (so slow streams still finish) and a cap (so a big burst never
    // dumps at once). Smooth off: reveal jumps straight to the full length.
    let streamBuf: { kind: 'assistant' | 'thinking'; text: string } | null = null
    let revealed = 0
    let streamFrame: number | null = null
    // The item id the in-flight block is rendered under. A live text block is a
    // real row in the transcript list (see liveItem), keyed by this id, and the
    // settled event that supersedes it REUSES the id - so React updates that row
    // in place instead of unmounting one node and mounting an identical one.
    // That is what keeps a text selection alive across the swap: a selection
    // anchored in a text node dies the moment the browser sees that node
    // removed, which is why selecting a reply while it streamed used to clear
    // itself a beat later. Allocated on the first rendered frame of a block,
    // consumed by the settle, and reset by the next block.
    let liveId: number | null = null
    // The kind and text last rendered under liveId, so a turn that ends without
    // the settled event ever arriving can still commit what was streamed.
    let liveKind: 'assistant' | 'thinking' | null = null
    let liveText: string | null = null
    const takeLiveId = () => {
      if (liveId == null) {
        liveId = nextId++
        // Stamp it like a pushed item so an interleaved commit chip sorts around
        // it the same way before and after it settles (see mergedItems).
        itemTsRef.current.set(liveId, Date.now())
      }
      return liveId
    }
    // The id to settle a finished block under: the one it is already rendered
    // with when this is the block we streamed, otherwise undefined (push then
    // allocates a fresh one as usual). Consumed, so a second block in the same
    // message can't claim the same row.
    const takeLive = (kind: 'assistant' | 'thinking'): number | undefined => {
      if (liveKind !== kind || liveId == null) return undefined
      const id = liveId
      liveId = null
      liveKind = null
      liveText = null
      return id
    }
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
    // Paced-reveal tuning (chars, per animation frame). See streamBuf's comment.
    const REVEAL_FLOOR = 3 // min chars/frame so a slow stream still finishes
    const REVEAL_RATE = 0.2 // drain this fraction of the backlog per frame
    const REVEAL_CAP = 40 // max chars/frame so a big burst never dumps at once
    const onStreamFrame = () => {
      streamFrame = null
      if (!streamBuf) return
      const full = streamBuf.text.length
      if (smoothStreamRef.current) {
        if (revealed < full) {
          const backlog = full - revealed
          const step = Math.min(REVEAL_CAP, Math.max(REVEAL_FLOOR, Math.ceil(backlog * REVEAL_RATE)))
          revealed = Math.min(full, revealed + step)
        }
      } else {
        revealed = full
      }
      liveKind = streamBuf.kind
      liveText = streamBuf.text.slice(0, revealed)
      setStream({ kind: liveKind, text: liveText, id: takeLiveId() })
      // Keep animating until the reveal catches up, even after deltas stop.
      if (revealed < full) scheduleStreamFlush()
    }
    const scheduleStreamFlush = () => {
      if (streamFrame != null) return
      streamFrame = requestAnimationFrame(onStreamFrame)
    }
    // Adopt the partial block the daemon reports in its attach snapshot: this
    // client connected mid-response, and the live socket only carries the
    // deltas from here on. Revealed in full rather than paced - that text was
    // produced before we connected, so typing it out would replay it at the
    // wrong moment - after which the remaining deltas stream normally.
    const seedStream = (kind: 'assistant' | 'thinking', text: string) => {
      streamBuf = { kind, text }
      revealed = text.length
      streamedKinds.add(kind)
      liveId = null
      liveKind = kind
      liveText = text
      setStream({ kind, text, id: takeLiveId() })
    }
    const stopStreamFrame = () => {
      revealed = 0
      if (streamFrame != null) {
        cancelAnimationFrame(streamFrame)
        streamFrame = null
      }
    }
    const clearStream = () => {
      streamBuf = null
      liveId = null
      liveKind = null
      liveText = null
      stopStreamFrame()
      setStream(null)
    }
    // The block is finished but its settled event hasn't arrived yet
    // (message_stop lands first, as its own frame). Keep the rendered row -
    // blanking it here is what made the text flash out and, worse, tore down the
    // node any selection in it was anchored to. It stays until the settled event
    // supersedes it in place, or the turn ends (see settleLiveStream).
    const endStream = () => {
      const full = streamBuf?.text ?? null
      const kind = streamBuf?.kind ?? null
      streamBuf = null
      stopStreamFrame()
      // Show the whole block: the paced reveal may still have been catching up,
      // and the settled event about to land would jump to the full text anyway.
      if (full != null && kind != null && full !== liveText) {
        liveKind = kind
        liveText = full
        setStream({ kind, text: full, id: takeLiveId() })
      }
    }
    // Commit whatever is still rendered live as a real item, under the same id,
    // when nothing else will: the turn ended (or was interrupted) without the
    // settled event that normally supersedes it.
    const settleLiveStream = () => {
      const kind = streamBuf?.kind ?? liveKind
      // The buffer (everything received) beats the revealed prefix: a turn cut
      // short should keep all of what the agent actually said.
      const text = streamBuf?.text ?? liveText
      if (kind == null || !text?.trim()) {
        clearStream()
        return
      }
      push({ kind, text, noEntrance: true }, takeLiveId())
      clearStream()
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
    // SendMessage tool_use id -> the agent it addressed, so its result (which
    // may name the agent only as `resumedAgentId`) can reopen the right sub.
    const messageTargetByUse = new Map<string, string>()
    // reopenMessagedSubagent puts a sub-agent back into the "working" state when
    // a SendMessage resumed it. Without this the sub keeps the finished state its
    // Task tool_result gave it long ago, so the UI claims it is done while it is
    // in fact running again - and the steps it streams land in a card that reads
    // as settled. Its next <task-notification> settles it again as usual.
    const reopenMessagedSubagent = (toolUseId: string, result: string) => {
      const parsed = parseSendMessageResult(result)
      if (!parsed || !parsed.ok || !parsed.resumed) return
      const agentId = parsed.recipient || messageTargetByUse.get(toolUseId) || ''
      const sub = agentId ? subLocal[agentId] : undefined
      if (!sub) return
      sub.status = 'running'
      sub.reopened = true
      // It was resumed in the BACKGROUND: it outlives the turn that messaged it,
      // so neither the turn's result nor the end-of-replay sweep may settle it -
      // only its next <task-notification>. Its earlier completion is stale now,
      // so forget it (the sweeps replay recorded completions).
      sub.background = true
      completedNotifs.delete(sub.agentId)
      if (sub.toolUseId) completedNotifs.delete(sub.toolUseId)
      scheduleSubFlush()
    }
    const handleSubagentMeta = (agentId: string, toolUseId: string, agentType: string, description: string, parentAgentId: string, prompt = '') => {
      if (!agentId) return
      const sub = ensureSubagent(agentId)
      if (agentType) sub.agentType = agentType
      if (description) sub.description = description
      if (prompt) sub.prompt = prompt
      if (parentAgentId) sub.parentAgentId = parentAgentId
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
      }
      scheduleSubFlush()
    }
    const patchSubTool = (sub: SubagentView, toolUseId: string, result: string, isError: boolean, images: string[], raw?: unknown, editPatch?: EditHunk[] | null, cwdAfter?: string) => {
      const resultImages = images.length > 0 ? images : undefined
      // Replace the item with a fresh object (not an in-place mutation): the
      // memoized ToolCard compares its `item` prop by reference, so mutating the
      // existing object would leave a finished step stuck showing "running" until
      // some other state forced a re-render (item: sub-agent step cards).
      for (let i = 0; i < sub.items.length; i++) {
        const it = sub.items[i]
        if (it.kind === 'tool' && it.toolUseId === toolUseId) {
          sub.items[i] = { ...it, result, isError, resultImages, rawResult: raw, editPatch: editPatch ?? undefined, cwdAfter }
          break
        }
      }
      // A NESTED spawn's result lands here (the spawning Task tool_use lives in
      // a sub-agent's own timeline, so the main flow's settle never sees it):
      // mirror it - launch boilerplate marks the spawned sub background, a real
      // result settles it. A non-spawn tool result matches no sub and no-ops.
      settleSubagentByToolUse(toolUseId, result)
    }
    // noticeSubDone drops a compact "finished" notice (with a View link to the
    // sub-agent's chat) into the main flow. It is derived from the sequenced
    // lifecycle event, so replay must restore it as well as the launch card.
    const noticeSubDone = (key: string, sub: SubagentView) => {
      const info = sub.toolUseId ? taskInputByUse.get(sub.toolUseId) : undefined
      const label = sub.agentType || info?.type || 'Sub-agent'
      const desc = sub.description || info?.desc || ''
      push({ kind: 'notice', text: `${label} finished${desc ? ': ' + desc : ''}`, subagentKey: key, noEntrance: replaying || undefined })
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
          // A NESTED sub-agent's finish shows on its card inside the parent's
          // timeline; a main-flow notice for it would just be noise.
          if (!sub.parentAgentId) noticeSubDone(key, sub)
          scheduleSubFlush()
        }
      }
    }
    // Distinct task-notifications already surfaced this connection: the notice +
    // settle fire once even though the CLI writes each notification more than
    // once (a queue-operation and an attachment, both relayed live off the main
    // transcript) and a later real user turn may consume it again.
    const seenNotif = new Set<string>()
    // task-ids / tool-use-ids whose <task-notification> reported completion. A
    // background sub-agent's card is rebuilt from its sidecar transcript, which
    // the backfill relays AFTER the main transcript (where the notification
    // lives) - so on a reconnect/resume the settle loop below can run before the
    // sub even exists and match nothing. Record the completed ids here so a sub
    // created or linked later still settles (mirrors backgroundToolUses, which
    // exists for the same "signal arrives before the sub" reason).
    const completedNotifs = new Set<string>()
    // task-ids that already rendered a sub-agent completion chip via the
    // canonical subagent_completed event (the richer "Sub-agent finished" pill
    // with a View link). Claude records the same completion a second time as the
    // user turn that resumed the parent; that copy must still SETTLE the sub but
    // must not push a second chip (`Agent "X" finished`) for the same task. Old
    // stored logs hold both records - newer ones collapse them server-side.
    const renderedSubCompletions = new Set<string>()
    // Older normalized logs may contain a subagent_completed event for a
    // background command because Claude uses the same task-notification
    // envelope for both. Remember output-file task ids so those historical
    // events cannot create a transient empty agent card during replay/live
    // catch-up. New backend events no longer emit the bogus lifecycle event.
    const backgroundCommandTaskIDs = new Set<string>()
    // The latest completion notice pushed per task-id: an agent that stops, is
    // messaged/resumed, and stops again notifies more than once, and rendering
    // every summary reads as the same agent "finishing" twice. A newer
    // completion notice for the same task supersedes (retracts) the older chip;
    // the conversation in between (the nudge, its replies) tells the story.
    const noticeIdByTask = new Map<string, number>()
    // handleTaskNotification folds one <task-notification> record into the flow:
    // a compact notice, plus - for a background/async sub-agent whose completion
    // this is (its Task tool_result was only launch boilerplate, so nothing else
    // settles it) - marking the matching still-"working" card done by task-id /
    // tool-use-id. Reached both from a user turn that consumed the notification
    // and from the live main-transcript relay, so it dedups its own copies.
    const handleTaskNotification = (text: string, ts?: number | null, quiet?: boolean) => {
      const taskId = /<task-id>([\s\S]*?)<\/task-id>/.exec(text)?.[1]?.trim()
      const noticeToolUse = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(text)?.[1]?.trim()
      const taskStatus = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim()
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
      const outputFile = /<output-file>([\s\S]*?)<\/output-file>/.exec(text)?.[1]?.trim()
      const linkedAgent = Object.values(subLocal).some((sub) =>
        (taskId && sub.agentId === taskId) || (noticeToolUse && sub.toolUseId === noticeToolUse))
      const agentNotification = linkedAgent || /^Agent\b/i.test(decodeEntities(summary ?? ''))
      if (outputFile && taskId && !agentNotification) backgroundCommandTaskIDs.add(taskId)
      const dedupKey = `${taskId ?? ''}\0${noticeToolUse ?? ''}\0${taskStatus ?? ''}\0${summary ?? ''}`
      if (seenNotif.has(dedupKey)) return
      seenNotif.add(dedupKey)
      const stillRunning = taskStatus != null && /^(running|in[_-]?progress|pending)$/i.test(taskStatus)
      if (!stillRunning && (taskId || noticeToolUse)) {
        // Remember the completion so a sub rebuilt later (backfill ordering)
        // still settles, even though the loop below may match nothing now.
        if (taskId) completedNotifs.add(taskId)
        if (noticeToolUse) completedNotifs.add(noticeToolUse)
        for (const key in subLocal) {
          const sub = subLocal[key]
          const matches = (taskId && sub.agentId === taskId) || (noticeToolUse && sub.toolUseId === noticeToolUse)
          if (matches && sub.status === 'running') {
            sub.status = 'done'
            scheduleSubFlush()
          }
        }
      }
      // A PRE-WINDOW notification relayed for bookkeeping only
      // (notification_backfill): apply the completion, render nothing - the
      // chip belongs to a part of the conversation that isn't loaded.
      if (quiet) return
      // The canonical subagent_completed event already rendered this task's
      // completion chip (and the settle above ran); the resume echo of the same
      // notification must not push a second one.
      if (taskId && renderedSubCompletions.has(taskId)) return
      // A genuine turn-starting continuation anchors the "working" clock (item 48).
      if (ts != null) turnStartClockRef.current = ts
      if (!stillRunning && taskId) {
        const superseded = noticeIdByTask.get(taskId)
        if (superseded != null) dropItem(superseded)
      }
      const noticeId = push({
        kind: 'notice',
        text: decodeEntities(summary || 'Background task update'),
        taskId,
        toolUseId: noticeToolUse,
        outputFile,
        noEntrance: replaying || undefined,
      })
      if (!stillRunning && taskId) noticeIdByTask.set(taskId, noticeId)
    }
    // routeSidechain folds one sub-agent stream event into its card. Mirrors the
    // main user/assistant handling, minus the specialisations that can't occur
    // inside a sub-agent (slash commands, TodoWrite plan panel, AskUserQuestion,
    // the queue) - those render as plain items or are ignored.
    const routeSidechain = (ev: ProviderEvent) => {
      const parentTool = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : ''
      if (!ev.agentId && !parentTool) return
      // Transcript lines name their sub-agent; a live stdout line carries only
      // the spawning Task tool_use - land it in the linked sub if the meta
      // frame already arrived, else in a placeholder merged later.
      let agentId = ev.agentId || (parentTool ? (toolUseToSub.get(parentTool) ?? 'tool:' + parentTool) : '_sub')
      // Older Codex logs knew the child thread id but did not persist its spawn
      // tool id. Bind the first unclaimed child sidechain to the oldest Agent
      // placeholder so those logs self-heal on replay. New logs carry
      // parent_item_id and take the direct route above.
      if (ev.agentId && !parentTool && !subLocal[ev.agentId]) {
        const childID = ev.agentId
        const placeholderKey = Object.keys(subLocal).find((key) => key.startsWith('tool:'))
        const placeholder = placeholderKey ? subLocal[placeholderKey] : undefined
        if (placeholder?.toolUseId) {
          // In old logs the spawn tool's own completion was mistaken for the
          // child's completion. Seeing the real child sidechain proves it is
          // still active, so reopen the placeholder before merging it.
          placeholder.status = 'running'
          handleSubagentMeta(childID, placeholder.toolUseId, placeholder.agentType ?? '', placeholder.description ?? '', placeholder.parentAgentId ?? '', placeholder.prompt ?? '')
          agentId = childID
        }
      }
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
        else {
          const editPatch = eventEditPatch(ev, content ?? [])
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text) takePrompt(block.text)
            else if (block.type === 'tool_result' && block.tool_use_id) {
              const parsed = parseToolResult(block.content)
              patchSubTool(sub, block.tool_use_id, parsed.text, block.is_error === true, parsed.images, rawResultBlock(block, providerEntry(ev)), editPatch, ev.cwd)
            }
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
              const report = cleanSubagentReport(block.text)
              if (report) sub.items.push({ kind: 'assistant', id: meta.nextId++, text: report })
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              const dur = prevTs != null && evTs != null ? Math.max(0, evTs - prevTs) : undefined
              sub.items.push({ kind: 'thinking', id: meta.nextId++, text: block.thinking, durationMs: dur })
            } else if (block.type === 'tool_use' && block.id) {
              sub.items.push({ kind: 'tool', id: meta.nextId++, toolUseId: block.id, name: block.name ?? 'tool', input: block.input, rawUse: rawUseBlock(block, providerEntry(ev)) })
            }
          }
        }
      } else if (ev.type === 'result') {
        if (sub.status === 'running') {
          sub.status = 'done'
          if (!sub.parentAgentId) noticeSubDone(agentId, sub)
        }
      }
      scheduleSubFlush()
    }

    const patchTool = (toolUseId: string, result: string, isError: boolean, images: string[], raw?: unknown, editPatch?: EditHunk[] | null, cwdAfter?: string) => {
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
        inPending.rawResult = raw
        inPending.editPatch = editPatch ?? undefined
        inPending.cwdAfter = cwdAfter
        return
      }
      if (inPending && inPending.kind === 'question') {
        inPending.result = result
        return
      }
      // The initial history window is reduced here too, and it is the NEWEST
      // page - so a result whose card was never built belongs to a page the
      // user has not scrolled back to yet. Hold it for that page.
      if (!toolResults.known.has(toolUseId)) {
        stashOrphanResult(toolResults, toolUseId, { result, isError, images, raw, editPatch })
        return
      }
      setItems((prev) =>
        prev.map((it) => {
          if (it.kind === 'tool' && it.toolUseId === toolUseId) return { ...it, result, isError, resultImages, rawResult: raw, editPatch: editPatch ?? undefined, cwdAfter }
          if (it.kind === 'question' && it.toolUseId === toolUseId) return { ...it, result }
          return it
        }),
      )
    }

    // Some Codex items only reveal useful fields on item/completed. Refresh
    // the existing card before applying its result so it does not retain the
    // raw started-frame id or empty input.
    const patchToolMetadata = (toolUseId: string, name: string, input: unknown) => {
      const patch = (it: ChatItem): ChatItem =>
        it.kind === 'tool' && it.toolUseId === toolUseId
          ? { ...it, name: name || it.name, input: mergeToolInputHistory(it.input, input) }
          : it
      const pendingIndex = pending.findIndex((it) => it.kind === 'tool' && it.toolUseId === toolUseId)
      if (pendingIndex >= 0) pending[pendingIndex] = patch(pending[pendingIndex])
      else setItems((prev) => prev.map(patch))
      let subChanged = false
      for (const key in subLocal) {
        const sub = subLocal[key]
        const next = sub.items.map(patch)
        if (next.some((it, i) => it !== sub.items[i])) {
          sub.items = next
          subChanged = true
        }
      }
      if (subChanged) scheduleSubFlush()
    }

		const appendToolOutput = (toolUseId: string, delta: string) => {
			if (!delta) return
			const inPending = pending.find((it) => it.kind === 'tool' && it.toolUseId === toolUseId)
			if (inPending?.kind === 'tool') {
				inPending.runningOutput = (inPending.runningOutput ?? '') + delta
				return
			}
			setItems((prev) => prev.map((it) =>
				it.kind === 'tool' && it.toolUseId === toolUseId
					? { ...it, runningOutput: (it.runningOutput ?? '') + delta }
					: it,
			))
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

    // expireQuestions kills the answer channel of every question card still
    // waiting for one. The CLI's can_use_tool request lives only as long as the
    // turn that raised it: end that turn with the question unanswered (a
    // mid-question /model switch, an interrupt, a process restart) and a
    // control_response quoting its request_id is silently discarded. The
    // request_id itself is durable - it is replayed out of the stored
    // interaction_requested event on every reload - so without this the dead
    // card came back looking perfectly live, and "Submit" did nothing at all.
    // `only` narrows it to particular cards (the daemon naming the requests it
    // is still blocked on, or rejecting one answer); by default every
    // unanswered one goes.
    const expireQuestions = (only?: (it: Extract<ChatItem, { kind: 'question' }>) => boolean) => {
      const stale = (it: ChatItem) =>
        it.kind === 'question' && it.result === undefined && !it.expired && (!only || only(it))
      for (const it of pending) if (stale(it)) (it as Extract<ChatItem, { kind: 'question' }>).expired = true
      setItems((prev) =>
        prev.some(stale) ? prev.map((it) => (stale(it) ? { ...it, expired: true } : it)) : prev,
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
        // protocol doesn't guarantee it) still gets a card. It bypasses push(),
        // so register it with the result link by hand - otherwise its answer
        // would be filed as an orphan and the card would never settle.
        const specs = parseQuestionSpecs(input)
        if (!specs) return prev
        const card = claimOrphanResult(toolResults, { kind: 'question', toolUseId, input, specs, requestId })
        return [...prev, { ...card, id: nextId++ } as ChatItem]
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
    const handleHistoryBefore = (events: ProviderEvent[], done: boolean) => {
      loadingOlderRef.current = false
      setLoadingOlder(false)
      if (events.length > 0) {
        const older = reduceHistoryEvents(events, () => historyIdRef.current--, thoughtDurationsRef.current, itemTsRef.current, toolResults)
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
    const routeUserText = (rawText: string, ts?: number | null, isMeta?: boolean, clientId = '') => {
      // Machine-injected context (a Skill's SKILL.md body, the resume nudge) rides
      // in a `user` envelope but was never typed - route it to a skill/meta card
      // off the isMeta flag rather than the content-sniffing below. It doesn't
      // start a turn, so it skips the turn-clock/optimistic-echo bookkeeping.
      if (isMeta) {
        const meta = routeMetaText(rawText)
        if (meta) push(meta)
        return
      }
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
        // Codex can be interrupted before it emits item/completed. Preserve
        // everything received so far as the assistant's partial response
        // before closing the presentation stream and adding the boundary.
        settleLiveStream()
        push({ kind: 'interrupted' })
        interruptPending = true
        endPendingTools()
        return
      }
      // A harness-injected background-task notification (<task-notification>)
      // consumed as a user turn: fold it into a notice (and settle a background
      // sub-agent) via the shared handler, which dedups against the live
      // main-transcript relay of the same notification (item 8/15).
      if (isTaskNotification(text)) {
        handleTaskNotification(text, ts)
        return
      }
      // A context-compaction "session continued" preamble: collapse it behind an
      // expander rather than dumping the whole summary inline (item 39). Not a
      // real user turn, so it doesn't anchor the working-clock or dedup.
      const ctxNote = detectContextNote(text)
      if (ctxNote) {
        push({ kind: 'contextNote', text, outOfContext: ctxNote.outOfContext })
        return
      }
      // The stdout echo of a message already rendered from its queued_command
      // attachment (a queued message consumed into a running turn): the
      // attachment is the durable, correctly-placed copy - drop the echo.
      const qi = queuedCmdTexts.indexOf(text)
      if (qi >= 0) {
        queuedCmdTexts.splice(qi, 1)
        markTurnStart()
        settlePendingSend(text)
        return
      }
      // The echo of a message we already showed optimistically (item 26): just
      // confirm that copy (clear its sending flag) instead of rendering a
      // duplicate. The echo can arrive after the turn's response, so relying on
      // it for placement would put the user message below its own reply.
      const oi = optimisticTextsRef.current.findIndex((pending) =>
        (clientId !== '' && pending.clientId === clientId) || (clientId === '' && pending.text === text))
      if (oi >= 0) {
        markTurnStart()
        const optimisticText = optimisticTextsRef.current[oi].text
        optimisticTextsRef.current.splice(oi, 1)
        setItems((prev) => {
          let j = -1
          for (let k = prev.length - 1; k >= 0; k--) {
            const it = prev[k]
            if (it.kind === 'user' && it.sending && it.text === optimisticText) {
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
      plainUserTexts.push(text)
      push({ kind: 'user', text, noEntrance: fromQueue })
    }

    // One-shot dedup between a queued_command attachment and the stdout echo of
    // the same message: whichever renders first is remembered here so the other
    // is dropped (they carry different uuids, so the socket's uuid dedup can't
    // pair them).
    const queuedCmdTexts: string[] = []
    const plainUserTexts: string[] = []

    // routeQueuedCommand renders a queued_command attachment - the only durable
    // record of a queued message consumed into a RUNNING turn (see
    // queuedCommandText). Routed through routeUserText so the sender's own
    // optimistic/queued bubbles fold into the settled item.
    const routeQueuedCommand = (text: string, ts: number | null) => {
      const pi = plainUserTexts.indexOf(text)
      if (pi >= 0) {
        // Its stdout echo already rendered the bubble (ring replay order).
        plainUserTexts.splice(pi, 1)
        return
      }
      routeUserText(text, ts)
      queuedCmdTexts.push(text)
    }

    const handleProviderEvent = (ev: ProviderEvent) => {
      // A background/async sub-agent's completion arrives NOT as a user turn but
      // as a <task-notification> bookkeeping record the chat socket relays live
      // off the main transcript: a queue-operation (XML on `content`) or an
      // attachment (XML on `attachment.prompt`). Settle off it up front, whatever
      // the event type, so a finished background sub-agent's card stops reading
      // "working" the moment it ends. A notification later consumed by a real
      // user turn routes through routeUserText instead, and dedups there.
      const notifText =
        (typeof ev.content === 'string' && isTaskNotification(ev.content) && ev.content) ||
        (typeof ev.attachment?.prompt === 'string' &&
          isTaskNotification(ev.attachment.prompt) &&
          ev.attachment.prompt) ||
        ''
      if (notifText) {
        handleTaskNotification(notifText, parseEventTs(ev))
        return
      }
      // A queued message consumed into a running turn: its queued_command
      // attachment (relayed by the backfill and the live notification tailer)
      // is its only durable record - render the user bubble from it.
      const queuedText = queuedCommandText(ev)
      if (queuedText != null) {
        routeQueuedCommand(queuedText, parseEventTs(ev))
        return
      }
      // A sub-agent's inner step: route it into that sub-agent's card, never the
      // main flow. This is the fix for sub-agent prompts showing as user
      // messages (they arrive as sidechain `user` events - live ones marked
      // only by parent_tool_use_id). Checked before the load-older anchor
      // below: sidechain uuids live in sub-agent transcripts, so anchoring
      // history paging on one would never resolve.
      if (ev.isSidechain || (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id)) {
        // Only the types routeSidechain actually renders may create/route into
        // a sub: anything else (a stream_event partial delta, bookkeeping
        // records) would ensureSubagent an empty, unlabeled placeholder card.
        // A sub-agent's partial deltas aren't token-streamed into the main
        // bubble; its complete blocks arrive via the transcript tail.
        if (ev.type === 'user' || ev.type === 'assistant' || ev.type === 'result') routeSidechain(ev)
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
          } else if (ev.subtype === 'model_refusal_fallback') {
            // A safety-classifier refusal: the flagged blocks already streamed and
            // rendered live, and the retry re-emits them under new uuids, so evict
            // the retracted uuids to undo the duplicate. Both the not-yet-flushed
            // pending batch and committed state, mirroring the hydra_thinking patch.
            // This is gated on the refusal subtype, so a normal turn never reaches
            // it; if the uuids don't match (e.g. an unexpected wire shape) nothing
            // is evicted and the duplicate simply remains - never a false removal.
            const retracted = new Set([...(ev.retractedMessageUuids ?? []), ...(ev.retracted_message_uuids ?? [])])
            if (retracted.size === 0) return
            for (let i = pending.length - 1; i >= 0; i--) {
              const u = (pending[i] as { uuid?: string }).uuid
              if (u && retracted.has(u)) pending.splice(i, 1)
            }
            setItems((prev) => {
              const next = prev.filter((it) => {
                const u = (it as { uuid?: string }).uuid
                return !(u && retracted.has(u))
              })
              return next.length === prev.length ? prev : next
            })
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
        case 'hydra_subagent_completed': {
          if (ev.subagentNotice) {
            const notice = ev.subagentNotice
            if (notice.key) renderedSubCompletions.add(notice.key)
            push({ kind: 'notice', text: `${notice.label} finished${notice.description ? ': ' + notice.description : ''}`, subagentKey: notice.key, noEntrance: replaying || undefined })
          }
          return
        }
        case 'shellcmd': {
          // A "!command" result: settle the optimistic running card in place if
          // this client sent it (matched by the frame's clientId == ev.uuid),
          // else append a fresh settled card (e.g. a command another client ran,
          // or a live event with no local optimistic copy).
          const sh = ev.shell
          if (!sh) return
          const cid = ev.uuid
          const settled = {
            command: sh.command,
            output: sh.output,
            exitCode: sh.exit_code,
            truncated: sh.truncated,
            timedOut: sh.timed_out,
            stopped: sh.stopped,
            running: false,
          }
          if (cid && optimisticShellRef.current.has(cid)) {
            optimisticShellRef.current.delete(cid)
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'shellCmd' && it.clientId === cid && it.running
                  ? { ...it, ...settled, noEntrance: true }
                  : it,
              ),
            )
            return
          }
          push({ kind: 'shellCmd', clientId: cid, ...settled })
          return
        }
        case 'user': {
          const content = ev.message?.content
          const userTs = parseEventTs(ev)
          if (typeof content === 'string') {
            if (content.trim()) routeUserText(content, userTs, ev.isMeta, ev.uuid ?? '')
            return
          }
          const editPatch = eventEditPatch(ev, content ?? [])
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              routeUserText(block.text, userTs, ev.isMeta, ev.uuid ?? '')
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              const parsed = parseToolResult(block.content)
              patchTool(block.tool_use_id, parsed.text, block.is_error === true, parsed.images, rawResultBlock(block, providerEntry(ev)), editPatch, ev.cwd)
              settleSubagentByToolUse(block.tool_use_id, parsed.text)
              if (block.is_error !== true) reopenMessagedSubagent(block.tool_use_id, parsed.text)
              if (block.is_error !== true) plan.applyTaskResult(block.tool_use_id, parsed.text)
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
              //
              // takeLive hands over the id that block is ALREADY rendered under,
              // so this settles it in place - same React key, same DOM nodes,
              // and anything selected inside it stays selected.
              push({ kind: 'assistant', text: block.text, noEntrance: streamedKinds.has('assistant'), uuid: ev.uuid }, takeLive('assistant'))
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
                // No id hand-over here (unlike the text block above): a live
                // thought renders as its own card below the transcript, not as a
                // row in it, so there is no node to settle in place.
                push({ kind: 'thinking', msgId: msgId || undefined, text: block.thinking ?? '', durationMs: dur, noEntrance: streamedKinds.has('thinking'), uuid: ev.uuid })
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
                push({ kind: 'question', toolUseId: block.id, input: block.input, specs, uuid: ev.uuid })
              } else if (todos) {
                plan.applyTodoWrite(todos)
              } else {
                plan.applyTaskTool(block.name, block.input, block.id)
                if (block.name === 'SendMessage') {
                  const to = sendMessageRecipient(block.input)
                  if (to) messageTargetByUse.set(block.id, to)
                }
                if (block.name === 'Task' || block.name === 'Agent') {
                  const inp = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>
                  taskInputByUse.set(block.id, {
                    type: typeof inp.subagent_type === 'string' ? inp.subagent_type : undefined,
                    desc: typeof inp.description === 'string' ? inp.description : undefined,
                  })
                  if (block.name === 'Agent' && isAgentSpawnInput(block.input)) {
                    // Codex may not reveal the child thread id until the spawn
                    // item completes. Give the spawn card a linked placeholder
                    // immediately; handleSubagentMeta merges it into the real
                    // child when that id arrives, so raw Agent JSON never flashes
                    // before the rich sub-agent card.
                    const placeholder = ensureSubagent('tool:' + block.id)
                    placeholder.toolUseId = block.id
                    toolUseToSub.set(block.id, placeholder.agentId)
                    placeholder.agentType = typeof inp.subagent_type === 'string' ? inp.subagent_type : 'Sub-agent'
                    placeholder.description = typeof inp.description === 'string' ? inp.description : ''
                    placeholder.prompt = typeof inp.prompt === 'string' ? inp.prompt : placeholder.description
                    scheduleSubFlush()
                  }
                }
                push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input, uuid: ev.uuid, rawUse: rawUseBlock(block, providerEntry(ev)) })
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
          // Track how full the context is (item 40): the prompt-side tokens of
          // the latest message. Runs for replay (assistant events) and live
          // finals alike; message_start covers the live streaming case.
          const ctx = contextInputTokens(u)
          if (ctx > 0) setContextTokens(ctx)
          const sr = ev.message?.stop_reason
          if (sr && sr !== 'tool_use') histStopReason = sr
          // The complete event supersedes any in-flight streamed block (finals
          // always follow their own deltas). The settled item is flushed in the
          // SAME batch as the clear (the normalized path does this too): left to
          // its microtask, React can render the gap between them - the text
          // blinks, and the live row is torn down and rebuilt instead of updated
          // in place, taking any selection inside it with it.
          if (!replaying) flush()
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
            const kind = bt === 'text' ? 'assistant' : bt === 'thinking' ? 'thinking' : null
            if (kind) {
              // A new block gets its own row. If the previous one is somehow
              // still live (its settled event never arrived), commit it first
              // rather than let this one overwrite it.
              settleLiveStream()
              streamBuf = { kind, text: '' }
              revealed = 0
              streamedKinds.add(kind)
              scheduleStreamFlush()
            }
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
            // The prompt this message was sent with = current context fill (item 40).
            const ctx = contextInputTokens(e.message?.usage)
            if (ctx > 0) setContextTokens(ctx)
          } else if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') {
            // Running (cumulative-for-this-message) output token count.
            curMsgTokensRef.current = e.usage.output_tokens
            setTurnTokens(turnTokensRef.current + curMsgTokensRef.current)
          } else if (e.type === 'message_stop') {
            // Roll the finished message's tokens into the turn total.
            turnTokensRef.current += curMsgTokensRef.current
            curMsgTokensRef.current = 0
            setTurnTokens(turnTokensRef.current)
            endStream()
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
          // The turn is over: anything still rendered live was never settled by
          // an assistant event, so commit it rather than blank it.
          settleLiveStream()
          endPendingTools()
          // The turn is over, so any question it left unanswered can no longer
          // be answered through the CLI (see expireQuestions).
          expireQuestions()
          return
        }
        default:
          // control_response, rate_limit_event, future kinds: not rendered
          // (yet), deliberately not an error.
          return
      }
    }

    const recordNormalizedCommit = (normalized: NormalizedChatEvent) => {
      if (normalized.type !== 'commit_created') return
      const payload = normalized.payload ?? {}
      const sha = typeof payload.sha === 'string' ? payload.sha : ''
      if (!sha) return
      const st = chipStateRef.current
      if (st.cache.has(sha)) return
      const chip: CommitChipItem = {
        kind: 'commit', id: st.nextId++, sha,
        shortSha: typeof payload.short_sha === 'string' ? payload.short_sha : sha.slice(0, 7),
        subject: typeof payload.subject === 'string' ? payload.subject : 'Commit',
        ts: Date.parse(normalized.timestamp) || Date.now(),
        noEntrance: replaying || undefined,
        ...mergeFieldsFromPayload(payload),
      }
      st.cache.set(sha, chip)
      setCommitChips((prev) => [...prev, chip])
    }
    const normalizedStreams = new Set<string>()
    // A reconnect boundary or version-skewed server can deliver the same
    // durable event in history and live catch-up. Seq is its canonical identity;
    // reducing it twice is especially visible for completion/commit chips.
    const seenNormalizedSeq = new Set<number>()
    const firstNormalizedDelivery = (event: NormalizedChatEvent): boolean => {
      if (!Number.isFinite(event.seq)) return true
      if (seenNormalizedSeq.has(event.seq)) return false
      seenNormalizedSeq.add(event.seq)
      return true
    }
    // Hydra persists a user message before writing it to the provider. Claude's
    // replay-user-messages mode later echoes the same content with an unrelated
    // UUID. New logs carry a user_message_echoed marker; this one-to-one content
    // matcher also repairs older logs which already contain both visible events.
    const pendingHydraUserEchoes = new Map<string, number>()
    const pendingClaudeUserEchoes = new Map<string, number>()
    const keepNormalizedUserEvent = (event: NormalizedChatEvent): boolean => {
      if (event.type !== 'user_message' && event.type !== 'user_message_echoed') return true
      const key = stableContentKey(event.payload?.content ?? null)
      if (key === 'null') return event.type === 'user_message'
      const hydraCount = pendingHydraUserEchoes.get(key) ?? 0
      if (event.type === 'user_message_echoed') {
        if (hydraCount > 0) pendingHydraUserEchoes.set(key, hydraCount - 1)
        return false
      }
      if (event.source_id?.startsWith('claude:')) {
        if (hydraCount > 0) {
          pendingHydraUserEchoes.set(key, hydraCount - 1)
          return false
        }
        pendingClaudeUserEchoes.set(key, (pendingClaudeUserEchoes.get(key) ?? 0) + 1)
        return true
      }
      const claudeCount = pendingClaudeUserEchoes.get(key) ?? 0
      if (claudeCount > 0) {
        pendingClaudeUserEchoes.set(key, claudeCount - 1)
        return false
      }
      pendingHydraUserEchoes.set(key, hydraCount + 1)
      return true
    }
    // Opus can spend measurable time in a hidden reasoning block whose final
    // text is empty. Pair the semantic completion and duration regardless of
    // which one was imported first, then synthesize the empty thinking block
    // only when its duration proves that real reasoning occurred.
    const emptyNormalizedReasoning = new Map<string, NormalizedChatEvent>()
    const normalizedReasoningDurations = new Set<string>()
    const normalizedPresentationEvents = (event: NormalizedChatEvent): ProviderEvent[] => {
      const messageID = typeof event.payload?.message_id === 'string' ? event.payload.message_id : ''
      if (event.type === 'reasoning_completed' && !contentText(event.payload?.text).trim()) {
        if (messageID && normalizedReasoningDurations.has(messageID)) {
          return normalizedToProviderEvents(event, true)
        }
        if (messageID) emptyNormalizedReasoning.set(messageID, event)
        return []
      }
      if (event.type === 'reasoning_duration' && messageID) {
        normalizedReasoningDurations.add(messageID)
        const converted = normalizedToProviderEvents(event)
        const completed = emptyNormalizedReasoning.get(messageID)
        if (completed) {
          emptyNormalizedReasoning.delete(messageID)
          converted.push(...normalizedToProviderEvents(completed, true))
        }
        return converted
      }
      return normalizedToProviderEvents(event)
    }
    const replayedAssistantTexts = new Set<string>()
    // Codex often reveals semantic tool fields only on tool_completed. Keep the
    // richest payload by id so an older tool_started page can be enriched before
    // the history reducer creates its card (pagination arrives newest-first).
    const normalizedToolMetadata = new Map<string, { name: string; input: unknown }>()
    const rememberNormalizedToolMetadata = (event: NormalizedChatEvent) => {
      if (event.type !== 'tool_started' && event.type !== 'tool_completed') return
      const id = typeof event.payload?.id === 'string' ? event.payload.id : ''
      const name = typeof event.payload?.name === 'string' ? event.payload.name : ''
      if (id && name && event.payload && 'input' in event.payload) {
        const prior = normalizedToolMetadata.get(id)
        const input = mergeToolInputHistory(prior?.input, event.payload.input)
        // A completion wins; an empty started payload must not overwrite it
        // when an older page is loaded after the newer completion page.
        if (event.type === 'tool_completed' || !prior) normalizedToolMetadata.set(id, { name, input })
        else normalizedToolMetadata.set(id, { name: prior.name, input })
      }
    }
    const enrichNormalizedTool = (event: NormalizedChatEvent): NormalizedChatEvent => {
      if (event.type !== 'tool_started') return event
      const id = typeof event.payload?.id === 'string' ? event.payload.id : ''
      const rich = normalizedToolMetadata.get(id)
      return rich ? { ...event, payload: { ...event.payload, name: rich.name, input: rich.input } } : event
    }
    const handleNormalizedSubagent = (event: NormalizedChatEvent): boolean => {
      if (event.type !== 'subagent_started' && event.type !== 'subagent_updated' && event.type !== 'subagent_completed') return false
      const sub = event.payload ?? {}
      const subID = typeof sub.id === 'string' ? sub.id : ''
      if (subID && backgroundCommandTaskIDs.has(subID)) return true
      const rawParentID = typeof sub.parent_id === 'string' ? sub.parent_id : ''
      // Codex puts the root conversation thread in parent_id too. It is only a
      // nested-agent relationship when that id names an actual known child.
      const parentID = rawParentID && subLocal[rawParentID] ? rawParentID : ''
      handleSubagentMeta(
        subID,
        typeof sub.parent_item_id === 'string' ? sub.parent_item_id : '',
        typeof sub.agent_type === 'string' ? sub.agent_type : '',
        typeof sub.description === 'string' ? sub.description : '',
        parentID,
        typeof sub.prompt === 'string' ? sub.prompt : '',
      )
      if (subID && event.type === 'subagent_completed') {
        const completedSub = ensureSubagent(subID)
        completedSub.status = 'done'
      }
      scheduleSubFlush()
      return true
    }
    let activeNormalizedAssistantStream = ''
    let activeNormalizedReasoningStream = ''

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
        event?: ProviderEvent
        messages?: { id?: string; content?: unknown }[]
        agentId?: string
        toolUseId?: string
        agentType?: string
        description?: string
        parentAgentId?: string
        events?: ProviderEvent[]
        done?: boolean
        file?: string
        content?: string
        error?: string
        plan?: string
        state?: ChatProjectionSnapshot
        next_cursor?: string
        normalizedEvents?: NormalizedChatEvent[]
        id?: string
        chunk?: string
        // pending_questions / question_expired: the daemon's word on which
        // AskUserQuestion requests the CLI is still blocked on (see below).
        requests?: { requestId?: string; toolUseId?: string }[]
        requestId?: string
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
          // HEAD moved = a commit landed (or the branch was rewritten): refresh
          // the commit chips so the new one appears within the poll interval.
          if (msg.head_moved && !usesNormalizedEvents) fetchCommitsRef.current()
          return
        case 'claude_event':
          // Compatibility-only frame. Structured providers consume the
          // sequenced backend event stream instead.
          if (!normalizedAvailableRef.current && msg.event) handleProviderEvent(msg.event)
          return
        case 'shell_output': {
          // A live chunk of a running "!command"'s output: append it to the
          // matching running card (keyed by the send frame's id). Ephemeral - the
          // durable copy arrives as the command's settle event. The tail is capped
          // so a runaway command can't grow the DOM node without bound.
          const cid = msg.id
          const chunk = msg.chunk
          if (!cid || typeof chunk !== 'string') return
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'shellCmd' && it.clientId === cid && it.running
                ? { ...it, output: tailCap(it.output + chunk, SHELL_STREAM_CAP) }
                : it,
            ),
          )
          return
        }
        case 'state_snapshot': {
          if (!usesNormalizedEvents) return
          normalizedAvailableRef.current = true
          // Persisted "/" autocomplete list, so old heads whose system:init has
          // scrolled past the replayed history window still populate the popup.
          if (Array.isArray(msg.state?.slash_commands) && msg.state.slash_commands.length) {
            setSlashCommands(msg.state.slash_commands.filter((c): c is string => typeof c === 'string'))
          }
          const rawPlan = msg.state?.plan
          const entries = parseServerPlan(typeof rawPlan === 'string' ? rawPlan : rawPlan == null ? '' : JSON.stringify(rawPlan))
          if (entries.length) plan.adoptServer(entries)
          for (const [key, sub] of Object.entries(msg.state?.subagents ?? {})) {
            const subID = sub.id || key
            handleSubagentMeta(subID, sub.parent_item_id ?? '', sub.agent_type ?? '', sub.description ?? '', sub.parent_id ?? '', sub.prompt ?? '')
            if (sub.status && sub.status !== 'running') ensureSubagent(subID).status = 'done'
          }
          const partial = msg.state?.stream
          if (partial?.text) {
            const kind = partial.kind === 'thinking' ? 'thinking' : 'text'
            // Register the id the continuing deltas will resolve to, so they
            // append to this preview instead of opening a second one (which
            // would drop the prefix), and so the completed message settles it.
            const streamID = partial.message_id || `${kind}:snapshot`
            normalizedStreams.add(streamID)
            if (kind === 'text') activeNormalizedAssistantStream = streamID
            else activeNormalizedReasoningStream = streamID
            seedStream(kind === 'text' ? 'assistant' : 'thinking', partial.text)
          }
          return
        }
        case 'chat_event': {
          if (!usesNormalizedEvents) return
          normalizedAvailableRef.current = true
          const normalized = msg.event as unknown as NormalizedChatEvent | undefined
          if (!normalized || !firstNormalizedDelivery(normalized) || !keepNormalizedUserEvent(normalized)) return
          // Status frames and normalized chat events travel independently. A
          // completed turn is already durable by the time this event arrives,
          // so settle the selected head immediately instead of waiting for the
          // slower project-status refresh. Historical pages use chat_history,
          // not this live-only branch, and therefore cannot overwrite status.
          if (normalized.payload?.sidechain !== true) {
            if (normalized.type === 'turn_started') {
              onStatusUpdateRef.current?.(AgentStatus.RUNNING)
            } else if (
              normalized.type === 'turn_completed' ||
              normalized.type === 'turn_failed' ||
              normalized.type === 'turn_interrupted'
            ) {
              const childStillRunning = Object.values(subLocal).some((sub) => sub.status === 'running')
              onStatusUpdateRef.current?.(childStillRunning ? AgentStatus.RUNNING : AgentStatus.FINISHED)
            }
          }
          rememberNormalizedToolMetadata(normalized)
          if (handleNormalizedSubagent(normalized)) {
            const subID = typeof normalized.payload?.id === 'string' ? normalized.payload.id : ''
            if (normalized.type === 'subagent_completed' && !backgroundCommandTaskIDs.has(subID)) {
              for (const converted of normalizedPresentationEvents(normalized)) handleProviderEvent(converted)
            }
            return
          }
          const explicitStreamID = typeof normalized.payload?.message_id === 'string' ? normalized.payload.message_id : ''
          if (normalized.type === 'assistant_delta' || normalized.type === 'reasoning_delta') {
            if (normalized.payload?.sidechain === true) {
              // Sub-agent cards consume their completed blocks; routing child
              // token deltas through the main stream created a second partial
              // response and corrupted replay state.
              return
            }
            const kind = normalized.type === 'assistant_delta' ? 'text' : 'thinking'
            let streamID = explicitStreamID
            if (!streamID) {
              streamID = kind === 'text' ? activeNormalizedAssistantStream : activeNormalizedReasoningStream
              if (!streamID) streamID = `${kind}:${normalized.seq}`
            }
            if (kind === 'text') activeNormalizedAssistantStream = streamID
            else activeNormalizedReasoningStream = streamID
            if (!normalizedStreams.has(streamID)) {
              normalizedStreams.add(streamID)
              handleProviderEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: kind } } })
            }
            const delta = typeof normalized.payload?.text === 'string' ? normalized.payload.text : ''
            handleProviderEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta } } })
            return
          }
          const activeStreamID = normalized.type === 'assistant_message' ? activeNormalizedAssistantStream : activeNormalizedReasoningStream
          // Claude's token envelopes do not carry the final message id, while
          // its completed assistant envelope does. Prefer an explicitly open
          // id (Codex), otherwise settle the provider's active anonymous stream.
          const streamID = explicitStreamID && normalizedStreams.has(explicitStreamID) ? explicitStreamID : activeStreamID
          const settlesNormalizedStream =
            (normalized.type === 'assistant_message' || normalized.type === 'reasoning_completed') && normalizedStreams.delete(streamID)
          if (normalized.type === 'plan_updated') {
            const rawPlan = normalized.payload?.plan
            const entries = parseServerPlan(typeof rawPlan === 'string' ? rawPlan : rawPlan == null ? '' : JSON.stringify(rawPlan))
            if (entries.length) plan.adoptServer(entries)
          }
					if (normalized.type === 'tool_started' || normalized.type === 'tool_completed') {
						const toolID = typeof normalized.payload?.id === 'string' ? normalized.payload.id : ''
						const toolName = typeof normalized.payload?.name === 'string' ? normalized.payload.name : ''
						if (toolID && toolName && normalized.payload && 'input' in normalized.payload) {
							patchToolMetadata(toolID, toolName, normalized.payload.input)
						}
					}
					if (normalized.type === 'tool_delta') {
						const toolID = typeof normalized.payload?.id === 'string' ? normalized.payload.id : ''
						const delta = typeof normalized.payload?.text === 'string' ? normalized.payload.text : ''
						appendToolOutput(toolID, delta)
						return
          }
          recordNormalizedCommit(normalized)
          if (replaying && normalized.type === 'assistant_message') {
            const text = typeof normalized.payload?.text === 'string' ? normalized.payload.text : ''
            if (text && replayedAssistantTexts.has(text)) return
            if (text) replayedAssistantTexts.add(text)
          }
          for (const converted of normalizedPresentationEvents(normalized)) handleProviderEvent(converted)
          if (settlesNormalizedStream) {
            // Commit the completed message and remove its streamed preview in
            // one React batch. Clearing first and flushing the settled item in
            // a microtask produced a visible blank/full-message flicker.
            flush()
            handleProviderEvent({ type: 'stream_event', event: { type: 'message_stop' } })
            if (normalized.type === 'assistant_message') activeNormalizedAssistantStream = ''
            else activeNormalizedReasoningStream = ''
          }
          return
        }
        case 'chat_history': {
          if (!usesNormalizedEvents) return
          normalizedAvailableRef.current = true
          const normalized = (msg.normalizedEvents ?? (msg.events as unknown as NormalizedChatEvent[]) ?? [])
            .filter(firstNormalizedDelivery)
            .filter(keepNormalizedUserEvent)
          oldestEventCursorRef.current = msg.next_cursor ?? null
          for (const event of normalized) {
            recordNormalizedCommit(event)
            rememberNormalizedToolMetadata(event)
          }
          if (loadingOlderRef.current) {
            const main: ProviderEvent[] = []
            for (const rawEvent of normalized) {
              if (handleNormalizedSubagent(rawEvent)) {
                const subID = typeof rawEvent.payload?.id === 'string' ? rawEvent.payload.id : ''
                if (rawEvent.type === 'subagent_completed' && !backgroundCommandTaskIDs.has(subID)) {
                  main.push(...normalizedPresentationEvents(rawEvent))
                }
                continue
              }
              const event = enrichNormalizedTool(rawEvent)
              if (event.payload?.sidechain === true) {
                if (event.type === 'tool_started' || event.type === 'tool_completed') {
                  const toolID = typeof event.payload?.id === 'string' ? event.payload.id : ''
                  const toolName = typeof event.payload?.name === 'string' ? event.payload.name : ''
                  if (toolID && toolName && 'input' in event.payload) patchToolMetadata(toolID, toolName, event.payload.input)
                }
                for (const converted of normalizedPresentationEvents(event)) handleProviderEvent(converted)
              } else {
                main.push(...normalizedPresentationEvents(event))
              }
            }
            handleHistoryBefore(main, msg.done === true)
          } else {
            for (const rawEvent of normalized) {
              if (handleNormalizedSubagent(rawEvent)) {
                const subID = typeof rawEvent.payload?.id === 'string' ? rawEvent.payload.id : ''
                if (rawEvent.type === 'subagent_completed' && !backgroundCommandTaskIDs.has(subID)) {
                  for (const converted of normalizedPresentationEvents(rawEvent)) handleProviderEvent(converted)
                }
                continue
              }
              const event = enrichNormalizedTool(rawEvent)
              if (event.type === 'assistant_message') {
                const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
                if (text && replayedAssistantTexts.has(text)) continue
                if (text) replayedAssistantTexts.add(text)
              }
              if (event.type === 'plan_updated') {
                const rawPlan = event.payload?.plan
                const entries = parseServerPlan(typeof rawPlan === 'string' ? rawPlan : rawPlan == null ? '' : JSON.stringify(rawPlan))
                if (entries.length) plan.adoptServer(entries)
              }
              if (event.type === 'tool_started' || event.type === 'tool_completed') {
                const toolID = typeof event.payload?.id === 'string' ? event.payload.id : ''
                const toolName = typeof event.payload?.name === 'string' ? event.payload.name : ''
                if (toolID && toolName && event.payload && 'input' in event.payload) {
                  patchToolMetadata(toolID, toolName, event.payload.input)
                }
              }
              for (const converted of normalizedPresentationEvents(event)) handleProviderEvent(converted)
            }
            if (msg.done === true) setAllHistoryLoaded(true)
          }
          return
        }
        case 'subagent_events': {
          // A load_subagent reply: one sub-agent's full step history, fetched
          // when its tab opened. Every event is a sidechain step (agent_id set),
          // so route them exactly like the load-older sidechain branch above -
          // through the live handler into the sub-agent's card. Deduped by seq,
          // so overlap with the already-loaded window (or a later scroll) is a
          // no-op.
          if (!usesNormalizedEvents) return
          normalizedAvailableRef.current = true
          const normalized = (msg.normalizedEvents ?? (msg.events as unknown as NormalizedChatEvent[]) ?? [])
            .filter(firstNormalizedDelivery)
            .filter(keepNormalizedUserEvent)
          for (const rawEvent of normalized) rememberNormalizedToolMetadata(rawEvent)
          for (const rawEvent of normalized) {
            if (handleNormalizedSubagent(rawEvent)) continue
            const event = enrichNormalizedTool(rawEvent)
            if (event.type === 'tool_started' || event.type === 'tool_completed') {
              const toolID = typeof event.payload?.id === 'string' ? event.payload.id : ''
              const toolName = typeof event.payload?.name === 'string' ? event.payload.name : ''
              if (toolID && toolName && event.payload && 'input' in event.payload) {
                patchToolMetadata(toolID, toolName, event.payload.input)
              }
            }
            for (const converted of normalizedPresentationEvents(event)) handleProviderEvent(converted)
          }
          flushSubagents()
          return
        }
        case 'notification_backfill': {
          if (normalizedAvailableRef.current) return
          // A <task-notification> record from BEFORE the backfill window,
          // relayed so a long-finished background task/agent still settles on
          // reconnect. Settle-only: no notice chip (its place in the
          // conversation isn't loaded), no working-clock anchor.
          const ev = msg.event
          const notifText =
            (typeof ev?.content === 'string' && isTaskNotification(ev.content) && ev.content) ||
            (typeof ev?.attachment?.prompt === 'string' &&
              isTaskNotification(ev.attachment.prompt) &&
              ev.attachment.prompt) ||
            (typeof ev?.message?.content === 'string' && isTaskNotification(ev.message.content) && ev.message.content) ||
            ''
          if (notifText) handleTaskNotification(notifText, null, true)
          return
        }
        case 'subagent_meta':
          if (normalizedAvailableRef.current) return
          // Links a sub-agent to its Task tool_use (folding it into that card)
          // and labels it; arrives ahead of the sub's events live, and per-sub
          // during backfill. Tolerates arriving after events too.
          handleSubagentMeta(msg.agentId ?? '', msg.toolUseId ?? '', msg.agentType ?? '', msg.description ?? '', msg.parentAgentId ?? '')
          return
        case 'task_output': {
          // Answer to a task_output request: hand it to the waiting chip.
          const waiter = taskOutputWaitersRef.current.get(msg.file ?? '')
          if (waiter) {
            taskOutputWaitersRef.current.delete(msg.file ?? '')
            waiter({ content: msg.content, error: msg.error })
          }
          return
        }
        case 'pending_questions':
          // Sent once per connection, immediately before replay_done: the
          // requests the CLI is still blocked on right now. An empty list is a
          // definite "none" (every replayed question card is dead); the frame
          // not arriving at all leaves the fallback in place.
          livePendingQuestions = new Set(
            (msg.requests ?? []).map((r) => r.requestId).filter((id): id is string => !!id),
          )
          return
        case 'question_expired':
          // The daemon refused to forward an answer: that request was already
          // retired, so the card must stop claiming it was answered and offer
          // the message route instead.
          if (msg.requestId) {
            const dead = msg.requestId
            expireQuestions((it) => it.requestId === dead)
          }
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
          // Same for a question the history left unanswered: keep only the ones
          // the daemon says the CLI is still blocked on. Where it couldn't say,
          // fall back to the head's status - still working, or parked on
          // needs_input, is the one situation a reload during a genuinely
          // pending question lands in. (The turn-end path above only catches
          // the ones whose `result` line made it into the replay window.)
          if (livePendingQuestions) {
            const live = livePendingQuestions
            expireQuestions((it) => it.requestId == null || !live.has(it.requestId))
          } else if (!questionMayBeLiveRef.current) {
            expireQuestions()
          }
          // A BACKGROUND sub-agent settles only off its <task-notification>. That
          // record lives in the main transcript, which the backfill replays
          // BEFORE the sub is rebuilt from its sidecar - so handleTaskNotification
          // ran with no sub to match. Apply the recorded completion retroactively
          // here, to ANY still-running sub the notifications named (not just ones
          // already marked background - the launch boilerplate that would mark
          // them can itself fall outside the backfill window); a sub with no
          // recorded completion is genuinely still live, so leave it be.
          for (const key in subLocal) {
            const sub = subLocal[key]
            if (sub.status !== 'running') continue
            if (completedNotifs.has(sub.agentId) || (sub.toolUseId && completedNotifs.has(sub.toolUseId))) {
              sub.status = 'done'
            }
          }
          // Same for non-background sub-agents (item 5): a sub still marked running
          // after the whole transcript replayed only stays genuinely live if the
          // head is mid-turn right now (a reconnect during an active turn).
          // Otherwise - e.g. after a server restart - the run is long over and
          // never emitted the settling result, so mark it done (and end its
          // orphaned steps) so it doesn't read "working" forever.
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
          if (isTurnRunningRef.current) {
            const real = turnStartClockRef.current
            if (real != null && real <= Date.now()) {
              turnStartRef.current = real
              setElapsed(Math.floor((Date.now() - real) / 1000))
            }
          } else {
            // Idle chat: the backfill's historical user messages also passed
            // through markTurnStart, so the anchor now holds the LAST turn's
            // start. Clear it, or the next live turn would show its elapsed
            // time as "since that old message" instead of starting from 0.
            turnStartClockRef.current = null
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
          if (normalizedAvailableRef.current) return
          // A load-older page (item 25): older conversation events to prepend.
          handleHistoryBefore(msg.events ?? [], msg.done === true)
          return
        case 'plan': {
          // The daemon's stream-tracked plan (sent once per attach, after the
          // backfill). It supersedes anything assembled from the tail window
          // or restored from storage - without it a plan whose Task* creates
          // predate the backfill window (a head that ran unwatched, a
          // byte-dense conversation) never resurfaces.
          const entries = parseServerPlan(typeof msg.plan === 'string' ? msg.plan : '')
          if (entries.length) plan.adoptServer(entries)
          return
        }
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
      if (streamFrame != null) cancelAnimationFrame(streamFrame)
      if (retryTimer != null) clearTimeout(retryTimer)
      closeWebSocket(ws)
      wsRef.current = null
      setConnected(false)
    }
  }, [agentId, agentType, projectId, reconnectAttempt, autoRetry, usesNormalizedEvents])

  // Tool cards by tool_use id: a sub-agent view reads its parent Task card for
  // labels, the live/done state and the final report. A NESTED sub-agent's
  // spawning tool_use lives inside its parent's timeline, not the main items,
  // so those are indexed too.
  const taskToolByUse = useMemo(() => {
    const m: Record<string, ToolItem> = {}
    for (const it of items) if (it.kind === 'tool') m[it.toolUseId] = it
    for (const s of Object.values(subagents)) for (const it of s.items) if (it.kind === 'tool') m[it.toolUseId] = it
    return m
  }, [items, subagents])

  // Sub-agents whose own run has settled but which still have a running
  // descendant. The harness "finishes" a sub-agent the moment its turn ends -
  // even when it stopped to wait on background sub-agents it spawned - so a
  // card that flipped to "finished" while its children work misreads. These
  // ids keep their cards in a live "waiting on sub-agents" state until the
  // whole subtree is quiet.
  const subsAwaitingChildren = useMemo(() => {
    const kids: Record<string, SubagentView[]> = {}
    for (const s of Object.values(subagents)) {
      if (s.parentAgentId) (kids[s.parentAgentId] ??= []).push(s)
    }
    const out = new Set<string>()
    if (Object.keys(kids).length === 0) return out
    const own = (s: SubagentView) => isSubRunning(s, s.toolUseId ? taskToolByUse[s.toolUseId] : undefined)
    const treeRunning = (s: SubagentView): boolean => own(s) || (kids[s.agentId] ?? []).some(treeRunning)
    for (const s of Object.values(subagents)) {
      if (!own(s) && (kids[s.agentId] ?? []).some(treeRunning)) out.add(s.agentId)
    }
    return out
  }, [subagents, taskToolByUse])

  // --- Following the bottom --------------------------------------------------

  // stopFollow cancels an in-flight glide, for the writes that place the
  // viewport outright (a view switch, a restored offset) rather than follow it.
  function stopFollow() {
    if (followRafRef.current != null) {
      cancelAnimationFrame(followRafRef.current)
      followRafRef.current = null
    }
  }

  // followBottom keeps a pinned view at the bottom as content arrives. This
  // used to be a bare `scrollTop = scrollHeight`, so every new message, thought
  // or tool card teleported the viewport and you lost your place in the text.
  // Instead ease towards the bottom on a rAF loop that RE-READS the target
  // every frame: streamed growth becomes one continuous glide (rather than a
  // per-token tween restarting and fighting itself), and a card animating open
  // is tracked as it grows. The loop exits the moment the pin is dropped, so a
  // scroll-up mid-glide hands control straight back to the user.
  function followBottom(instant = false) {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    // Jump outright when asked, while the replayed history is still landing
    // (opening a conversation should show its end, not scroll down to it), when
    // the user opted out of motion, and when the gap is more than a couple of
    // viewports - that size of jump is a bulk render, not "a new thing
    // arrived", and gliding it would just fling unreadable text past.
    //
    // Streamed growth is deliberately NOT special-cased into an instant match:
    // the glide is the intended feel for everything that lands, streamed text
    // included. What used to look like jitter on top of it was two separate
    // layout bugs - the indicator row wrapping to two lines, and fractional
    // line boxes moving the bottom by a sub-pixel every line - both fixed at
    // the source (whitespace-nowrap on the row, .chat-leading in index.css).
    if (
      instant ||
      !liveUiRef.current ||
      gap > el.clientHeight * 2 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      stopFollow()
      el.scrollTop = el.scrollHeight
      return
    }
    if (followRafRef.current != null) return // already chasing; the loop re-aims itself
    followPrevTimeRef.current = performance.now()
    const step = (now: number) => {
      followRafRef.current = null
      const node = scrollRef.current
      if (!node || !pinnedRef.current) return
      // Clamp dt so returning to a backgrounded tab (one enormous frame)
      // resumes with a normal step instead of a teleport.
      const dt = Math.min(Math.max(now - followPrevTimeRef.current, 0), 50)
      followPrevTimeRef.current = now
      const dist = node.scrollHeight - node.clientHeight - node.scrollTop
      if (dist <= 0.5) {
        node.scrollTop = node.scrollHeight
        return
      }
      // Exponential ease-out: frame-rate independent, and it converges on a
      // target that is still moving while tokens stream in. The floor keeps the
      // tail from crawling sub-pixel forever.
      node.scrollTop += Math.max(dist * (1 - Math.exp(-dt / FOLLOW_TAU_MS)), Math.min(dist, 0.5))
      followRafRef.current = requestAnimationFrame(step)
    }
    followRafRef.current = requestAnimationFrame(step)
  }

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    stopFollow()
    // An explicit "take me to the bottom" glides however far it has to, so the
    // long-gap cutoff in followBottom doesn't apply - hand it to the browser.
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  useEffect(
    () => () => {
      if (followRafRef.current != null) cancelAnimationFrame(followRafRef.current)
    },
    [],
  )

  // --- Sub-agent chat views --------------------------------------------------

  // Viewing another agent's chat is per-head ephemeral UI; a different head starts
  // back on its main conversation. Reset the view during render (previous-key idiom)
  // so it isn't a cascading effect render; the scroll-memory ref reset must stay in
  // an effect (a ref must not be written during render).
  const headKey = `${agentId}\0${projectId}`
  const [prevHeadKey, setPrevHeadKey] = useState(headKey)
  if (prevHeadKey !== headKey) {
    setPrevHeadKey(headKey)
    setChatView('main')
  }
  useEffect(() => {
    mainScrollRef.current = null
  }, [agentId, projectId])

  // Stable identity (per chatView) so the subagentLinks memo below doesn't
  // rebuild every render.
  const openSubView = useCallback(
    (key: string) => {
      if (chatView === 'main') mainScrollRef.current = { ...lastScrollRef.current }
      setChatView(key)
    },
    [chatView],
  )

  // requestTaskOutput fetches a background task's output file over the chat
  // socket (the expandable notification chip), resolving with the daemon's
  // task_output answer or an error.
  function requestTaskOutput(file: string): Promise<{ content?: string; error?: string }> {
    return new Promise((resolve) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ error: 'Not connected' })
        return
      }
      taskOutputWaitersRef.current.set(file, resolve)
      ws.send(JSON.stringify({ type: 'task_output', file }))
      window.setTimeout(() => {
        const waiter = taskOutputWaitersRef.current.get(file)
        if (waiter) {
          taskOutputWaitersRef.current.delete(file)
          waiter({ error: 'Timed out fetching the output' })
        }
      }, 10000)
    })
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
    // Placing the viewport outright - never glide the old view's leftover
    // follow into the new one's content.
    stopFollow()
    if (chatView === 'main') {
      const saved = mainScrollRef.current
      const pin = saved?.pinned ?? true
      pinnedRef.current = pin
      setPinned(pin)
      el.scrollTop = pin ? el.scrollHeight : (saved?.top ?? 0)
    } else {
      const sub = subagents[chatView]
      const tool = sub?.toolUseId ? taskToolByUse[sub.toolUseId] : undefined
      const running = sub ? isSubRunning(sub, tool) || subsAwaitingChildren.has(sub.agentId) : false
      pinnedRef.current = running
      setPinned(running)
      el.scrollTop = running ? el.scrollHeight : 0
    }
  }, [chatView, subagents, taskToolByUse, subsAwaitingChildren])

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
      // Timer effect: resets the clock refs + elapsed seconds when a turn ends and
      // runs an interval while it's live - all genuine effect work, not a render-time
      // derivation.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setTurnVerb(WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)])
    }
    const tick = () => setElapsed(Math.floor((Date.now() - (turnStartRef.current ?? Date.now())) / 1000))
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [isTurnRunning])

  // Auto-scroll to the bottom on new content while pinned. `subagents` is a
  // dep so a sub-agent view follows its own live growth too. followBottom
  // glides rather than teleports; the first render of a replayed history is
  // far enough from the bottom to fall into its instant path.
  //
  // LAYOUT effect, not a passive one: a passive effect runs AFTER the browser
  // has painted, so the glide only STARTED a frame after the content grew - the
  // view sat at the old offset for one frame, then began easing. Running before
  // paint means the growth and the first step of the glide land in the same
  // frame, which is what makes it read as one continuous slide rather than a
  // stutter then a slide (most visible where a streamed thinking block settles
  // into its card, a ~22px step).
  useLayoutEffect(() => {
    if (pinnedRef.current) followBottom()
    // followBottom only touches refs, so it isn't a meaningful dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stream, replayDone, pendingSends, subagents])

  // Follow the bottom continuously while pinned as the geometry changes
  // between renders - notably during a card's 0.22s expand/collapse animation,
  // which grows the height frame-by-frame. Without this the disclosure glides
  // open and then the view snaps to the bottom in one jump once React next
  // re-renders (item 55). The VIEWPORT is observed too: the composer sits
  // below the scroll pane, so a growing textarea (a wrapped line) shrinks the
  // pane without touching the content height - re-pin then as well. A no-op
  // when the user has scrolled up (not pinned), so load-older prepends and the
  // restored offset are left alone.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) followBottom()
    })
    ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
    // followBottom only touches refs, so it isn't a meaningful dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Opening an agent that has unread changes: land on the TOP of its last
  // message rather than pinned to the bottom, so a long reply is read from its
  // first line instead of its last. Runs once per agent, after the replayed
  // history has laid out, and only when the agent isn't mid-turn (a running
  // agent is better followed at the bottom, where its output is arriving).
  //
  // The scroll is written directly (no smooth behaviour) inside the same
  // pre-paint frame the restore effect uses, so the pane is simply *at* the
  // right place on first paint - there is no visible jump to animate away.
  // Declared after the saved-offset restore so its rAF runs last: for an agent
  // with unread changes the new content wins over where you were reading before.
  const alignedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!replayDone || openedUnread.unread !== true || isTurnRunning) return
    if (alignedForRef.current === unreadKey) return
    const el = scrollRef.current
    if (!el) return
    alignedForRef.current = unreadKey

    // Scroll the last message's top just below the cards floating over the top
    // of the transcript (the sub-agent selector, the plan panel), so the first
    // line isn't tucked under one. Nothing floating means a small breathing gap.
    // The offset we last wrote, so a re-align can tell its own work from the
    // user having scrolled in the meantime (at which point it stops).
    let appliedTop: number | null = null
    const alignToLastMessage = () => {
      if (appliedTop != null && Math.abs(el.scrollTop - appliedTop) > BOTTOM_SLACK_PX) {
        ro.disconnect()
        return
      }
      const rows = el.querySelectorAll<HTMLElement>('[data-chat-message]')
      const last = rows[rows.length - 1]
      if (!last) return
      const paneTop = el.getBoundingClientRect().top
      let clear = paneTop + ALIGN_GAP_PX
      for (const card of el.parentElement?.querySelectorAll<HTMLElement>('[data-chat-overlay]') ?? []) {
        clear = Math.max(clear, card.getBoundingClientRect().bottom + ALIGN_GAP_PX)
      }
      const top = el.scrollTop + last.getBoundingClientRect().top - clear
      const maxTop = el.scrollHeight - el.clientHeight
      const applied = Math.max(0, Math.min(top, maxTop))
      // Take the pane off any in-flight pinned glide (followBottom) before
      // placing it, rather than leaving that loop to notice the unpin a frame
      // later and drag the view part-way back down first.
      stopFollow()
      el.scrollTop = applied
      appliedTop = applied
      // A short last message can leave the pane at its bottom anyway - stay
      // pinned then, so live output keeps following as usual.
      const atBottom = maxTop - applied <= BOTTOM_SLACK_PX
      pinnedRef.current = atBottom
      setPinned(atBottom)
      lastScrollRef.current = { top: applied, pinned: atBottom }
    }

    // Markdown, code highlighting and images settle over the frames after the
    // replay, each nudging the message down. Re-align while that happens, then
    // hand the pane back to the user.
    const ro = new ResizeObserver(() => alignToLastMessage())
    const raf = requestAnimationFrame(alignToLastMessage)
    const content = contentRef.current
    if (content) ro.observe(content)
    const stop = setTimeout(() => ro.disconnect(), ALIGN_SETTLE_MS)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(stop)
      ro.disconnect()
    }
  }, [replayDone, openedUnread.unread, isTurnRunning, unreadKey])

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
    const normalized = usesNormalizedEvents && normalizedAvailableRef.current
    const anchor = normalized ? oldestEventCursorRef.current : oldestUuidRef.current
    if (loadingOlderRef.current || allHistoryLoaded || !replayDone || !anchor) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    ws.send(normalized
      ? JSON.stringify({ type: 'load_events_before', cursor: anchor, limit: 100 })
      : JSON.stringify({ type: 'load_before', before: anchor }))
  }

  // requestSubagentEvents fetches a sub-agent's full step history the first time
  // its tab is opened. A sub-agent's steps are sidechain events interleaved in
  // the main event log and reach the client only with the loaded main-
  // conversation window, so a sub-agent that ran before that window would show
  // an empty tab until the user scrolled the main history back to it. The daemon
  // reply is deduped by seq (firstNormalizedDelivery), so a later scroll re-
  // delivering the same events is harmless. Only the normalized path (Claude /
  // Codex) has this split; the legacy transcript path backfills every sub-agent
  // sidecar up front.
  function requestSubagentEvents(subID: string) {
    if (!usesNormalizedEvents || !subID || requestedSubsRef.current.has(subID)) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    requestedSubsRef.current.add(subID)
    ws.send(JSON.stringify({ type: 'load_subagent', sub_id: subID }))
  }

  // Fetch a sub-agent's history the moment its tab opens (or once the socket is
  // ready, if it was opened before). No deps array, mirroring the auto-fill
  // effect below: requestSubagentEvents self-guards so re-runs are cheap no-ops.
  useEffect(() => {
    if (!replayDone || chatView === 'main') return
    requestSubagentEvents(chatView)
  })

  // Auto-fill: when the loaded window is shorter than the pane (a byte-dense
  // backfill - a few image reads can eat the whole window in a handful of
  // messages), there is no scrollbar, so scrolling can never trigger the
  // load-older request. Keep paging older history in until the pane overflows
  // (or history runs out). Re-checked after every batch lands (items change
  // clears loadingOlder).
  useEffect(() => {
    if (!replayDone || loadingOlder || allHistoryLoaded || chatView !== 'main') return
    const el = scrollRef.current
    if (!el || el.clientHeight === 0) return
    if (el.scrollHeight <= el.clientHeight + 1) requestOlderHistory()
  })

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    // Load-older pages main history; a sub-agent view fetches its whole run up
    // front when opened (requestSubagentEvents), so it never pages here.
    if (el.scrollTop < 300 && chatView === 'main') requestOlderHistory()
    // Re-ACQUIRING the pin needs the view actually AT the bottom (a few px of
    // sub-pixel slack), not merely "within 40px". The old 40px band re-pinned on
    // any non-upward scroll event while near the bottom, so a small macOS
    // trackpad nudge unpinned on its own event but the very next settling event
    // (still inside the band, no further upward move) slammed the pin straight
    // back on - the reported "stuck at the bottom" bug.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4
    // Only a genuine UPWARD user move unpins. A content SHRINK (a card
    // collapsing, a streamed block replaced by something shorter) clamps
    // scrollTop down on its own, so don't misread that as a scroll-up - and
    // neither is the pane GROWING taller: the composer shrinking back after a
    // few lines are deleted hands its height to the scroll pane, which lowers
    // the max scroll offset and clamps scrollTop down exactly the same way.
    // Without this the chat came unmoored from the bottom whenever you typed a
    // multi-line message and then deleted it again.
    // inSelfReflow covers the case the geometry test cannot see: a step folding
    // away while the next one arrives, where the shrink and the growth land in
    // one event and only scrollTop looks like it moved (see markSelfReflow).
    const shrank =
      el.scrollHeight < prevScrollHeightRef.current - 1 ||
      el.clientHeight > prevClientHeightRef.current + 1 ||
      inSelfReflow()
    const scrolledUp = !shrank && el.scrollTop < prevScrollTopRef.current - 1
    prevScrollTopRef.current = el.scrollTop
    prevScrollHeightRef.current = el.scrollHeight
    prevClientHeightRef.current = el.clientHeight
    // Unpin on an upward move; otherwise HOLD the pin if we already had it, and
    // (re)acquire it only on reaching the bottom. Holding via pinnedRef is what
    // keeps content growing faster than the follow effects re-pin (a card
    // mid-expansion opening a >40px gap for a frame) from reading as "scrolled
    // away" - scrolledUp is false there, so the pin holds.
    const pin = scrolledUp ? false : (pinnedRef.current || atBottom)
    pinnedRef.current = pin
    setPinned(pin)
    // A hidden pane has no geometry; don't let a stray 0-measurement clobber
    // the remembered offset. A sub-agent view's offsets aren't remembered at
    // all - the saved spot belongs to the main conversation.
    if (!active || el.clientHeight === 0 || chatView !== 'main') return
    lastScrollRef.current = { top: el.scrollTop, pinned: pin }
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

  const attachmentsRef = useRef<Attachment[]>(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
    // Mirror to the per-agent cache so a switch away restores them.
    saveChatAttachments(chatDraftKey(projectId, agentId), attachments)
  }, [attachments, projectId, agentId])
  // Every preview object URL minted this session. We can't revoke on remove (an
  // undo can bring the chip back) or on unmount (the attachments are stashed to
  // the cache and restored on return), so URLs live until a send consumes the
  // draft - then we revoke them all at once (and otherwise until reload).
  const objectUrlsRef = useRef<Set<string>>(new Set())
  // On unmount (agent switch), keep the draft's attachments alive in the cache -
  // do NOT revoke their object URLs, so returning to the agent restores working
  // thumbnails. They're freed on send, or when the page fully reloads.
  useEffect(
    () => () => {
      saveChatAttachments(chatDraftKey(projectId, agentId), attachmentsRef.current)
      patchAgentViewPrefs(projectId, agentId, { chatDraft: inputRef.current || undefined })
    },
    [projectId, agentId],
  )

  // addFiles queues each dropped/pasted file as an attachment and uploads it.
  // Generically-named images (image.png, or nameless pastes) are renamed
  // image1.png, image2.png, ... so each gets a stable, unique on-disk name. The
  // number is max(existing image<N> on the current attachments) + 1, computed
  // fresh here rather than from an ever-growing counter: it resets to 1 once the
  // attachments clear on send, and fills the gap after a removal (so removing #2
  // and re-adding reuses 2, not 3). Each chip is its own undo step; the async
  // upload result patches the chip across the whole timeline (reconcile) rather
  // than pushing a step, so undoing to an earlier snapshot still shows the
  // settled path, not a stale "uploading...".
  function addFiles(rawFiles: File[]): string[] {
    let nextN = nextGenericImageNumber(attachmentsRef.current)
    const names: string[] = []
    for (const raw of rawFiles) {
      let file = raw
      if (isImageFile(raw) && isGenericImageName(raw.name)) {
        const ext = (raw.name.match(/\.([^.]+)$/)?.[1] || raw.type.split('/')[1] || 'png').toLowerCase()
        file = new File([raw], `image${nextN}.${ext}`, { type: raw.type, lastModified: raw.lastModified })
        nextN++
      }
      const id = nextAttachmentId()
      // One object URL per file, whatever it is: it backs the lightbox for every
      // attachment, and doubles as the thumbnail source for the images.
      const objectUrl = URL.createObjectURL(file)
      objectUrlsRef.current.add(objectUrl)
      const chip: Attachment = { id, filename: file.name || 'pasted-image', path: null, url: objectUrl, previewUrl: isImageFile(file) ? objectUrl : undefined, size: file.size, uploading: true }
      commit((prev) => makeSnapshot(prev.prompt, [...prev.attachments, chip], prev.selStart, prev.selEnd), false)
      uploadFile(projectId, file)
        .then((res) => reconcile(id, { path: res.path, uploading: false }))
        .catch((err) => reconcile(id, { uploading: false, error: formatError(err) }))
      names.push(file.name || 'pasted-image')
    }
    return names
  }

  // Removing a chip is its own undo step. Don't revoke the preview URL here - an
  // undo can bring the chip back; URLs are freed in bulk on send (objectUrlsRef).
  function removeAttachment(id: number) {
    commit(
      (prev) => makeSnapshot(prev.prompt, prev.attachments.filter((a) => a.id !== id), prev.selStart, prev.selEnd),
      false,
    )
  }

  // Insert "[filename]" paste markers into the composer at the caret, as their
  // own undo step, so a single Ctrl+Z removes them (and, paired with the chip's
  // own step, walks the whole paste back). The text before the caret decides
  // whether they need a leading space; they never carry a trailing one, so the
  // caret stays against the "]".
  function insertPasteMarkers(names: string[]) {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? input.length
    const end = ta?.selectionEnd ?? input.length
    const insert = pasteMarkerText(names, input.slice(0, start))
    const caret = start + insert.length
    commit(
      (prev) => makeSnapshot(prev.prompt.slice(0, start) + insert + prev.prompt.slice(end), prev.attachments, caret, caret),
      false,
    )
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = ta.selectionEnd = caret
    })
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = extractFiles(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    const names = addFiles(files)
    // With the preference on, also reference the pasted attachments in the
    // message text via "[filename]" markers at the caret.
    if (pasteMarkers && names.length > 0) insertPasteMarkers(names)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const isFileDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

  const uploading = attachments.some((a) => a.uploading)
  const readyAttachments = attachments.filter((a) => a.path && !a.error)
  // Every attachment is openable, in chip order - the lightbox navigates this list
  // and each chip opens at its own index (see lib/attachmentLightbox).
  const openable = openableAttachments(attachments)
  const lightboxItems = attachmentLightboxItems(attachments)
  const canSend = connected && !uploading && (!!input.trim() || readyAttachments.length > 0)

  // --- Composer: slash commands ----------------------------------------------

  // The popup only engages while the input is a single beginning-of-message
  // "/token" (the moment a space is typed the command is committed).
  const slashQuery = useMemo(() => /^\/([\w:-]*)$/.exec(input)?.[1] ?? null, [input])
  const slashMatches = useMemo(() => {
    if (slashQuery == null || slashDismissed || slashCommands.length === 0) return []
    const q = slashQuery.toLowerCase()
    // No cap: the popup is scrollable, so bare "/" can page through every
    // advertised command instead of an arbitrary first-8 subset.
    return slashCommands.filter((c) => c.toLowerCase().startsWith(q))
  }, [slashQuery, slashDismissed, slashCommands])
  // Reset the highlighted row to the top when the query changes, during render.
  const [prevSlashQuery, setPrevSlashQuery] = useState(slashQuery)
  if (prevSlashQuery !== slashQuery) {
    setPrevSlashQuery(slashQuery)
    setSlashSel(0)
  }
  // Keep the highlighted row visible as the selection moves through a list
  // taller than the popup's max height.
  useEffect(() => {
    selectedSlashRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slashSel])

  function acceptSlash(cmd: string) {
    const value = '/' + cmd + ' '
    commit((prev) => makeSnapshot(value, prev.attachments, value.length, value.length), false)
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
    // Bail when the height is unchanged (sub-pixel tolerance): a fractional
    // lineHeight can make this recompute a hair-different value each pass, and an
    // unconditional setState there would keep committing - a needless re-render at
    // best, a feedback loop with any height-driven layout at worst.
    //
    // The guard is a REF compare, not `setComposerHeight(cur => cur)`. React only
    // skips a same-value update when it can evaluate the updater eagerly, which
    // it cannot once the hook already has a queued update - and during a fast
    // typing burst it always does. Every keystroke then scheduled another render
    // from inside this effect, i.e. a nested update per commit, and after 50 of
    // them React threw "Maximum update depth exceeded" (error #185) out of the
    // next keystroke's handler - dropping that character. Comparing here means
    // the steady state schedules nothing at all.
    const nextH = rows * lineHeight + pad
    if (Math.abs(composerHeightRef.current - nextH) >= 0.5) {
      composerHeightRef.current = nextH
      setComposerHeight(nextH)
    }
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
    const clientId = randomId()
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
      optimisticTextsRef.current.push({ clientId, text })
      // It starts a turn; nudge the status optimistically (like the terminal's
      // Enter handling), unless the agent is answering our question.
      if (status !== AgentStatus.NEEDS_INPUT) {
        useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
        onStatusUpdateRef.current?.(AgentStatus.RUNNING)
      }
    }
    return true
  }

  // sendShellCommand runs a composer "!command" (the text after the leading "!"):
  // it asks the daemon to run the command in the head's sandbox, shows an
  // optimistic "running" card straight away, and settles it when the result
  // event arrives (the same result is delivered to the agent as a user turn).
  // Returns false when the socket isn't usable.
  function sendShellCommand(command: string): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    pinnedRef.current = true
    setPinned(true)
    const clientId = randomId()
    ws.send(JSON.stringify({ type: 'shell_command', id: clientId, command }))
    optimisticShellRef.current.add(clientId)
    setItems((prev) => [...prev, { kind: 'shellCmd', id: optimisticIdRef.current--, clientId, command, output: '', running: true }])
    return true
  }

  // stopShellCommand asks the daemon to kill a running "!command" (the card's
  // Stop button). The card stays "running" until the command's settle event
  // arrives marked stopped - the same path a natural finish takes.
  function stopShellCommand(clientId: string) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'shell_stop', id: clientId }))
  }

  // renderComposerBackdrop highlights the composer's transparent-text backdrop:
  // a "!command" gets a terracotta "!" and bash syntax highlighting (so shell
  // mode is unmistakable as you type), everything else the usual inline markdown.
  // MUST preserve the value's exact characters so the backdrop stays aligned.
  const renderComposerBackdrop = useCallback((value: string): ReactNode => {
    if (value.startsWith('!')) {
      const command = value.slice(1)
      const html = highlightHtml(command, 'bash')
      return (
        <>
          <span className="font-semibold text-[#c96442]">!</span>
          {html != null ? <span dangerouslySetInnerHTML={{ __html: html }} /> : command}
        </>
      )
    }
    return renderMarkdownSource(value)
  }, [])

  function send() {
    if (uploading) return
    const text = input.trim()
    // A leading "!" runs the rest as a shell command in the head's sandbox (a
    // bare "!" is left alone as literal text). Attachments don't apply.
    if (text.startsWith('!') && text.length > 1) {
      const command = text.slice(1).trim()
      if (command && sendShellCommand(command)) {
        setSlashDismissed(false)
        objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
        objectUrlsRef.current.clear()
        resetHistory(makeSnapshot('', [], 0, 0))
        setLightboxIndex(null)
      }
      return
    }
    const paths = readyAttachments.map((a) => a.path as string)
    // Attachment paths ride below the typed text, same as the spawn box - the
    // agent reads the uploaded files from inside its sandbox.
    const finalText = paths.length > 0 ? (text ? `${text}\n\n${paths.join('\n')}` : paths.join('\n')) : text
    if (!finalText || !sendUserText(finalText)) return
    setSlashDismissed(false)
    // The message is sent - free every preview URL minted this session (including
    // ones only reachable via undo history) and reset the composer + its history.
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    objectUrlsRef.current.clear()
    resetHistory(makeSnapshot('', [], 0, 0))
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
  // (control_response with the answers merged into updatedInput). Any notes go
  // in the tool's own `annotations` field, which the CLI renders into the tool
  // result next to the answer they qualify.
  function answerQuestion(
    item: Extract<ChatItem, { kind: 'question' }>,
    answers: Record<string, string>,
    annotations: QuestionAnnotations,
  ): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !item.requestId) return false
    const input = typeof item.input === 'object' && item.input !== null ? (item.input as Record<string, unknown>) : {}
    const updatedInput: Record<string, unknown> = { ...input, answers }
    if (Object.keys(annotations).length > 0) updatedInput.annotations = annotations
    ws.send(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: item.requestId,
          response: { behavior: 'allow', updatedInput },
        },
      }),
    )
    return true
  }

  // answersAsText renders an answers map as the plain-text reply used by the
  // fenced ```question fallback (one "<question>: <labels>" line each). There is
  // no tool result to carry an `annotations` field here, so a note is spelled
  // out inline instead.
  function sendAnswersAsText(answers: Record<string, string>, annotations: QuestionAnnotations): boolean {
    const lines = Object.entries(answers).map(([q, a]) => {
      const note = annotations[q]?.notes
      return `${q}: ${a || '(no option selected)'}${note ? ` - note: ${note}` : ''}`
    })
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

  // A typed edit: one coalesced undo step per typing burst, capturing the caret
  // so undo/redo can restore it. Dismisses the slash popup like the old handler.
  function handleInputChange(value: string) {
    const ta = textareaRef.current
    const selStart = ta?.selectionStart ?? value.length
    const selEnd = ta?.selectionEnd ?? value.length
    commit((prev) => makeSnapshot(value, prev.attachments, selStart, selEnd), true)
    setSlashDismissed(false)
  }

  // Ctrl+Enter / Alt+Enter insert a newline explicitly (plain Enter sends), so
  // they carry the same markdown list continuation the shared textarea handler
  // gives Shift+Enter - the box shouldn't behave differently depending on which
  // newline key you reached for.
  function insertNewline(ta: HTMLTextAreaElement) {
    const start = ta.selectionStart ?? input.length
    const end = ta.selectionEnd ?? input.length
    const edit = enterEdit(ta.value, start, end)
    const next = edit ?? {
      value: ta.value.slice(0, start) + '\n' + ta.value.slice(end),
      caret: start + 1,
    }
    commit((prev) => makeSnapshot(next.value, prev.attachments, next.caret, next.caret), false)
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = next.caret
      ensureCaretVisible(ta)
    })
  }

  // Restore a snapshot returned by undo/redo: put the caret back where it was
  // when that snapshot was current (after the controlled value commits, hence
  // the rAF). The draft is re-persisted by the debounced `input` effect.
  function restoreSnapshot(snap: ReturnType<typeof undo>) {
    if (!snap) return
    const ta = textareaRef.current
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      ta.selectionStart = snap.selStart
      ta.selectionEnd = snap.selEnd
    })
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Undo/redo over the composer's own history (text + attachments). Our stack
    // drives these because pastes-turned-chips call preventDefault, so the
    // browser's native textarea undo never recorded them. Cmd/Ctrl+Z undo,
    // +Shift redo, and Ctrl+Y redo (Windows convention).
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        restoreSnapshot(e.shiftKey ? redo() : undo())
        return
      }
      if (k === 'y' && !e.shiftKey) {
        e.preventDefault()
        restoreSnapshot(redo())
        return
      }
    }
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
        const restored = recalled.map((a) => ({ ...a, id: nextAttachmentId() }))
        commit(() => makeSnapshot(body, restored, body.length, body.length), false)
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

  // copyTranscriptAsMarkdown puts markdown source on the clipboard when a
  // selection inside the transcript is copied: chat messages are RENDERED
  // markdown, so a default copy drops the asterisks, fences, bullets and table
  // pipes the agent (or the user) actually wrote. selectionToMarkdown walks the
  // selected DOM and re-serializes it; the chat's non-markdown chrome (tool
  // cards, diffs) still comes out as plain text, as before. Selecting inside a
  // single code block yields the raw code, not a fenced block.
  function copyTranscriptAsMarkdown(event: ClipboardEvent<HTMLDivElement>) {
    const md = selectionToMarkdown(window.getSelection())
    if (!md) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', md)
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
      if (before.trim()) parts.push(<Markdown key={key++} text={before} linkCtx={chatLinkCtx} />)
      const specs = parseQuestionBlock(m[1])
      if (specs) {
        parts.push(
          <div key={key++} className="my-1.5">
            <QuestionCard specs={specs} disabled={!connected} onSubmit={sendAnswersAsText} />
          </div>,
        )
      } else {
        parts.push(<Markdown key={key++} text={m[0]} linkCtx={chatLinkCtx} />)
      }
      rest = rest.slice(m.index + m[0].length)
    }
    if (parts.length === 0) return <Markdown text={text} linkCtx={chatLinkCtx} />
    // eslint-disable-next-line no-useless-assignment -- final key++ is a dead store, but keep it consistent with the pushes above
    if (rest.trim()) parts.push(<Markdown key={key++} text={rest} linkCtx={chatLinkCtx} />)
    return parts
  }

  // Where each Bash command ran, followed across the session's one shell. The
  // worktree is only the right starting point once the WHOLE conversation is
  // loaded - with older history still unread the shell could have been left
  // anywhere, so the tracking starts out knowing nothing and re-anchors on the
  // first absolute `cd` (which is exactly what an agent's defensive
  // `cd <the worktree> && ...` prefix is).
  const shellCwds = useMemo(
    () => shellCwdsFor(items, allHistoryLoaded ? worktreePath : null),
    [items, worktreePath, allHistoryLoaded],
  )

  function renderChatItem(item: ChatItem, shellCwd: string | null = null): ReactNode {
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
        // A local command's stdout (in practice the "Set model to ..."
        // confirmation): a short bookkeeping line, so render it as the same
        // centered notification pill the notice/skill/meta chips use rather than
        // a code panel.
        return (
          <div className="flex justify-center">
            <div
              className="flex max-w-[90%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 select-none"
              title={item.text}
            >
              <SlidersHorizontal className="w-3 h-3 shrink-0" />
              <span className="truncate">{item.text}</span>
            </div>
          </div>
        )
      case 'shellCmd':
        return (
          <ShellCommandCard
            command={item.command}
            output={item.output}
            exitCode={item.exitCode}
            truncated={item.truncated}
            timedOut={item.timedOut}
            stopped={item.stopped}
            running={item.running}
            onStop={item.running && item.clientId ? () => stopShellCommand(item.clientId as string) : undefined}
          />
        )
      case 'notice': {
        // Completion is a compact link back to the canonical launch card/chat;
        // rendering the entire SubagentCard here duplicated prompt and report.
        const sub = item.subagentKey ? subagents[item.subagentKey] : undefined
        if (sub) {
          const tool = sub.toolUseId ? taskToolByUse[sub.toolUseId] : undefined
          const { desc } = subLabels(sub, tool)
          return (
            <div className="flex justify-center">
              <button onClick={() => openSubView(sub.agentId)} className="flex max-w-[90%] items-center gap-1.5 rounded-full border border-stone-200 dark:border-white/[0.08] bg-stone-100/60 dark:bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer">
                <span className="truncate">Sub-agent finished{desc ? `: ${desc}` : ''}</span>
                <MessageSquare className="h-3 w-3 shrink-0" />
              </button>
            </div>
          )
        }
        // A background sub-agent's completion notice resolves its sub-agent at
        // render time (by the notification's task-id / tool-use-id) - clicking
        // opens that agent's chat. A background command's notice (it carried an
        // <output-file>) expands to show the command's output.
        const linked = (item.taskId ? subagents[item.taskId] : undefined) ??
          (item.toolUseId ? subByToolUse[item.toolUseId] : undefined)
        // "finished" while the agent's own spawned sub-agents still run is the
        // harness's stopped-notification, not the end of the work - relabel the
        // chip until the subtree is quiet.
        const noticeText =
          linked && subsAwaitingChildren.has(linked.agentId)
            ? item.text.replace(/\bfinished\b/, 'waiting on sub-agents')
            : item.text
        return (
          <NoticePill
            text={noticeText}
            onOpenChat={linked ? () => openSubView(linked.agentId) : undefined}
            outputFile={linked ? undefined : item.outputFile}
            requestTaskOutput={requestTaskOutput}
          />
        )
      }
      case 'commit': {
        // A commit chip: the same centered notification-pill look as
        // notice/cmdout, clickable to show just this commit in the diff view. A
        // merge chip is its own component so it can own its expand/collapse state.
        if (item.isMerge) {
          return (
            <div className="flex justify-center">
              <MergeCommitChip item={item} onSelectCommit={onSelectCommit} />
            </div>
          )
        }
        const clickable = !!onSelectCommit
        const activate = () => onSelectCommit?.(item.sha)
        return (
          <div className="flex justify-center">
            <div
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? activate : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } } : undefined}
              className={`${COMMIT_PILL} max-w-[90%] ${clickable ? COMMIT_HOVER : ''}`}
              title={clickable ? `Committed ${item.shortSha} - click to show this commit's diff` : `Committed ${item.shortSha}`}
            >
              <GitCommitHorizontal className="w-3 h-3 shrink-0" />
              <span className="font-mono shrink-0">{item.shortSha}</span>
              <span className="truncate">{item.subject}</span>
            </div>
          </div>
        )
      }
      case 'contextNote':
        return <ContextNoteCard text={item.text} outOfContext={item.outOfContext} />
      case 'skill':
        return <SkillCard name={item.name} text={item.text} />
      case 'meta':
        return <MetaCard text={item.text} />
      case 'interrupted':
        return (
          <div className="flex justify-end">
            <div className="rounded-lg border border-red-300/60 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30 px-2.5 py-1 text-xs text-red-600 dark:text-red-300 select-none">
              Interrupted by user
            </div>
          </div>
        )
      case 'assistant':
        return <div className={`max-w-[95%] chat-font ${serif ? 'chat-serif' : 'chat-leading'}`}>{renderAssistantText(item.text)}</div>
      case 'thinking':
        return <ThinkingCard text={item.text} durationMs={item.durationMs} />
      case 'tool': {
        // A Task tool card whose sub-agent we've linked upgrades into the
        // richer SubagentCard (its inner timeline + report) in place.
        const sub = subByToolUse[item.toolUseId]
        if (sub)
          return (
            <SubagentCard sub={sub} tool={item} worktree={worktreePath} links={subagentLinks} onOpenChat={() => openSubView(sub.agentId)} />
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
                onOpenChat={linked ? () => openSubView(linked.agentId) : undefined}
              />
            )
          }
        }
        // A SendMessage knows which agent it addressed: resolve that sub-agent so
        // the card can name it, show whether it is working, and link into its
        // chat.
        if (item.name === 'SendMessage') {
          const to = sendMessageRecipient(item.input) || parseSendMessageResult(item.result)?.recipient || ''
          const target = to ? subagents[to] : undefined
          const targetTool = target?.toolUseId ? taskToolByUse[target.toolUseId] : undefined
          const labels = target ? subLabels(target, targetTool) : null
          return (
            <ToolCard
              item={item}
              worktree={worktreePath}
              recipientId={target?.agentId ?? to}
              recipientLabel={labels ? labels.desc || labels.label : ''}
              recipientRunning={target ? isSubRunning(target, targetTool) : false}
              openSub={target ? openSubView : undefined}
            />
          )
        }
        return <ToolCard item={item} worktree={worktreePath} shellCwd={shellCwd} />
      }
      case 'subagent': {
        // A sub-agent with no parent Task card (its meta lacked a tool_use id).
        const sub = subagents[item.agentId]
        if (!sub) return null
        // The link can land AFTER the standalone item was pushed (a meta frame
        // that finally carried the tool_use id, or a nested sub's parent): once
        // another card renders this sub, the standalone copy is a duplicate.
        if (sub.parentAgentId) return null
        if (sub.toolUseId && taskToolByUse[sub.toolUseId]) return null
        return <SubagentCard sub={sub} worktree={worktreePath} links={subagentLinks} onOpenChat={() => openSubView(sub.agentId)} />
      }
      case 'question': {
        // Its control_request channel dies with the turn that raised it, and
        // the request_id outlives it in the transcript - so an expired card
        // would otherwise still look answerable and swallow the answer (see
        // expireQuestions). Expired, it stays fillable but sends the answers as
        // an ordinary message, which is the only thing the agent can still read.
        const expired = item.result == null && item.expired === true
        return (
          <QuestionCard
            specs={item.specs}
            disabled={!connected || (!expired && item.requestId == null)}
            expired={expired}
            answeredText={item.result}
            onSubmit={(answers, annotations) =>
              expired ? sendAnswersAsText(answers, annotations) : answerQuestion(item, answers, annotations)
            }
          />
        )
      }
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
              <WorkSpark still />
              {/* Inline, not a flex row: `.optical-center` trims a block's line
                  boxes, and a flex container has none - so the separator carries
                  the spacing that `gap-1.5` used to. */}
              {segs.map((s, i) => (
                <span key={i} className="optical-center">
                  {i > 0 && <span className="text-stone-300 dark:text-stone-600 mx-1.5">·</span>}
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
  const contextWindow = contextWindowTokens(model)
  // "Context left" percentage for the composer chip (item 40): null until the
  // first usage sample lands. Clamped to 0-100.
  const contextPct =
    contextTokens > 0
      ? Math.max(0, Math.min(100, Math.round(100 * (1 - contextTokens / contextWindow))))
      : null

  // A turn's result footer (duration/cost) should show once. On a resume the
  // transcript backfill and the live stream can each end with their own result
  // event, landing two footers back to back with nothing between (the "2
  // durations" report); drop a result that is immediately followed by another,
  // keeping only the last of any consecutive run.
  const visibleItems = useMemo(
    () => items.filter((it, i) => !(it.kind === 'result' && items[i + 1]?.kind === 'result')),
    [items],
  )
  // Interleave the commit chips into the settled transcript by timestamp: a
  // chip slots in before the first item stamped after it (so, right where the
  // commit happened). Unstamped items (ring-replayed lines, optimistic sends)
  // inherit their predecessor's position, and chips newer than everything
  // append at the end - the live case, where the commit just landed. Chips
  // older than the loaded window are held back until load-older paging reaches
  // their part of the conversation (they'd otherwise pile up at the top of the
  // tail as if they happened there). Gated on replayDone so chips never render
  // above the "Loading conversation..." placeholder.
  const mergedItems = useMemo(() => {
    if (!replayDone || commitChips.length === 0) return visibleItems
    const tsMap = itemTsRef.current
    let firstTs: number | null = null
    for (const it of visibleItems) {
      const t = tsMap.get(it.id)
      if (t != null) {
        firstTs = t
        break
      }
    }
    const chips = allHistoryLoaded || firstTs == null
      ? commitChips
      : commitChips.filter((c) => c.ts >= firstTs)
    if (chips.length === 0) return visibleItems
    const out: ChatItem[] = []
    let ci = 0
    for (const it of visibleItems) {
      const t = tsMap.get(it.id)
      if (t != null) {
        while (ci < chips.length && chips[ci].ts < t) out.push(chips[ci++])
      }
      out.push(it)
    }
    while (ci < chips.length) out.push(chips[ci++])
    return out
  }, [visibleItems, commitChips, replayDone, allHistoryLoaded])
  // The in-flight streamed reply is the LAST ROW of the transcript, not a
  // separate node underneath it: it carries the id its settled event will land
  // on, so the swap is an in-place update of one row (see liveId). Rendering it
  // outside the list is what used to make it a different DOM node from the
  // message it became - the browser dropped any selection inside it, and the
  // text blinked out for the frame between the two.
  //
  // A closing fence is faked while the text ends inside an open ``` block, so
  // the partial code renders as a code block rather than raw backticks.
  // (A streamed THOUGHT still renders as its own card below - see `stream`
  // further down: a live thought is a different shape from a settled one.)
  const liveItem = useMemo<ChatItem | null>(
    () =>
      stream && stream.kind === 'assistant'
        ? { id: stream.id, kind: 'assistant', text: closeOpenFence(stream.text), noEntrance: true }
        : null,
    [stream],
  )
  // The turn's end-of-turn "Crunched for Xs" footer (a result item) has landed.
  // The agent status flip that clears isTurnRunning can lag a frame behind it, so
  // gate the live "working" indicator on this too - otherwise both the footer and
  // the live "<verb>..." line flash together for a split second at turn end.
  const lastIsResult = visibleItems.length > 0 && visibleItems[visibleItems.length - 1].kind === 'result'

  // toolUseId -> sub-agent, so a Task tool card upgrades into a SubagentCard in
  // place (correct position, live and on backfill) without any marker item.
  const subByToolUse = useMemo(() => {
    const m: Record<string, SubagentView> = {}
    for (const s of Object.values(subagents)) if (s.toolUseId) m[s.toolUseId] = s
    return m
  }, [subagents])

  // Bundle for nested sub-agent rendering (SubagentCard -> SubagentTimeline
  // recursion): see SubagentLinks.
  const subagentLinks = useMemo<SubagentLinks>(
    () => ({ subByToolUse, taskToolByUse, awaitingChildren: subsAwaitingChildren, openSubView }),
    [subByToolUse, taskToolByUse, subsAwaitingChildren, openSubView],
  )

  // The sub-agent whose chat the pane currently shows (undefined = main view,
  // also the fallback while a selected key is missing mid-replay).
  const viewSub = chatView !== 'main' ? subagents[chatView] : undefined
  const viewSubTool = viewSub?.toolUseId ? taskToolByUse[viewSub.toolUseId] : undefined
  const hasSubagents = Object.keys(subagents).length > 0
  // Whether the plan card is on screen - it and the sub-agent selector each
  // take half the row when both are (see their `paired` prop).
  const planVisible = todos.length > 0 && replayDone && !viewSub

  // A stable wrapper around renderChatItem (a per-render closure) so it never
  // trips SettledMessages' memo. It always calls the latest closure via a ref, so
  // it never renders stale data; the inputs that actually change a row's output
  // are passed to SettledMessages explicitly (and listed in its comparator).
  const renderItemRef = useRef(renderChatItem)
  renderItemRef.current = renderChatItem
  const renderItem = useCallback((item: ChatItem, shellCwd?: string | null) => renderItemRef.current(item, shellCwd), [])

  return (
    // Every tool card below can pick up a parked security-gate approval for THIS
    // head and grow its own Allow/Deny row (see ToolApproval). The agent type
    // rides alongside it so chat chrome (the working spark) can take this head's
    // brand accent instead of Claude's unconditionally.
    <ChatAgentTypeContext.Provider value={agentType ?? 'claude'}>
    <ChatApprovalContext.Provider value={approvalCtx}>
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
        {/* Floating cards over the transcript: the current-agents selector
            (top-left, once any sub-agent exists) and the plan panel
            (top-right). Both are corner-anchored so expanding one never
            relocates the other (no pushing/jumping): with both on screen they
            split the row in half (`paired`) so neither can reach the other's
            corner - and so neither can cover the other's clicks. */}
        {hasSubagents && (
          <ChatViewSelector
            chatView={viewSub ? chatView : 'main'}
            subagents={subagents}
            taskToolByUse={taskToolByUse}
            awaitingChildren={subsAwaitingChildren}
            onSelect={(key) => (key === 'main' ? setChatView('main') : openSubView(key))}
            fadeIn={liveUiRef.current}
            paired={planVisible}
          />
        )}
        {/* Current plan (item 17): the agent's latest TodoWrite. Main view
            only - it is the main agent's plan. */}
        {planVisible && (
          <PlanPanel
            todos={todos}
            narrow={paneWidth > 0 && paneWidth < 560}
            paired={hasSubagents}
            fadeIn={liveUiRef.current}
          />
        )}
        {/* [overflow-anchor:none]: the browser's scroll anchoring would adjust
            scrollTop to keep an arbitrary anchor node stable when content above
            the fold grows (an expanding card), firing a scroll event that lands
            outside the near-bottom threshold and un-pins the follow - whether it
            happened depended on which node got picked as the anchor. Our own
            pin/follow logic owns bottom-following instead. */}
        <div
          ref={scrollRef}
          data-chat-scroll
          onScroll={onScroll}
          onCopy={copyTranscriptAsMarkdown}
          className="h-full overflow-y-auto [overflow-anchor:none]"
        >
          <div ref={contentRef} className="mx-auto max-w-5xl px-4 py-3 flex flex-col gap-3">
          {viewSub ? (
            <SubagentChatView sub={viewSub} tool={viewSubTool} worktree={worktreePath} links={subagentLinks} />
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
            items={mergedItems}
            liveItem={liveItem}
            liveFromId={liveFromId}
            renderItem={renderItem}
            serif={serif}
            connected={connected}
            worktreePath={worktreePath}
            subByToolUse={subByToolUse}
            subagents={subagents}
            shellCwds={shellCwds}
          />
          {/* The in-flight streamed REPLY is rendered as the transcript's last
              row (see liveItem); only a streamed thought lands here, using the
              same collapsed card as settled thoughts with its preview
              auto-updating as tokens arrive. It's the current turn's response,
              so it sits ABOVE any queued (held-for-later) messages (item 33).
              The "working" indicator below already signals the turn is live, so
              no blinking caret or per-word opacity animation is applied to
              either: one makes reparsed Markdown visibly flicker as delimiters
              arrive and the syntax tree changes (item 56). */}
          {stream && stream.kind === 'thinking' && <ThinkingCard text={stream.text} streaming />}
          {/* Live "working" indicator (item 48): a playful verb + elapsed time,
              and the running output-token count when the CLI reports it. While a
              thinking block streams, "Thinking..." rides inside the brackets here
              (after the duration and tokens) rather than as a separate line above,
              so the reasoning<->working transition doesn't shift the layout. */}
          {/* One line, always. The bracket grows and shrinks as the turn runs
              (tokens appear, "Thinking..." comes and goes), and on a narrow pane
              that made the row wrap to two lines and back. The view is anchored
              to the BOTTOM, so a second line pushes the row's top - and the mark
              on it - up ~17px and then back down: exactly the wobble the eased
              follow was blamed for. Truncating the secondary text instead keeps
              the mark on one fixed line at any width. */}
          {isTurnRunning && replayDone && !lastIsResult && (
            <div className="flex items-center gap-1.5 text-[11px] select-none whitespace-nowrap animate-chat-item-in">
              <WorkSpark />
              <span className="chat-text-shimmer font-medium shrink-0 optical-center">{turnVerb}...</span>
              {/* tabular-nums so the ticking elapsed seconds / token count keep a
                  fixed width and the line doesn't jitter horizontally as they change. */}
              <span className="min-w-0 truncate text-stone-400 dark:text-stone-500 tabular-nums optical-center">
                ({formatDuration(elapsed * 1000)}
                {turnTokens > 0 ? ` · ↓ ${formatTokens(turnTokens)} tokens` : ''}
                {stream?.kind === 'thinking' ? ' · Thinking...' : ''})
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
                <div key={`pending-${p.id}`} className="group relative animate-chat-item-in">
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
          // The float (absolute + centring translate) moves to the wrapper, which
          // is now what sits in the transcript pane.
          <Tooltip content="Jump to bottom (Ctrl+End)" side="top" className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
            <button
              onClick={() => scrollToBottom(true)}
              aria-label="Jump to bottom"
              className="rounded-full border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] p-1.5 text-stone-500 dark:text-stone-300 shadow-md hover:text-stone-700 dark:hover:text-stone-100 hover:shadow-lg transition-all cursor-pointer animate-chat-item-in"
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          </Tooltip>
        )}
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
          className="group/resize flex h-2.5 cursor-ns-resize touch-none items-center justify-center"
          title="Drag to resize"
        >
          <ResizeGrip orientation="horizontal" />
        </div>
        <div className="relative mx-auto max-w-5xl">
          {slashMatches.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1.5 z-20 w-64 max-h-64 overflow-y-auto rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-lg py-1">
              {slashMatches.map((c, i) => (
                <button
                  key={c}
                  ref={i === slashSel ? selectedSlashRef : undefined}
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
              onOpen={(id, origin) => {
                setLightboxOrigin(origin)
                setLightboxIndex(openable.findIndex((a) => a.id === id))
              }}
            />
            <HighlightedTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={handlePaste}
              renderContent={renderComposerBackdrop}
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
                {/* Context-left chip (item 40): how much of the model's window
                    the conversation still has free, left of the model selector.
                    Amber under 20%, red under 10% - a quiet nudge that a compact
                    is near. */}
                {contextPct !== null && (
                  <Tooltip
                    content={`~${contextPct}% context left (${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} used)`}
                    side="top"
                  >
                    <span
                      className={`hidden sm:inline text-[11px] tabular-nums select-none ${
                        contextPct < 10
                          ? 'text-red-500 dark:text-red-400'
                          : contextPct < 20
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-stone-400 dark:text-stone-500'
                      }`}
                    >
                      {contextPct}%
                    </span>
                  </Tooltip>
                )}
                <div className="relative">
                  <Tooltip content="Model" side="top">
                    <button
                      onClick={() => setModelMenuOpen((o) => !o)}
                      disabled={!connected}
                      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors cursor-pointer disabled:opacity-40 ${
                        modelMenuOpen
                          ? 'bg-stone-100 dark:bg-white/[0.08] text-stone-700 dark:text-stone-200'
                          : 'text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-white/[0.06] hover:text-stone-700 dark:hover:text-stone-200'
                      }`}
                    >
                      {modelLabel}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </Tooltip>
                  {modelMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setModelMenuOpen(false)} />
                      <div className="absolute bottom-full right-0 mb-1 z-20 w-36 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e] shadow-lg py-1">
                        {(agentType === 'codex' ? CODEX_MODELS : CLAUDE_MODELS).map((m) => (
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

      {lightboxIndex !== null && lightboxItems.length > 0 && (
        <Lightbox
          items={lightboxItems}
          index={Math.min(lightboxIndex, lightboxItems.length - 1)}
          origin={lightboxOrigin}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
    </ChatApprovalContext.Provider>
    </ChatAgentTypeContext.Provider>
  )
}
