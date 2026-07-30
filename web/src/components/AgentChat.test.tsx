import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatPane, compareCommitChips, toProviderEvents, planStepRows, reduceHistoryEvents, stepSummary, summarizeToolSearchQuery, toolRawJson } from './AgentChat'
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
// (`agentId` is overridable for the one test that has to render the SAME head
// twice - a pane's own state must not survive it going away.)
let agentSeq = 0
function renderChat(agentId = `agent-${++agentSeq}`) {
  return render(
    <ChatPane
      agentId={agentId}
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
    expect(ta.value).toBe('[image1.png]')

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
    expect(ta.value).toBe('[image1.png]')
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
    expect(ta.value).toBe('look at this [image1.png]')

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
  // One chat event, flushed so the assertions see the render it
  // caused. Seq is the client's dedup key, so every frame needs its own.
  let seq = 0
  const emit = (ws: RecordingWebSocket, type: string, payload: unknown) =>
    act(() => ws.emit({ type: 'chat_event', event: { seq: ++seq, type, timestamp: '', payload } }))

  it('keeps the live paragraph node when the completed message arrives', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    // Everything before replay_done is treated as backfilled history; the live
    // stream path only runs after it.
    act(() => ws.emit({ type: 'replay_done' }))

    emit(ws, 'assistant_delta', { message_id: 'msg_1', text: TEXT })

    // The paced reveal walks the text in over a few frames.
    const live = await waitFor(() => {
      const p = document.querySelector('[data-md-root] p')
      expect(p?.textContent).toBe(TEXT)
      return p as HTMLElement
    })

    // The settled message. Asserted straight after the render it causes, with
    // nothing else awaited in between, so this is the swap itself and not some
    // later re-render putting an equivalent node back. The client closes the
    // stream in the same batch, so the rendered block never blinks out.
    emit(ws, 'assistant_message', { message_id: 'msg_1', text: TEXT })
    expect(document.querySelectorAll('[data-md-root]')).toHaveLength(1)
    expect(document.contains(live)).toBe(true)
    expect(document.querySelector('[data-md-root] p')).toBe(live)
  })
})

// A tool card you expanded must stay expanded when the NEXT tool call lands.
// The second call is what earns the run a "N steps" group (planStepRows), and
// the group is a new parent - React reconciles a row that changes parent as
// unmount + mount, not as a move - so a fold state living only in the card's
// useState was thrown away and the card you were reading closed itself
// mid-turn.
describe('an expanded tool card survives its run becoming a step group', () => {
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

  // A settled tool call: the card, then its answer.
  let seq = 0
  const call = (ws: RecordingWebSocket, id: string, name: string) =>
    act(() => {
      const emit = (type: string, payload: unknown) =>
        ws.emit({ type: 'chat_event', event: { seq: ++seq, type, timestamp: '', payload } })
      emit('tool_started', { id, name, input: { file_path: '/w/a.txt' } })
      emit('tool_completed', { id, content: 'ok' })
    })

  // Only a ToolCard header carries an explicit role="button" AND aria-expanded;
  // the group's own header is a real <button>, so it can't be confused for one.
  const cardHeader = (name: string) =>
    [...document.querySelectorAll('[role="button"][aria-expanded]')].find((el) =>
      el.textContent?.includes(name),
    ) as HTMLElement | undefined

  it('keeps the card open when a second call folds the run into a group', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))

    call(ws, 'toolu_grp_1', 'Read')
    const read = cardHeader('Read')
    expect(read).toBeDefined()
    expect(read).toHaveAttribute('aria-expanded', 'false')

    act(() => read!.click())
    expect(cardHeader('Read')).toHaveAttribute('aria-expanded', 'true')

    // The second call: the run now earns a group, and the Read card moves inside
    // it. It must come back open, not folded.
    call(ws, 'toolu_grp_2', 'Grep')
    expect(cardHeader('Read')).toHaveAttribute('aria-expanded', 'true')
    // The card the reader never touched is unaffected - the fix restores a
    // choice, it doesn't open everything.
    expect(cardHeader('Grep')).toHaveAttribute('aria-expanded', 'false')
    // The group's own header grows in a frame later (GrowIn), so it settles
    // after the cards it now owns - proof the run really did fold.
    await screen.findByText('2 steps')
    expect(cardHeader('Read')).toHaveAttribute('aria-expanded', 'true')
  })

  // The other half of the rule: the memory belongs to the VISIT. What you
  // unfolded chasing one thing is not what you want waiting for you when you
  // come back, so the pane owns the map and it dies with the pane.
  it('forgets the card again once the pane goes away', async () => {
    const { unmount } = renderChat('agent-refold')
    await connectedComposer()
    act(() => sockets[0].emit({ type: 'replay_done' }))
    call(sockets[0], 'toolu_refold', 'Read')
    act(() => cardHeader('Read')!.click())
    expect(cardHeader('Read')).toHaveAttribute('aria-expanded', 'true')

    unmount()
    renderChat('agent-refold')
    await connectedComposer()
    act(() => sockets[1].emit({ type: 'replay_done' }))
    call(sockets[1], 'toolu_refold', 'Read')
    expect(cardHeader('Read')).toHaveAttribute('aria-expanded', 'false')
  })
})

