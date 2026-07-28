import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatPane, normalizedToProviderEvents, reduceHistoryEvents, summarizeToolSearchQuery, toolRawJson } from './AgentChat'
import { newToolResultLink } from '../lib/toolResultLink'

// The chat composer turns a pasted image into an attachment chip and (with the
// paste-markers preference on) a "[filename]" marker in the text. Both mutations
// call preventDefault, so the browser's native textarea undo never sees them -
// Ctrl+Z can only walk them back if the composer drives its own undo history
// (composerHistory). These tests render the real ChatPane and prove a paste is
// undoable: one Ctrl+Z drops the marker, a second drops the chip.

// uploadFile hits the network; stub it (keep extractFiles/isImageFile real, the
// paste path relies on them). It resolves so the chip settles, but the undo
// behaviour doesn't depend on the upload completing.
vi.mock('../api/uploads', async (importActual) => {
  const actual = await importActual<typeof import('../api/uploads')>()
  return {
    ...actual,
    uploadFile: vi.fn(async (_pid: string | null, file: File) => ({ path: `/abs/${file.name}`, filename: file.name })),
  }
})

// A WebSocket that opens on the next tick (so the connect effect has assigned
// onopen first) and otherwise no-ops, enough to flip the composer to connected.
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }
  send() {}
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  addEventListener() {}
  removeEventListener() {}
}

// The same socket, but reachable from the test so it can push chat frames in.
const sockets: RecordingWebSocket[] = []
class RecordingWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url)
    sockets.push(this)
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
}

// A pasted PNG named "image.png" (a generic name, so the composer renames it
// image1.png). extractFiles reads DataTransfer.items first, so provide those.
function imagePasteEvent() {
  const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
  return {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      files: [file],
      types: ['Files'],
      getData: () => '',
    },
  }
}

// A fresh agent id per render: the composer's draft attachments live in an
// in-memory cache keyed by agent, which would otherwise leak chips (and the
// image-number counter) from one test into the next.
let agentSeq = 0
function renderChat() {
  return render(
    <ChatPane
      agentId={`agent-${++agentSeq}`}
      projectId="proj"
      active
      reconnectAttempt={0}
      onStatusUpdate={vi.fn()}
      onDiffRefresh={vi.fn()}
      onSelectCommit={vi.fn()}
    />,
  )
}

async function connectedComposer(): Promise<HTMLTextAreaElement> {
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  await waitFor(() => expect(ta).not.toBeDisabled())
  return ta
}

describe('ChatPane composer undo (Ctrl+Z) for pasted images', () => {
  beforeAll(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    URL.createObjectURL = vi.fn(() => 'blob:mock')
    URL.revokeObjectURL = vi.fn()
  })
  afterAll(() => vi.unstubAllGlobals())
  afterEach(() => localStorage.clear())

  it('undoes a pasted image: first Ctrl+Z drops the marker, second drops the chip', async () => {
    renderChat()
    const ta = await connectedComposer()

    fireEvent.paste(ta, imagePasteEvent())

    // The paste both inserts a "[image1.png]" marker and stages an image chip.
    await screen.findByLabelText('Remove image1.png')
    expect(ta.value).toBe('[image1.png] ')

    // First Ctrl+Z: the marker is gone but the chip remains (two distinct steps).
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    expect(ta.value).toBe('')
    expect(screen.getByLabelText('Remove image1.png')).toBeInTheDocument()

    // Second Ctrl+Z: the chip is gone too - back to an empty composer.
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    expect(ta.value).toBe('')
    expect(screen.queryByLabelText('Remove image1.png')).toBeNull()
  })

  it('redo (Ctrl+Shift+Z) replays an undone paste', async () => {
    renderChat()
    const ta = await connectedComposer()

    fireEvent.paste(ta, imagePasteEvent())
    await screen.findByLabelText('Remove image1.png')

    // Undo the whole paste (marker, then chip).
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    expect(screen.queryByLabelText('Remove image1.png')).toBeNull()

    // Redo brings the chip back, then the marker.
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(screen.getByLabelText('Remove image1.png')).toBeInTheDocument()
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(ta.value).toBe('[image1.png] ')
  })

  it('keeps typed text when a later pasted image is undone', async () => {
    renderChat()
    const ta = await connectedComposer()

    // Type into the composer (a coalesced undo step), then paste an image.
    fireEvent.change(ta, { target: { value: 'look at this ' } })
    expect(ta.value).toBe('look at this ')

    // Paste with the caret at the end (jsdom doesn't move it on a controlled
    // re-render), so the marker lands after the typed text.
    ta.selectionStart = ta.selectionEnd = ta.value.length
    fireEvent.paste(ta, imagePasteEvent())
    await screen.findByLabelText('Remove image1.png')
    expect(ta.value).toBe('look at this [image1.png] ')

    // Undo marker, then chip - the typed text survives.
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    expect(ta.value).toBe('look at this ')
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true })
    expect(ta.value).toBe('look at this ')
    expect(screen.queryByLabelText('Remove image1.png')).toBeNull()
  })
})

