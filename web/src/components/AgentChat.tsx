import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, CircleStop, SendHorizontal, Wrench } from 'lucide-react'
import { AgentStatus } from '../api'
import { useAgentStore } from '../stores/agentStore'
import { renderMarkdown, renderMarkdownBlocks } from '../lib/markdown'
import { closeWebSocket } from '../lib/ws'
import { getWsUrl } from '../lib/terminalWs'

// ChatPane renders a chat-mode head (CHAT_MODE.md): it speaks the chat framing
// on the same terminal WebSocket - {"type":"claude_event"} frames carrying
// verbatim Claude stream-json events out, {"type":"user_message"|"interrupt"}
// frames in - and reduces the event stream into a message list. On (re)connect
// the backend replays the whole conversation from the session's scrollback
// ring (--replay-user-messages includes user turns), so the reducer always
// starts from scratch. Styled dark to match the terminal panel chrome it
// shares (tabs bar, resize handle), independent of the app theme.

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
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'thinking'; id: number; text: string }
  | { kind: 'tool'; id: number; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'result'; id: number; isError: boolean; durationMs?: number; costUsd?: number; errorText?: string }

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
  // Raw API event carried by stream_event lines (--include-partial-messages).
  event?: {
    type?: string
    content_block?: { type?: string }
    delta?: { type?: string; text?: string; thinking?: string }
  }
}