// History pages arrive NEWEST first, so a tool call whose tool_use and
// tool_result straddle a page boundary is reduced result-first: the batch
// carrying the answer is reduced pages before the batch that builds the card.
// The result used to be dropped on the floor there - scrolling back to an
// answered AskUserQuestion showed a blank, interactive card with no record of
// the selection. A shared ToolResultLink carries it forward.
// The Bash tool runs ONE shell per session, so a bare `bun test` is only
// legible with the directory it ran in above it. The daemon reads that off the
// CLI's transcript (internal/chat/shellcwd.go) and sends it as a shell_cwd
// event; end to end, that has to reach the NEXT command's card.
describe('a shell_cwd read by the daemon captions the command after it', () => {
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

  it('shows the directory the previous command left the shell in', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))

    let seq = 0
    const emit = (type: string, payload: unknown) =>
      act(() => ws.emit({ type: 'chat_event', event: { seq: ++seq, type, timestamp: '', payload } }))

    emit('tool_started', { id: 'toolu_a', name: 'Bash', input: { command: 'cd web && ls' } })
    emit('tool_completed', { id: 'toolu_a', content: 'dist  src' })
    emit('shell_cwd', { tool_use_id: 'toolu_a', cwd: '/wt/web' })
    emit('tool_started', { id: 'toolu_b', name: 'Bash', input: { command: 'bun test' } })
    emit('tool_completed', { id: 'toolu_b', content: '12 pass' })

    const header = [...document.querySelectorAll('[role="button"][aria-expanded]')].find((el) =>
      el.textContent?.includes('bun test'),
    ) as HTMLElement | undefined
    expect(header).toBeDefined()
    act(() => header!.click())
    await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'))
    // The card's own script, with the tracked directory prepended: without it
    // the command reads as if it ran where the session started.
    const card = header!.closest('div')
    expect(card?.textContent).toContain('cd /wt/web')
  })
})

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

  // The daemon reads where a Bash command left the shell off the CLI's own
  // transcript (internal/chat/shellcwd.go) and appends it as its own event a
  // moment after the result - so it straddles a page boundary just as a result
  // does, and it is what anchors every command after it.
  it('applies a shell_cwd reduced in a newer page to a card built by an older page', () => {
    const link = newToolResultLink()
    const newer = reduceHistoryEvents(
      toProviderEvents({ type: 'shell_cwd', seq: 9, timestamp: '', payload: { tool_use_id: 'toolu_3', cwd: '/wt/web' } } as never),
      alloc(), undefined, undefined, link,
    )
    expect(newer).toHaveLength(0)
    const older = reduceHistoryEvents(
      [{ type: 'assistant', message: { id: 'm4', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'cd web && ls' } }] } }],
      alloc(), undefined, undefined, link,
    )
    expect(older.find((it) => it.kind === 'tool')).toMatchObject({ toolUseId: 'toolu_3', cwdAfter: '/wt/web' })
  })

  it('applies a shell_cwd to a card built in the same page', () => {
    const items = reduceHistoryEvents(
      [
        { type: 'assistant', message: { id: 'm5', content: [{ type: 'tool_use', id: 'toolu_4', name: 'Bash', input: { command: 'cd web && ls' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: 'ok' }] } },
        ...toProviderEvents({ type: 'shell_cwd', seq: 3, timestamp: '', payload: { tool_use_id: 'toolu_4', cwd: '/wt/web' } } as never),
      ],
      alloc(),
    )
    expect(items.find((it) => it.kind === 'tool')).toMatchObject({ toolUseId: 'toolu_4', result: 'ok', cwdAfter: '/wt/web' })
  })

})