// A streamed reply and the settled message it becomes have to be the SAME row.
// They used to be two: the in-flight block rendered below the transcript, the
// finished one as a new item inside it - so the swap tore the live node out of
// the document. Anything selected inside it was dropped by the browser on the
// spot, which is why selecting a reply while it streamed cleared itself a beat
// later. The live block now carries the id its settled event lands on.
describe('a streamed reply settles into the same DOM node', () => {
  beforeAll(() => {
    vi.stubGlobal('WebSocket', RecordingWebSocket)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterAll(() => vi.unstubAllGlobals())
  afterEach(() => {
    sockets.length = 0
    localStorage.clear()
  })

  const TEXT = 'The loader merges the per-environment file over the base.'
  // One stream_event frame, flushed so the assertions see the render it caused.
  const stream = (ws: RecordingWebSocket, event: unknown) =>
    act(() => ws.emit({ type: 'claude_event', event: { type: 'stream_event', event } }))

  it('keeps the live paragraph node when the completed message arrives', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    // Everything before replay_done is treated as backfilled history; the live
    // stream path only runs after it.
    act(() => ws.emit({ type: 'replay_done' }))

    stream(ws, { type: 'content_block_start', content_block: { type: 'text' } })
    stream(ws, { type: 'content_block_delta', delta: { type: 'text_delta', text: TEXT } })

    // The paced reveal walks the text in over a few frames.
    const live = await waitFor(() => {
      const p = document.querySelector('[data-md-root] p')
      expect(p?.textContent).toBe(TEXT)
      return p as HTMLElement
    })

    // message_stop lands as its own frame, ahead of the settled message: the
    // rendered block has to survive that gap too, or the text blinks out.
    stream(ws, { type: 'message_stop' })
    expect(document.contains(live)).toBe(true)
    expect(document.querySelector('[data-md-root] p')?.textContent).toBe(TEXT)

    // The settled message. Asserted straight after the render it causes, with
    // nothing else awaited in between, so this is the swap itself and not some
    // later re-render putting an equivalent node back.
    act(() => {
      ws.emit({
        type: 'claude_event',
        event: { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: TEXT }] } },
      })
    })
    expect(document.querySelectorAll('[data-md-root]')).toHaveLength(1)
    expect(document.contains(live)).toBe(true)
    expect(document.querySelector('[data-md-root] p')).toBe(live)
  })
})

// History pages arrive NEWEST first, so a tool call whose tool_use and
// tool_result straddle a page boundary is reduced result-first: the batch
// carrying the answer is reduced pages before the batch that builds the card.
// The result used to be dropped on the floor there - scrolling back to an
// answered AskUserQuestion showed a blank, interactive card with no record of
// the selection. A shared ToolResultLink carries it forward.
describe('reduceHistoryEvents across page boundaries', () => {
  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which offset?',
        header: 'Agent box',
        multiSelect: false,
        options: [{ label: 'Floating cards' }, { label: 'The composer' }],
      },
    ],
  }
  const ANSWER = 'Your questions have been answered: "Which offset?"="Floating cards".'

  // A decrementing allocator, like the real older-history one.
  const alloc = () => {
    let id = -1
    return () => id--
  }

  it('applies a tool_result reduced in a newer page to a card built by an older page', () => {
    const link = newToolResultLink()
    // Newer page: only the result.
    const newer = reduceHistoryEvents(
      [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }],
      alloc(), undefined, undefined, link,
    )
    expect(newer).toHaveLength(0)
    // Older page: the tool_use that owns it.
    const older = reduceHistoryEvents(
      [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }],
      alloc(), undefined, undefined, link,
    )
    const tool = older.find((it) => it.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', toolUseId: 'toolu_1', result: 'ok' })
  })

  it('settles a question card whose answer was in the newer page', () => {
    const link = newToolResultLink()
    reduceHistoryEvents(
      [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: ANSWER }] } }],
      alloc(), undefined, undefined, link,
    )
    const older = reduceHistoryEvents(
      [{ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: QUESTION_INPUT }] } }],
      alloc(), undefined, undefined, link,
    )
    const question = older.find((it) => it.kind === 'question')
    expect(question).toMatchObject({ kind: 'question', toolUseId: 'toolu_q', result: ANSWER })
  })

  it('still pairs a tool_use and tool_result inside one page', () => {
    const link = newToolResultLink()
    const items = reduceHistoryEvents(
      [
        { type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'done' }] } },
      ],
      alloc(), undefined, undefined, link,
    )
    expect(items.find((it) => it.kind === 'tool')).toMatchObject({ result: 'done' })
    expect(link.orphans.size).toBe(0)
  })

})