// closeOpenFence appends a virtual closing fence when a streaming text ends
// inside an open ``` block, so the partial code renders as a code block
// instead of raw backticks until the real fence arrives.
function closeOpenFence(text: string): string {
  const opens = (text.match(/^```/gm) ?? []).length
  return opens % 2 === 1 ? text + '\n```' : text
}

// toolResultText flattens a tool_result block's content (string, or an array
// of text blocks) into displayable text.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof (c as ClaudeContentBlock).text === 'string' ? (c as ClaudeContentBlock).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
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

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolInput(item.input)
  const pending = item.result === undefined
  return (
    <div
      className={`rounded border text-xs ${
        item.isError ? 'border-red-800/70 bg-red-950/30' : 'border-gray-700 bg-gray-800/60'
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left cursor-pointer text-gray-300 hover:text-gray-100"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Wrench className={`w-3 h-3 shrink-0 ${item.isError ? 'text-red-400' : 'text-blue-400'}`} />
        <span className="font-medium shrink-0">{item.name}</span>
        <span className="truncate font-mono text-gray-500">{summary}</span>
        {pending && <span className="ml-auto shrink-0 text-[10px] text-yellow-500/90 animate-pulse">running</span>}
      </button>
      {open && (
        <div className="border-t border-gray-700/70 px-2 py-1 space-y-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-gray-400 max-h-48 overflow-y-auto">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {item.result !== undefined && (
            <pre
              className={`whitespace-pre-wrap break-words font-mono text-[11px] max-h-48 overflow-y-auto border-t border-gray-700/50 pt-1 ${
                item.isError ? 'text-red-300' : 'text-gray-300'
              }`}
            >
              {item.result || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingCard({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-gray-500 hover:text-gray-300 cursor-pointer"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="italic">Thinking</span>
      </button>
      {open && <div className="mt-1 pl-4 italic text-gray-500 whitespace-pre-wrap break-words">{item.text}</div>}
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
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Pin-to-bottom: keep auto-scrolling while the user is at (or near) the
  // bottom; stop once they scroll up to read history.
  const pinnedRef = useRef(true)

  const status = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.agent_status?.status)
  const isTurnRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING

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
      // The tool card may still be in the un-flushed batch or already rendered.
      const inPending = pending.find((it) => it.kind === 'tool' && it.toolUseId === toolUseId)
      if (inPending && inPending.kind === 'tool') {
        inPending.result = result
        inPending.isError = isError
        return
      }
      setItems((prev) =>
        prev.map((it) => (it.kind === 'tool' && it.toolUseId === toolUseId ? { ...it, result, isError } : it)),
      )
    }

    const handleClaudeEvent = (ev: ClaudeEvent) => {
      switch (ev.type) {
        case 'user': {
          const content = ev.message?.content
          if (typeof content === 'string') {
            if (content.trim()) push({ kind: 'user', text: content })
            return
          }
          for (const block of content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              push({ kind: 'user', text: block.text })
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
              push({ kind: 'tool', toolUseId: block.id, name: block.name ?? 'tool', input: block.input })
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
          // system/init, rate_limit_event, future kinds: not rendered (yet),
          // deliberately not an error.
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

  // Auto-scroll to the bottom on new content while pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items, stream, replayDone])

  // Re-measure the pin and jump to the bottom when the pane becomes visible
  // (display:none panes have no scroll geometry).
  useEffect(() => {
    if (!active) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  function send() {
    const text = input.trim()
    const ws = wsRef.current
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'user_message', content: [{ type: 'text', text }] }))
    setInput('')
    pinnedRef.current = true
    // The user turn itself comes back via --replay-user-messages, so it is NOT
    // appended optimistically (that would double it). Status is nudged
    // optimistically exactly like the terminal's Enter handling.
    if (status !== AgentStatus.NEEDS_INPUT) {
      useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
      onStatusUpdateRef.current?.(AgentStatus.RUNNING)
    }
  }

  function interrupt() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  return (
    <div className="relative flex-1 min-h-0 flex flex-col text-[13px] text-gray-200">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {!replayDone && items.length === 0 && (
          <div className="text-xs text-gray-500 italic py-2">
            {connected ? 'Loading conversation...' : 'Connecting...'}
          </div>
        )}
        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={item.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-blue-900/60 border border-blue-800/60 px-2.5 py-1.5 whitespace-pre-wrap break-words">
                    {renderMarkdown(item.text)}
                  </div>
                </div>
              )
            case 'assistant':
              return (
                <div key={item.id} className="max-w-[95%]">
                  {renderMarkdownBlocks(item.text)}
                </div>
              )
            case 'thinking':
              return <ThinkingCard key={item.id} item={item} />
            case 'tool':
              return <ToolCard key={item.id} item={item} />
            case 'result':
              if (item.isError) {
                return (
                  <div key={item.id} className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300 whitespace-pre-wrap break-words">
                    {item.errorText || 'The turn ended with an error.'}
                  </div>
                )
              }
              return (
                <div key={item.id} className="text-center text-[10px] text-gray-600 select-none">
                  {item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : ''}
                  {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
                </div>
              )
          }
        })}
        {/* The in-flight streamed block: markdown-rendered live (with a virtual
            closing fence while inside a code block) plus a pulsing caret. */}
        {stream && stream.kind === 'assistant' && (
          <div className="max-w-[95%]">
            {renderMarkdownBlocks(closeOpenFence(stream.text))}
            <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 animate-pulse rounded-sm bg-blue-400/80" />
          </div>
        )}
        {stream && stream.kind === 'thinking' && (
          <div className="text-xs italic text-gray-500 whitespace-pre-wrap break-words">
            {stream.text}
            <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-gray-500/80" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-gray-700 dark:border-gray-600 bg-gray-800/60 p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={connected ? 'Message the agent... (Enter to send, Shift+Enter for newline)' : 'Disconnected'}
            disabled={!connected}
            rows={Math.min(6, Math.max(1, input.split('\n').length))}
            className="flex-1 resize-none rounded border border-gray-600 bg-gray-900/80 px-2 py-1.5 text-[13px] text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 disabled:opacity-50"
          />
          {isTurnRunning && (
            <button
              onClick={interrupt}
              title="Interrupt the running turn"
              className="p-1.5 rounded border border-gray-600 text-red-400 hover:text-red-300 hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <CircleStop className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={send}
            disabled={!connected || !input.trim()}
            title="Send (Enter)"
            className="p-1.5 rounded border border-gray-600 text-blue-400 hover:text-blue-300 hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <SendHorizontal className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