// The CLI logs an isMeta record every time it downscales an image before sending
// it. It never reaches stdout, so it arrives only via the transcript backfill -
// which appends onto an already-filled event log, landing a mid-turn note at the
// very END of the conversation, as an "Injected context" card hanging off a
// finished answer. The daemon drops it now, but existing event logs still hold
// it, so the reducer has to drop it too.
describe('the image-downscale notice is not injected context', () => {
  const meta = (text: string) => [{ type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } }]
  const alloc = () => {
    let id = -1
    return () => id--
  }

  it('drops the notice in both the shapes the CLI writes it', () => {
    expect(reduceHistoryEvents(meta('[Image: original 2088x160, displayed at 2000x153. Multiply coordinates by 1.04 to map to original image.]'), alloc())).toHaveLength(0)
    expect(reduceHistoryEvents(
      [{ type: 'user', isMeta: true, message: { content: '[Image: original 1384x3128, displayed at 885x2000. Multiply coordinates by 1.56 to map to original image.]' } }],
      alloc(),
    )).toHaveLength(0)
  })

  it('keeps injected context that is not the notice', () => {
    expect(reduceHistoryEvents(meta('some other injected context'), alloc())).toMatchObject([{ kind: 'meta' }])
    // Only the CLI's bookkeeping shape goes; a bracketed image mention stays.
    expect(reduceHistoryEvents(meta('[Image: /tmp/shot.png]'), alloc())).toMatchObject([{ kind: 'meta' }])
  })

  it('keeps a real user turn that quotes the notice', () => {
    const items = reduceHistoryEvents(
      [{ type: 'user', message: { content: [{ type: 'text', text: '[Image: original 2088x160, displayed at 2000x153. Multiply coordinates by 1.04 to map to original image.]' }] } }],
      alloc(),
    )
    expect(items).toMatchObject([{ kind: 'user' }])
  })
})

// Commit chips arrive in whatever order their pages do: the live window first,
// then progressively OLDER pages as you scroll up. mergedItems interleaves them
// against the transcript in a single ordered pass, so an unsorted list dropped
// every older chip in a clump at the load boundary instead of at its own place.
describe('compareCommitChips', () => {
  const chip = (ts: number, seq?: number) =>
    ({ kind: 'commit', id: ts, sha: `${ts}`, shortSha: `${ts}`, subject: `${ts}`, ts, seq }) as const

  it('orders oldest first however the pages arrived', () => {
    const pages = [chip(300), chip(100), chip(250), chip(150)]
    expect([...pages].sort(compareCommitChips).map((c) => c.ts)).toEqual([100, 150, 250, 300])
  })

  it('breaks a same-timestamp tie on the log sequence', () => {
    // A merge and the commit that triggered it can share a second.
    const same = [chip(100, 9), chip(100, 4)]
    expect([...same].sort(compareCommitChips).map((c) => c.seq)).toEqual([4, 9])
  })
})