// A ToolSearch card's header used to show the raw query, i.e. the wire tool name
// with its mcp__/__ plumbing ("select:mcp__hydra__git_commit").
describe('summarizeToolSearchQuery', () => {
  it('renders a select: lookup as the bare tool names, MCP ones namespaced', () => {
    expect(summarizeToolSearchQuery('select:mcp__hydra__git_commit')).toEqual({ text: 'hydra::git_commit', prose: false })
    expect(summarizeToolSearchQuery('select:Read, mcp__hydra__git_add')).toEqual({ text: 'Read, hydra::git_add', prose: false })
  })

  it('leaves a keyword search alone', () => {
    expect(summarizeToolSearchQuery('notebook jupyter')).toEqual({ text: 'notebook jupyter', prose: true })
    expect(summarizeToolSearchQuery('+slack send')).toEqual({ text: '+slack send', prose: true })
  })

  it('falls back to the raw query when select: names nothing', () => {
    expect(summarizeToolSearchQuery('select:')).toEqual({ text: 'select:', prose: false })
  })
})

// A ToolSearch result is `tool_reference` blocks carrying only the loaded tool's
// name - no text - so the card rendered the whole schema load as "(no output)".
describe('ToolSearch tool_reference results', () => {
  const alloc = () => {
    let id = 0
    return () => ++id
  }
  const search = (result: unknown[]) =>
    reduceHistoryEvents(
      [
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_ts', name: 'ToolSearch', input: { query: 'select:mcp__hydra__git_commit' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ts', content: result }] } },
      ],
      alloc(),
    ).find((it) => it.kind === 'tool')

  it('names the single tool it loaded', () => {
    expect(search([{ type: 'tool_reference', tool_name: 'mcp__hydra__git_commit' }])).toMatchObject({ result: 'Loaded hydra::git_commit' })
  })

  it('counts and lists several', () => {
    const item = search([
      { type: 'tool_reference', tool_name: 'mcp__hydra__git_add' },
      { type: 'tool_reference', tool_name: 'Read' },
    ])
    expect(item).toMatchObject({ result: 'Loaded 2 tools: hydra::git_add, Read' })
  })

  it('keeps the provider blocks for the Raw panel', () => {
    const item = search([{ type: 'tool_reference', tool_name: 'mcp__hydra__git_commit' }])
    const raw = JSON.parse(toolRawJson(item!.input, item!.rawUse, item!.rawResult, item!.result))
    expect(raw.tool_use.message.content[0]).toMatchObject({ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:mcp__hydra__git_commit' } })
    expect(raw.tool_result.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_ts', content: [{ type: 'tool_reference', tool_name: 'mcp__hydra__git_commit' }] })
    // The flattened text is the card's summary, not something the wire carried.
    expect(raw.result).toBeUndefined()
  })

  it('keeps any text the result does carry', () => {
    const item = search([
      { type: 'text', text: 'No exact match; closest below.' },
      { type: 'tool_reference', tool_name: 'Read' },
    ])
    expect(item).toMatchObject({ result: 'Loaded Read\nNo exact match; closest below.' })
  })
})

// The Raw panel used to rebuild {input, result} from what the card kept, so it
// showed the FLATTENED result and no envelope. It now prints each block inside
// the ENTRY the CLI recorded it in - so everything written around the block
// (uuid, timestamp, cwd, sidechain markers) is visible, rather than only the
// fields something thought to copy up. An image's base64 is the one exception,
// since the card already renders it and it is megabytes of noise here.
describe('toolRawJson', () => {
  const alloc = () => {
    let id = 0
    return () => ++id
  }
  const reduce = (name: string, input: unknown, content: unknown) =>
    reduceHistoryEvents(
      [
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu', name, input }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content }] } },
      ],
      alloc(),
    ).find((it) => it.kind === 'tool')!
  const raw = (it: { input: unknown; rawUse?: unknown; rawResult?: unknown; result?: string }) =>
    JSON.parse(toolRawJson(it.input, it.rawUse, it.rawResult, it.result))

  it('swaps an image payload for its size, keeping the block shape', () => {
    const data = 'A'.repeat(4000)
    const item = reduce('Read', { file_path: 'shot.png' }, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }])
    const image = raw(item).tool_result.message.content[0].content[0]
    expect(image.source.media_type).toBe('image/png')
    expect(image.source.data).toBe('<2.9 KB base64, rendered above>')
    expect(item.resultImages?.[0]).toContain(data)
  })

  it('shows a running call as its tool_use plus the output so far', () => {
    const json = raw({ input: { command: 'ls' }, rawUse: { type: 'tool_use', name: 'Bash' }, result: 'partial' })
    expect(json).toEqual({ tool_use: { type: 'tool_use', name: 'Bash' }, result: 'partial' })
  })

  it('prefers Codex\'s own item, which is its true wire payload', () => {
    const codexItem = { id: 'item_1', item_type: 'command_execution', command: 'ls', status: 'completed' }
    const json = raw({ input: { command: 'ls', cwd: '/repo', _raw: codexItem }, rawUse: { type: 'tool_use' }, result: 'out' })
    expect(json).toEqual({ ...codexItem, result: 'out' })
    expect(json.tool_use).toBeUndefined()
  })

  it('keeps the aggregated Codex event list when there is one', () => {
    const events = [{ id: 'item_1', status: 'in_progress' }, { id: 'item_1', status: 'completed' }]
    expect(raw({ input: { command: 'ls', _raw_events: events }, result: 'out' })).toEqual({ events })
  })

  // Codex tool payloads are recognised by their status/output/item fields. The
  // blocks the chat builds from one are Hydra's shape, not Codex's, so they must
  // not reach Raw - Codex's own item (`_raw`) is the truthful payload there.
  const codexPair = (payloadIn: Record<string, unknown>, payloadOut: Record<string, unknown>) =>
    reduceHistoryEvents(
      [
        ...normalizedToProviderEvents({ seq: 1, type: 'tool_started', timestamp: '', payload: payloadIn }),
        ...normalizedToProviderEvents({ seq: 2, type: 'tool_completed', timestamp: '', payload: payloadOut }),
      ],
      alloc(),
    ).find((it) => it.kind === 'tool')!

  it('shows Codex its own item, not an Anthropic block it never sent', () => {
    const native = { id: 'c1', item_type: 'command_execution', command: 'ls', status: 'completed' }
    const item = codexPair(
      { id: 'c1', name: 'Bash', status: 'in_progress', input: { command: 'ls', cwd: '.', _raw: native } },
      { id: 'c1', name: 'Bash', output: 'out', status: 'completed' },
    )
    expect(item.rawUse).toBeUndefined()
    expect(item.rawResult).toBeUndefined()
    expect(raw(item)).toEqual({ ...native, result: 'out' })
  })

  it('keeps Claude blocks, marker and all stripped', () => {
    const item = codexPair(
      { id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      { id: 't1', content: [{ type: 'text', text: 'contents' }] },
    )
    const json = raw(item)
    expect(json.tool_use).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } })
    expect(json.tool_result.content).toEqual([{ type: 'text', text: 'contents' }])
    expect(JSON.stringify(json)).not.toContain('synthetic')
  })

  // The backend relays the entry the CLI recorded (minus its content, which the
  // payload carries) - so Raw shows what was written around the block, `cwd` and
  // all, without anyone having listed which fields to lift out.
  it('shows the recorded entry around a normalized block', () => {
    const item = codexPair(
      { id: 't2', name: 'Bash', input: { command: 'bun test' }, entry: { type: 'assistant', uuid: 'u1', cwd: '/repo/wt/web', message: { id: 'm1' } } },
      { id: 't2', content: 'ok', entry: { type: 'user', uuid: 'u2', cwd: '/repo/wt/web' } },
    )
    const json = raw(item)
    expect(json.tool_use).toMatchObject({ type: 'assistant', uuid: 'u1', cwd: '/repo/wt/web' })
    expect(json.tool_use.message).toMatchObject({ id: 'm1', content: [{ type: 'tool_use', id: 't2', name: 'Bash' }] })
    expect(json.tool_result).toMatchObject({ type: 'user', cwd: '/repo/wt/web' })
    expect(json.tool_result.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't2' })
  })

  it('falls back to input/result for a card Hydra synthesized', () => {
    expect(raw({ input: { description: '2 tasks' }, result: 'Plan updated' })).toEqual({ input: { description: '2 tasks' }, result: 'Plan updated' })
  })
})