// A ToolSearch card's header used to show the raw query, i.e. the wire tool name
// with its mcp__/__ plumbing ("select:mcp__hydra__git_commit").
// `prose` means "not monospace", and tracks whether the text was rewritten for a
// human: a select: list is rendered as labels nobody typed, so it reads as prose,
// while any query we pass through untouched stays verbatim in mono.
describe('summarizeToolSearchQuery', () => {
  it('renders a select: lookup as the bare tool names, MCP ones namespaced', () => {
    expect(summarizeToolSearchQuery('select:mcp__hydra__git_commit')).toEqual({ text: 'hydra::git_commit', prose: true })
    expect(summarizeToolSearchQuery('select:Read, mcp__hydra__git_add')).toEqual({ text: 'Read, hydra::git_add', prose: true })
  })

  it('leaves a keyword search alone, verbatim and mono', () => {
    expect(summarizeToolSearchQuery('notebook jupyter')).toEqual({ text: 'notebook jupyter', prose: false })
    expect(summarizeToolSearchQuery('+slack send')).toEqual({ text: '+slack send', prose: false })
  })

  // Nothing was rewritten here, so it reads as the query it is - mono, like any
  // other query shown as sent.
  it('falls back to the raw query, in mono, when select: names nothing', () => {
    expect(summarizeToolSearchQuery('select:')).toEqual({ text: 'select:', prose: false })
    expect(summarizeToolSearchQuery('select: , ,')).toEqual({ text: 'select: , ,', prose: false })
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
        ...toProviderEvents({ seq: 1, type: 'tool_started', timestamp: '', payload: payloadIn }),
        ...toProviderEvents({ seq: 2, type: 'tool_completed', timestamp: '', payload: payloadOut }),
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
  it('shows the recorded entry around a rebuilt block', () => {
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

// ── Step folding ────────────────────────────────────────────────────────────
// A run of settled thoughts + tool calls collapses into one "N steps" line
// (planStepRows), which is what keeps a long transcript from reading as a wall.
// What must NEVER fold is anything the reader still has to act on or watch.
describe('planStepRows', () => {
  type Item = Parameters<typeof planStepRows>[0][number]
  let nextId = 0
  const tool = (name: string, extra: Record<string, unknown> = {}) =>
    ({ kind: 'tool', id: ++nextId, toolUseId: `t${nextId}`, name, input: {}, result: 'ok', ...extra }) as Item
  const thought = (durationMs?: number) => ({ kind: 'thinking', id: ++nextId, text: 'hmm', durationMs }) as Item
  const said = (text: string) => ({ kind: 'assistant', id: ++nextId, text }) as Item
  const plan = (items: Item[]) => planStepRows(items, {}, true)
  const kinds = (rows: ReturnType<typeof plan>) =>
    rows.map((r) => (r.row === 'group' ? `group:${r.items.length}` : r.item.kind))

  it('folds a run of settled steps and leaves prose alone', () => {
    const rows = plan([said('doing it'), thought(), tool('Read'), tool('Edit'), tool('Bash'), said('done')])
    expect(kinds(rows)).toEqual(['assistant', 'group:4', 'assistant'])
  })

  it('leaves a lone tool call (and the thought behind it) unfolded', () => {
    expect(kinds(plan([thought(), tool('Read'), said('found it')]))).toEqual(['thinking', 'tool', 'assistant'])
  })

  // The running step folds in with the rest: leaving it outside meant every step
  // grew a card and took it away again a second later, so a live turn pulsed.
  // The header names it instead (stepSummary().running).
  it('folds the running step in and names it on the group', () => {
    const rows = plan([tool('Read'), tool('Grep'), tool('Bash', { result: undefined })])
    expect(kinds(rows)).toEqual(['group:3'])
    const group = rows[0]
    expect(group.row === 'group' && stepSummary(group.items).running).toBe('Bash')
  })

  it('reports no running step once every call has landed', () => {
    expect(stepSummary([tool('Read'), tool('Bash', { ended: true, result: undefined })]).running).toBe('')
  })

  // A plan put up for approval and a command headed for the host are addressed
  // to the reader, not to the machine.
  it('never folds a plan or a host run', () => {
    const rows = plan([tool('Read'), tool('ExitPlanMode'), tool('Grep'), tool('mcp__hydra__host_run'), tool('Read')])
    expect(kinds(rows)).toEqual(['tool', 'tool', 'tool', 'tool', 'tool'])
  })

  it('leaves a Task card that became a sub-agent card standing on its own', () => {
    const task = tool('Task')
    const rows = planStepRows(
      [tool('Read'), task, tool('Bash'), tool('Read')],
      { [task.kind === 'tool' ? task.toolUseId : '']: { agentId: 'sub-1', status: 'done', items: [] } },
      true,
    )
    expect(kinds(rows)).toEqual(['tool', 'tool', 'group:2'])
  })

  // A red card that scrolled past is how you notice the agent hit a wall, so the
  // fold counts the failures rather than hiding them.
  it('counts failed steps in the summary', () => {
    expect(stepSummary([tool('Bash', { isError: true }), tool('Bash'), tool('Read')]).failed).toBe(1)
  })

  it('folds nothing when the preference is off', () => {
    expect(kinds(planStepRows([tool('Read'), tool('Edit'), tool('Bash')], {}, false))).toEqual(['tool', 'tool', 'tool'])
  })

  // The whole list, most-used first: the header clips it with a CSS ellipsis
  // rather than spending its last characters on "+N more".
  it('summarizes a run by its tools, most-used first', () => {
    const s = stepSummary([tool('Read'), tool('Read'), tool('Bash'), tool('Edit'), tool('Write'), thought(4000), thought(2000)])
    expect(s.label).toBe('5 steps')
    expect(s.tools).toBe('Read x2 · Bash · Edit · Write')
    expect(s.thinkingMs).toBe(6000)
    expect(s.failed).toBe(0)
  })
})
