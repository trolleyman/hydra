import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatPane, compareCommitChips, fileChangeCounts, fileChangeRows, mergeChipLabel, toProviderEvents, planStepRows, reduceHistoryEvents, scriptOutputRows, ScriptOutputPanel, sharedScriptGutterDigits, stepSummary, summarizeToolSearchQuery, toolRawJson, visibleToolInput } from './AgentChat'
import { chatRepositoryRef } from '../lib/chatRepositoryRef'
import { newToolResultLink } from '../lib/toolResultLink'
import { AgentStatus, type AgentResponse } from '../api'
import { useAgentStore } from '../stores/agentStore'
import { formatBashForDisplay, leadingBashComment } from '../lib/bashFormat'
import { toolResultName, trimWorktreePaths } from '../lib/chatPathDisplay'
import { useEnterSendsStore } from '../lib/composerPrefs'

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
  sent: string[] = []
  constructor(url: string) {
    super(url)
    sockets.push(this)
  }
  override send(data: string) {
    this.sent.push(data)
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

function webkitFileDropEvent() {
  const image = new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' })
  const notes = new File(['details'], 'notes.txt', { type: 'text/plain' })
  return {
    dataTransfer: {
      items: [image, notes].map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      files: [],
      types: ['text/uri-list'],
      getData: () => 'file:///home/callum/diagram.png',
      dropEffect: 'none',
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

describe('review checkout path display', () => {
  const reviewRoot = '/home/callum/.local/state/hydra/projects/hydra/review-checkouts/add-review-comments'

  it('renders files relative to the detached review checkout', () => {
    expect(trimWorktreePaths(`${reviewRoot}/web/src/AgentChat.tsx`, '/some/head/worktree'))
      .toBe('web/src/AgentChat.tsx')
  })

  it('turns the detached checkout itself into the display root', () => {
    const trimmed = trimWorktreePaths(`cd '${reviewRoot}'\nsed -n '1,20p' web/x.ts`, '/some/head/worktree')
    expect(formatBashForDisplay(trimmed)).toBe("sed -n '1,20p' web/x.ts")
  })

  it('also trims review checkouts from transcripts using the project-local state layout', () => {
    const oldReviewRoot = '/home/callum/code/hydra/.hydra/local/review-checkouts/add-review-comments'
    expect(trimWorktreePaths(`${oldReviewRoot}/web/src/AgentChat.tsx`, '/some/head/worktree'))
      .toBe('web/src/AgentChat.tsx')
  })

  it('names Claude tool-result spill files without its transcript cache path', () => {
    expect(toolResultName('/home/callum/.claude/projects/-long-slug/session/tool-results/bij43gmi4.txt'))
      .toBe('bij43gmi4.txt')
  })
})

describe('chat repository links', () => {
  it('uses the owned branch for a worktree head', () => {
    expect(chatRepositoryRef('hydra/feature')).toBe('hydra/feature')
  })

  it('uses the project checkout for a project-directory Head', () => {
    expect(chatRepositoryRef(null)).toBe('HEAD')
  })
})

describe('Bash card summary comments', () => {
  it('uses Codex\'s leading shell comment as the concise summary', () => {
    expect(leadingBashComment('# Verify the workspace-kind invariant and roadmap update\nrg -n "Branch == nil" docs/roadmap.md'))
      .toBe('Verify the workspace-kind invariant and roadmap update')
  })

  it('does not promote shebangs or later script comments', () => {
    expect(leadingBashComment('#!/usr/bin/env bash\necho ok')).toBe('')
    expect(leadingBashComment('echo ok\n# Explain the next command')).toBe('')
  })

  it('handles Codex wrappers whose closing quote was consumed by shell expansion', () => {
    const command = `/usr/bin/bash -lc "# Verify the merge\ngit status --short\nprintf '%s\\n' \\"'$?'`
    expect(leadingBashComment(command)).toBe('Verify the merge')
  })
})

describe('Codex file-change previews', () => {
  it('keeps real hunk offsets and computes changed-word ranges', () => {
    const rows = fileChangeRows('@@ -585,2 +585,2 @@\n-\tfor key := range caches {\n+\tfor _, key := range keys {\n unchanged', 'update')

    expect(rows.map((row) => [row.type, row.oldNum, row.newNum, row.content])).toEqual([
      ['del', 585, null, '\tfor key := range caches {'],
      ['add', null, 585, '\tfor _, key := range keys {'],
      ['context', 586, 586, 'unchanged'],
    ])
    expect(rows[0].ranges?.length).toBeGreaterThan(0)
    expect(rows[1].ranges?.length).toBeGreaterThan(0)
  })

  it('numbers complete added files on the new side', () => {
    expect(fileChangeRows('package config\n\nconst enabled = true\n', 'add').map((row) => [row.oldNum, row.newNum])).toEqual([
      [null, 1], [null, 2], [null, 3],
    ])
  })

  it('counts the additions and deletions rendered for each change kind', () => {
    expect(fileChangeCounts('@@ -8,2 +8,3 @@\n-old\n+new\n+extra\n context', 'update')).toEqual({ additions: 2, deletions: 1 })
    expect(fileChangeCounts('first\nsecond\n', 'add')).toEqual({ additions: 2, deletions: 0 })
    expect(fileChangeCounts('removed\n', 'delete')).toEqual({ additions: 0, deletions: 1 })
  })
})

describe('sectioned search output', () => {
  it('shares the widest gutter between a multiline command and numbered output', () => {
    const sections = [{
      kind: 'matches' as const,
      command: 'rg -n x a.cs',
      match: { paths: ['a.cs'], numbered: true },
      lines: ['9:first', '10:last'],
    }]
    const rows = scriptOutputRows(sections)

    expect(sharedScriptGutterDigits('rg -n x a.cs\nsed -n 1,3p a.cs', rows, true)).toBe(2)
    expect(sharedScriptGutterDigits('rg -n x a.cs\nsed -n 1,3p a.cs', scriptOutputRows([{ ...sections[0], lines: ['99:first', '100:last'] }]), true)).toBe(3)
    expect(sharedScriptGutterDigits('rg -n x a.cs\nsed -n 1,3p a.cs', rows, false)).toBeUndefined()
    expect(sharedScriptGutterDigits('rg -n x a.cs', rows, true)).toBeUndefined()
  })

  it('stretches tooltip-wrapped source numbers across the gutter track', () => {
    const rows = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n x a.cs',
      match: { paths: ['a.cs'], numbered: true },
      lines: ['9:first', '10:last'],
    }])
    const { container } = render(<ScriptOutputPanel rows={rows} />)

    expect(container.querySelector('[data-copy-code]')?.className).toContain('--app-font-code-step')

    const gutters = container.querySelectorAll('[data-copy-skip].min-h-4')
    expect(gutters).toHaveLength(2)
    for (const gutter of gutters) {
      expect(gutter).toHaveClass('w-full')
      expect(gutter.parentElement).toHaveClass('w-full')
    }
  })

  it('does not leak Markdown bold across omitted source lines', () => {
    const rows = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n project-directory docs/a.md',
      match: { paths: ['docs/a.md'], numbered: true },
      lines: ['3:**Status: shared project-directory session', '18:ordinary later match'],
    }])

    const code = rows.filter((row) => !row.header && !row.divider)
    expect(code).toHaveLength(2)
    expect(code[1].html).not.toContain('token bold')
  })

  it('keeps each source path with its line number in the gutter model', () => {
    const rows = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n reconcile internal/chat internal/heads',
      match: { paths: ['internal/chat', 'internal/heads'], numbered: true },
      lines: ['internal/chat/manager.go:560:func (w *worker) reconcileCommits() {'],
    }])

    expect(rows[0]).toMatchObject({ header: { kind: 'file', label: 'internal/chat/manager.go' } })
    expect(rows[1]).toMatchObject({ file: 'internal/chat/manager.go', num: '560' })
    expect(rows[1].html).toContain('token keyword')
  })

  it('groups search matches under exact file headings', () => {
    const rows = scriptOutputRows([{
      kind: 'matches',
      command: "rg -n 'abc|def' *.txt",
      match: { paths: [], numbered: true },
      lines: [
        'fileabc.txt:41:line 41 awad',
        'fileabc.txt:101:line 101 rawr',
        'a/b/filebcd.txt:1:line 1 awdaa',
      ],
    }])

    expect(rows.map((row) => row.header?.label ?? (row.divider ? 'divider' : row.num))).toEqual([
      'fileabc.txt', '41', 'divider', '101', 'a/b/filebcd.txt', '1',
    ])
  })

  it('renders typed headings between inset rules without changing case', () => {
    const rows = scriptOutputRows([
      { kind: 'section', section: { kind: 'text', label: 'lowercase diagnostics' }, lines: ['marker'] },
      { kind: 'section', section: { kind: 'file', label: 'a/b/file.txt' }, lines: ['marker'] },
      { kind: 'section', section: { kind: 'dir', label: 'web/src/' }, lines: ['marker'] },
    ])
    const { container } = render(<ScriptOutputPanel rows={rows} />)

    expect(screen.getByText('lowercase diagnostics')).toBeInTheDocument()
    expect(container.textContent).toContain('a/b/file.txt')
    expect(screen.getAllByText('web/src/')).not.toHaveLength(0)
    expect(container.querySelectorAll('.border-t')).toHaveLength(3)
    expect(container.querySelectorAll('.border-b')).toHaveLength(3)
    const headings = container.querySelectorAll('[data-copy-skip].sticky')
    expect(headings).toHaveLength(3)
    for (const heading of headings) {
      expect(heading).toHaveClass('top-0', 'z-10', 'bg-[#fdfcf9]', 'dark:bg-[#1d1c1a]')
      expect(heading.children[1]).toHaveClass('py-1')
    }
  })

  it('wraps every output heading kind like an ordinary output line', () => {
    const rows = scriptOutputRows([
      { kind: 'section', section: { kind: 'text', label: 'diagnostics-with-one-very-long-unbroken-label' }, lines: ['marker'] },
      { kind: 'section', section: { kind: 'file', label: 'deep/path/to/a-very-long-file-name.txt' }, lines: ['marker'] },
      { kind: 'section', section: { kind: 'dir', label: 'deep/path/to/a-very-long-directory-name/' }, lines: ['marker'] },
    ])
    const { container } = render(<ScriptOutputPanel rows={rows} />)

    const textLabel = screen.getByText('diagnostics-with-one-very-long-unbroken-label')
    const fileLabel = screen.getByText('a-very-long-file-name.txt').parentElement
    const directoryLabel = screen.getAllByText('deep/path/to/a-very-long-directory-name/')[0]

    expect(textLabel).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(fileLabel).toHaveClass('whitespace-normal', 'break-words')
    expect(fileLabel).not.toHaveClass('truncate')
    expect(directoryLabel).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(directoryLabel).not.toHaveClass('truncate')

    const headings = container.querySelectorAll('[data-copy-skip].sticky')
    expect(headings).toHaveLength(3)
    expect(headings[1].children[1].firstElementChild).toHaveClass('min-w-0', 'flex-1')
    expect(headings[2].children[1].firstElementChild).toHaveClass('min-w-0', 'flex-1')
  })

  it('highlights marked Markdown and Go sections by their file headings', () => {
    const rows = scriptOutputRows([
      { kind: 'section', section: { kind: 'file', label: 'docs/policy.md' }, lines: ['marker'] },
      {
        kind: 'view',
        view: { path: 'docs/policy.md', start: 1, end: null, numbered: false, command: 'git show HEAD:docs/policy.md' },
        lines: ['# Policy', 'Status: **implemented.**'],
      },
      { kind: 'section', section: { kind: 'file', label: 'internal/policy.go' }, lines: ['marker'] },
      {
        kind: 'view',
        view: { path: 'internal/policy.go', start: 1, end: null, numbered: false, command: 'git show HEAD:internal/policy.go' },
        lines: ['package policy'],
      },
    ])

    expect(rows.map((row) => row.header?.label ?? row.html)).toEqual([
      'docs/policy.md',
      expect.stringContaining('token title important'),
      expect.stringContaining('token bold'),
      'internal/policy.go',
      expect.stringContaining('token keyword'),
    ])
  })

  it('derives file headings from unified diff boundaries', () => {
    const rows = scriptOutputRows([{
      kind: 'git',
      command: 'git diff main',
      lines: [
        'diff --git a/internal/a.go b/internal/a.go',
        '--- a/internal/a.go',
        '+++ b/internal/a.go',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/docs/old.md b/docs/new.md',
        '--- a/docs/old.md',
        '+++ b/docs/new.md',
      ],
    }])

    expect(rows.filter((row) => row.header).map((row) => row.header?.label)).toEqual([
      'internal/a.go', 'docs/new.md',
    ])
  })

  it('renders one full-width rule between nonconsecutive matches in the same file', () => {
    const rows = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n value a.ts',
      match: { paths: ['a.ts'], numbered: true },
      lines: ['4:first', '5:second', '19:later'],
    }])
    const { container } = render(<ScriptOutputPanel rows={rows} />)

    expect(rows.filter((row) => row.divider)).toHaveLength(1)
    const divider = container.querySelector('[data-copy-skip].border-t')
    expect(divider).toHaveClass('col-span-2')
    expect(divider).not.toHaveClass('mx-2.5')
  })

  it('turns an rg context separator into a rule only within the same file', () => {
    const same = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n -C 5 value a.go',
      match: { paths: ['a.go'], numbered: true },
      lines: ['29:first', '30:second', '--', '67:later'],
    }])
    expect(same.filter((row) => row.divider)).toHaveLength(1)
    expect(same.filter((row) => !row.header && !row.divider).map((row) => row.num)).toEqual(['29', '30', '67'])

    const different = scriptOutputRows([{
      kind: 'matches',
      command: 'rg -n -C 5 value src',
      match: { paths: [], numbered: true },
      lines: ['src/a.go:29:first', '--', 'src/b.go:67:later'],
    }])
    expect(different.filter((row) => row.divider)).toHaveLength(0)
    expect(different.filter((row) => row.header).map((row) => row.header?.label)).toEqual(['src/a.go', 'src/b.go'])
  })
})

async function connectedComposer(): Promise<HTMLTextAreaElement> {
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  await waitFor(() => expect(ta).not.toBeDisabled())
  return ta
}

describe('composer status and actions', () => {
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
    useEnterSendsStore.getState().setEnabled(true)
    localStorage.clear()
    useAgentStore.setState({ agents: [] })
  })

  it('sends with Enter and Cmd/Ctrl+Enter by default while Shift+Enter adds a newline', async () => {
    renderChat()
    const ta = await connectedComposer()
    const ws = sockets[0]

    fireEvent.change(ta, { target: { value: 'plain' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(JSON.parse(ws.sent.at(-1) ?? '{}')).toMatchObject({ type: 'user_message', content: [{ text: 'plain' }] })

    fireEvent.change(ta, { target: { value: 'modified' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(JSON.parse(ws.sent.at(-1) ?? '{}')).toMatchObject({ type: 'user_message', content: [{ text: 'modified' }] })

    fireEvent.change(ta, { target: { value: 'two' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(ta).toHaveValue('two\n')
  })

  it('flips Enter to newline and Cmd/Ctrl+Enter to send when Enter sends is off', async () => {
    useEnterSendsStore.getState().setEnabled(false)
    renderChat()
    const ta = await connectedComposer()
    const ws = sockets[0]

    fireEvent.change(ta, { target: { value: 'first line' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta).toHaveValue('first line\n')
    expect(ws.sent).toHaveLength(0)

    fireEvent.change(ta, { target: { value: 'send this' } })
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    expect(JSON.parse(ws.sent.at(-1) ?? '{}')).toMatchObject({ type: 'user_message', content: [{ text: 'send this' }] })
  })

  it('offers Send when the reviewer finishes even if the owning head is running', async () => {
    const agentId = `agent-${++agentSeq}`
    useAgentStore.setState({
      agents: [{ id: agentId, agent_status: { status: AgentStatus.RUNNING } } as AgentResponse],
    })
    render(
      <ChatPane
        agentId={agentId}
        projectId="proj"
        active
        reconnectAttempt={0}
        onStatusUpdate={vi.fn()}
        onDiffRefresh={vi.fn()}
        onSelectCommit={vi.fn()}
        review
      />,
    )
    const ta = await connectedComposer()
    fireEvent.change(ta, { target: { value: 'one more question' } })

    act(() => sockets[0].emit({ type: 'status', status: AgentStatus.RUNNING }))
    await screen.findByRole('button', { name: 'Queue message' })

    act(() => sockets[0].emit({ type: 'status', status: AgentStatus.FINISHED }))
    await screen.findByRole('button', { name: 'Send message' })
    expect(useAgentStore.getState().agents[0].agent_status?.status).toBe(AgentStatus.RUNNING)
  })

  it('renders Send now as a secondary action beside the primary Queue action', async () => {
    const agentId = `agent-${++agentSeq}`
    useAgentStore.setState({
      agents: [{ id: agentId, agent_status: { status: AgentStatus.FINISHED } } as AgentResponse],
    })
    renderChat(agentId)
    const ta = await connectedComposer()
    fireEvent.change(ta, { target: { value: 'ship it' } })

    act(() => useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING))
    const sendNow = await screen.findByRole('button', { name: 'Send message now' })
    expect(sendNow.querySelector('svg')).toHaveClass('lucide-arrow-up')
    expect(sendNow).toHaveClass('border-[#c96442]', 'bg-white', 'text-[#c96442]')
    const queueMessage = screen.getByRole('button', { name: 'Queue message' })
    expect(queueMessage).toHaveClass('bg-[#c96442]', 'text-white')
    expect(queueMessage.querySelector('svg')).toHaveClass('lucide-list-end')

    act(() => useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.FINISHED))
    const sendMessage = await screen.findByRole('button', { name: 'Send message' })
    expect(sendMessage).toHaveClass('bg-[#c96442]', 'text-white')
    expect(sendMessage).not.toHaveClass('border-[#c96442]')
    expect(sendMessage.querySelector('svg')).toHaveClass('lucide-arrow-up')
  })

  it('spaces queued bubbles like consecutive user messages', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    act(() => {
      ws.emit({
        type: 'chat_event',
        event: { seq: 1, type: 'user_message', timestamp: '', payload: { id: 'user-1', content: 'first' } },
      })
      ws.emit({ type: 'replay_done' })
      ws.emit({
        type: 'queue',
        messages: [{ id: 'queued-1', content: [{ type: 'text', text: 'second' }] }],
      })
    })

    await screen.findByText('second')
    expect(document.querySelector('[data-queued-messages]')).toHaveClass('-mt-2')
  })

  it('keeps a fatal connection error visible instead of reconnecting forever', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]

    act(() => {
      ws.emit({ type: 'chat_error', error: 'resume agent failed: sandbox could not start' })
      ws.close()
    })

    expect(await screen.findByText(/resume agent failed: sandbox could not start/)).toBeInTheDocument()
    expect(screen.queryByText('Connecting')).not.toBeInTheDocument()

    // The first quick-failure retry would be scheduled after one second. A
    // fatal frame suppresses it, leaving the actionable banner in place.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(sockets).toHaveLength(1)
    expect(screen.getByText(/resume agent failed: sandbox could not start/)).toBeInTheDocument()
  })
})

describe('running turn elapsed time', () => {
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
    useAgentStore.setState({ agents: [] })
  })

  it('counts a reattached running turn from its snapshot start time', async () => {
    const now = Date.parse('2026-08-30T12:00:42Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    const agentId = `agent-${++agentSeq}`
    useAgentStore.setState({
      agents: [{ id: agentId, agent_status: { status: AgentStatus.RUNNING } } as AgentResponse],
    })
    renderChat(agentId)
    await connectedComposer()

    act(() => {
      sockets[0].emit({
        type: 'state_snapshot',
        state: { turn: { id: 'turn-1', status: 'running', started_at: '2026-08-30T12:00:00Z' } },
      })
      sockets[0].emit({ type: 'replay_done' })
    })

    expect(await screen.findByText('(42s)')).toBeInTheDocument()
    dateNow.mockRestore()
  })

  it('names context compaction in the live activity row until the summary arrives', async () => {
    const agentId = `agent-${++agentSeq}`
    useAgentStore.setState({
      agents: [{ id: agentId, agent_status: { status: AgentStatus.RUNNING } } as AgentResponse],
    })
    renderChat(agentId)
    await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))

    act(() => ws.emit({
      type: 'chat_event',
      event: {
        seq: 1,
        type: 'tool_started',
        timestamp: '',
        payload: { id: 'toolu_compact', name: 'ContextCompaction', input: {} },
      },
    }))
    expect(await screen.findByText('Compacting...')).toBeInTheDocument()

    act(() => ws.emit({
      type: 'chat_event',
      event: {
        seq: 2,
        type: 'user_message',
        timestamp: '',
        payload: {
          id: 'compaction-summary',
          content: 'This session is being continued from a previous conversation that ran out of context. Summary: work continues.',
        },
      },
    }))
    await screen.findByText('Continued from a previous conversation (ran out of context)')
    expect(screen.queryByText('Compacting...')).not.toBeInTheDocument()
  })

  it('shows a completed turn cost from projected API-key auth', async () => {
    renderChat()
    await connectedComposer()

    act(() => {
      sockets[0].emit({
        type: 'state_snapshot',
        state: { version: 1, through: 40, api_key_source: 'ANTHROPIC_API_KEY' },
      })
      sockets[0].emit({
        type: 'chat_event',
        event: {
          seq: 41,
          type: 'turn_completed',
          timestamp: '2026-08-30T12:00:00Z',
          payload: { status: 'completed', cost_usd: 0.2145, usage: { output_tokens: 845 } },
        },
      })
      sockets[0].emit({ type: 'replay_done' })
    })

    expect(await screen.findByText('$0.21')).toBeInTheDocument()
  })

  it('hides the client-estimated cost for subscription auth', async () => {
    renderChat()
    await connectedComposer()

    act(() => {
      sockets[0].emit({
        type: 'state_snapshot',
        state: { version: 1, through: 40, api_key_source: 'none' },
      })
      sockets[0].emit({
        type: 'chat_event',
        event: {
          seq: 41,
          type: 'turn_completed',
          timestamp: '2026-08-30T12:00:00Z',
          payload: { status: 'completed', cost_usd: 0.2145, usage: { output_tokens: 845 } },
        },
      })
      sockets[0].emit({ type: 'replay_done' })
    })

    await screen.findByText(/845 tokens/)
    expect(screen.queryByText('$0.21')).not.toBeInTheDocument()
  })
})

describe('question answer status', () => {
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
    useAgentStore.setState({ agents: [], optimistic: {} })
  })

  it('switches the agent to running as soon as a native question is answered', async () => {
    const agentId = `agent-${++agentSeq}`
    const onStatusUpdate = vi.fn()
    useAgentStore.setState({
      agents: [{ id: agentId, agent_status: { status: AgentStatus.NEEDS_INPUT } } as AgentResponse],
    })
    render(
      <ChatPane
        agentId={agentId}
        projectId="proj"
        active
        reconnectAttempt={0}
        onStatusUpdate={onStatusUpdate}
        onDiffRefresh={vi.fn()}
        onSelectCommit={vi.fn()}
      />,
    )
    await connectedComposer()
    const ws = sockets[0]
    act(() => {
      ws.emit({ type: 'replay_done' })
      ws.emit({
        type: 'chat_event',
        event: {
          seq: 1,
          type: 'tool_started',
          timestamp: '',
          payload: {
            id: 'toolu_question',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Which approach?',
                multiSelect: false,
                options: [{ label: 'First' }, { label: 'Second' }],
              }],
            },
          },
        },
      })
      ws.emit({
        type: 'chat_event',
        event: {
          seq: 2,
          type: 'interaction_requested',
          timestamp: '',
          payload: {
            provider: 'claude',
            request_id: 'request_question',
            interaction: {
              subtype: 'can_use_tool',
              tool_use_id: 'toolu_question',
              tool_name: 'AskUserQuestion',
              input: {
                questions: [{
                  question: 'Which approach?',
                  multiSelect: false,
                  options: [{ label: 'First' }, { label: 'Second' }],
                }],
              },
            },
          },
        },
      })
    })

    fireEvent.click(await screen.findByText('First'))
    const submit = screen.getByRole('button', { name: 'Submit' })
    await waitFor(() => expect(submit).not.toBeDisabled())
    fireEvent.click(submit)

    expect(useAgentStore.getState().agents[0].agent_status?.status).toBe(AgentStatus.RUNNING)
    expect(onStatusUpdate).toHaveBeenCalledWith(AgentStatus.RUNNING)
  })
})

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

  it('accepts a native desktop clipboard image through the same attachment path', async () => {
    renderChat()
    const ta = await connectedComposer()
    ta.focus()

    act(() => window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    })))

    await screen.findByLabelText('Remove image1.png')
    expect(ta.value).toBe('[image1.png]')
    expect(ta).toHaveAttribute('data-desktop-image-paste')
  })

  it('numbers back-to-back desktop images before React commits the first one', async () => {
    renderChat()
    const ta = await connectedComposer()
    ta.focus()

    act(() => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
          detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
        }))
      }
    })

    await screen.findByLabelText('Remove image1.png')
    expect(screen.getByLabelText('Remove image2.png')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove image3.png')).toBeInTheDocument()
  })

  it('attaches WebKit file drops instead of inserting their URI text', async () => {
    renderChat()
    const ta = await connectedComposer()

    fireEvent.drop(ta, webkitFileDropEvent())

    await screen.findByLabelText('Remove diagram.png')
    await screen.findByLabelText('Remove notes.txt')
    expect(ta.value).toBe('')
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

    // The paced reveal walks the text in over a few frames (REVEAL_FLOOR /
    // REVEAL_RATE in AgentChat.tsx), each one a requestAnimationFrame - which
    // jsdom services off a timer. Well inside waitFor's default 1s when the box
    // is idle, and not when it isn't: this is a suite that runs alongside the Go
    // and Playwright suites on a shared machine, and a starved rAF loop is what
    // failed here with the two strings identical up to the truncation. The
    // subject is which DOM NODE survives the swap, so waiting longer for the
    // reveal costs the test nothing.
    const live = await waitFor(() => {
      const p = document.querySelector('[data-md-root] p')
      expect(p?.textContent).toBe(TEXT)
      return p as HTMLElement
    }, { timeout: 15_000 })

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

  it('keeps a settled host-run explanation in the expanded body', async () => {
    const why = 'The sandbox cannot inspect the host listener table, so this read-only command has to run outside it.'
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))
    act(() => {
      const emit = (type: string, payload: unknown) =>
        ws.emit({ type: 'chat_event', event: { seq: ++seq, type, timestamp: '', payload } })
      emit('tool_started', { id: 'toolu_hostrun_why', name: 'mcp__hydra__host_run', input: { command: 'ss -Hltn', why } })
      emit('tool_completed', { id: 'toolu_hostrun_why', content: 'DENIED by the user.' })
    })

    const hostRun = cardHeader('Host run')
    expect(hostRun).toBeDefined()
    expect(screen.queryByText('Why')).toBeNull()
    act(() => hostRun!.click())
    expect(screen.getByText('Why')).toBeVisible()
    // The selector distinguishes the durable body block from the header summary,
    // which deliberately carries the same explanation in truncated form.
    expect(screen.getByText(why, { selector: 'div' })).toBeVisible()
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

  it('keeps the resume time so repeated session breaks remain distinguishable', () => {
    const timestamp = '2026-08-30T12:34:56Z'
    const items = reduceHistoryEvents(
      toProviderEvents({ type: 'session_resumed', seq: 9, timestamp, payload: { worktree: '/wt' } } as never),
      alloc(),
    )

    expect(items).toMatchObject([
      { kind: 'resumed', resumedAt: Date.parse(timestamp), noEntrance: true },
    ])
  })

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
  it('renders first-party tools as native actions and third-party MCP tools namespaced', () => {
    expect(summarizeToolSearchQuery('select:mcp__hydra__git_commit')).toEqual({ text: 'git commit', prose: true })
    expect(summarizeToolSearchQuery('select:Read, mcp__hydra__git_add')).toEqual({ text: 'Read, git add', prose: true })
    expect(summarizeToolSearchQuery('select:mcp__hydra__reply_to_review_comment, mcp__github__get_issue')).toEqual({
      text: 'Reply to review comment, github::get_issue',
      prose: true,
    })
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
    expect(search([{ type: 'tool_reference', tool_name: 'mcp__hydra__git_commit' }])).toMatchObject({ result: 'Loaded git commit' })
  })

  it('counts and lists several', () => {
    const item = search([
      { type: 'tool_reference', tool_name: 'mcp__hydra__git_add' },
      { type: 'tool_reference', tool_name: 'Read' },
    ])
    expect(item).toMatchObject({ result: 'Loaded 2 tools: git add, Read' })
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

describe('Codex tool result envelopes', () => {
  const reduce = (result: unknown) =>
    reduceHistoryEvents(
      [
        {
          type: 'assistant',
          message: {
            id: 'm1',
            content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__hydra__get_review_comments', input: { numbers: [1] } }],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: result }] },
        },
      ],
      (() => {
        let id = 0
        return () => ++id
      })(),
    ).find((item) => item.kind === 'tool')

  it('renders the text inside a Codex MCP CallToolResult', () => {
    const item = reduce({
      content: [{ type: 'text', text: '#1 internal/tests/types.go:130\nPlease simplify this.' }],
      isError: false,
    })
    expect(item).toMatchObject({
      result: '#1 internal/tests/types.go:130\nPlease simplify this.',
    })
  })

  it('keeps plain command output unchanged', () => {
    expect(reduce('git status output')).toMatchObject({ result: 'git status output' })
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

describe('visibleToolInput', () => {
  it('keeps normalized fields but hides provider bookkeeping', () => {
    expect(visibleToolInput({
      message: 'hello',
      _raw: { type: 'mcp_tool_call' },
      _raw_events: [{ type: 'item.started' }],
    })).toEqual({ message: 'hello' })
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

// A commit chip is interleaved into the transcript by TIME (mergedItems), and a
// chip can only be flushed when the walk meets a transcript item stamped after
// it. An optimistic bubble is appended straight to `items` rather than pushed
// through the reducer, so it used to carry no time at all - and every chip the
// walk still held then landed BELOW it. Sending a message right after a run of
// commits (a merge, an update-from-base) therefore put it above commits that
// predate it, and only a reload - where the message came back off the transcript
// with a real timestamp - put it back underneath.
describe('a message sent after a commit lands under it', () => {
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

  it('keeps the optimistic bubble below a chip that predates it', async () => {
    renderChat()
    const ta = await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))
    act(() =>
      ws.emit({
        type: 'chat_event',
        event: {
          seq: 1,
          type: 'commit_created',
          timestamp: '2024-01-01T00:00:00.000Z',
          payload: {
            sha: 'abc123def4567',
            short_sha: 'abc123d',
            subject: 'Teach the loader about overlays',
            additions: 36,
            deletions: 5,
          },
        },
      }),
    )
    const chip = await screen.findByText('Teach the loader about overlays')
    const row = chip.closest('[role="button"]')
    expect(chip).toHaveClass('min-w-0', 'flex-1', 'whitespace-normal', 'break-words')
    expect(chip).not.toHaveClass('truncate')
    expect(row?.parentElement).toHaveClass('min-w-0', 'max-w-full')
    expect(screen.getByLabelText('36 lines added, 5 lines removed')).toHaveClass('top-px')
    expect(row?.querySelector('[data-commit-graph-line]')).toHaveClass('inset-y-0', 'left-[16px]')
    expect(row?.querySelectorAll('[data-commit-graph-dot]')).toHaveLength(1)
    fireEvent.mouseEnter(row?.parentElement as HTMLElement)
    expect(await screen.findByRole('tooltip', {}, { timeout: 1200 })).toHaveClass('text-left')

    fireEvent.change(ta, { target: { value: 'ship it' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    const bubble = await screen.findByText('ship it')

    expect(chip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('connects and aligns merged commit rows with commit-card tooltips', async () => {
    renderChat()
    await connectedComposer()
    const ws = sockets[0]
    act(() => ws.emit({ type: 'replay_done' }))
    act(() =>
      ws.emit({
        type: 'chat_event',
        event: {
          seq: 1,
          type: 'commit_created',
          timestamp: '2024-01-01T00:00:00.000Z',
          payload: {
            sha: 'merge123', short_sha: 'merge12', subject: "Merge branch 'main'",
            additions: 10, deletions: 2, is_merge: true, merged_count: 2,
            merged_commits: [
              {
                sha: 'child123', short_sha: 'child12', subject: 'The merged change',
                author_name: 'Merged Author', timestamp: '2024-01-01T00:00:00.000Z',
                additions: 8, deletions: 1,
              },
              {
                sha: 'child456', short_sha: 'child45', subject: 'The earlier change',
                additions: 2, deletions: 1,
              },
            ],
          },
        },
      }),
    )

    const pill = await screen.findByRole('button', { name: /Merged main - 2 commits/ })
    const mergeLabel = screen.getByText('Merged main - 2 commits')
    expect(mergeLabel).toHaveClass('whitespace-normal', 'break-words')
    expect(mergeLabel).not.toHaveClass('truncate')
    expect(screen.getByLabelText('10 lines added, 2 lines removed')).toHaveClass('top-px')
    fireEvent.click(pill)
    const subject = await screen.findByText('The merged change')
    expect(subject).toHaveClass('whitespace-normal', 'break-words')
    expect(subject).not.toHaveClass('truncate')
    expect(screen.getByLabelText('8 lines added, 1 lines removed')).toHaveClass('top-px')
    expect(pill).toHaveClass('z-10', 'rounded-b-none', 'border-b-0')
    expect(subject.parentElement).toHaveClass('items-baseline')
    expect(subject.closest('[role="button"]')).not.toHaveAttribute('title')

    const list = subject.closest('.rounded-b-md')
    expect(list?.parentElement).toHaveClass('-mt-px')
    expect(list).not.toHaveClass('border-t-0')
    expect(list?.querySelector('[data-commit-graph-line]')).toHaveClass('inset-y-0', 'left-[18px]')
    expect(list?.querySelectorAll('[data-commit-graph-dot]')).toHaveLength(2)
    expect(subject.closest('[role="button"]')).toHaveClass('w-full')
    expect(screen.getByLabelText('8 lines added, 1 lines removed')).toHaveClass('ml-auto')

    fireEvent.mouseEnter(subject.closest('[role="button"]')?.parentElement as HTMLElement)
    expect(await screen.findByText('Merged Author', {}, { timeout: 1200 })).toBeInTheDocument()
    expect(screen.getByRole('tooltip')).toHaveClass('text-left')
  })
})

// The chip for a merge names the branch that came in. It reads that out of the
// commit subject - except when the head absorbed its base by FAST-FORWARD, where
// the branch now sits on the base's own tip and that commit's subject names
// whatever IT merged (some other head). The reconciler then says which ref came
// in (merged_ref), and it wins.
describe('mergeChipLabel', () => {
  it('reads the ref out of a merge subject', () => {
    expect(mergeChipLabel("Merge branch 'main'", 11)).toBe('Merged main - 11 commits')
    expect(mergeChipLabel("Merge remote-tracking branch 'origin/main'", 1)).toBe('Merged origin/main - 1 commit')
  })

  it('prefers the ref the reconciler named', () => {
    // Landing on main's tip, which happens to be main's merge of another head.
    expect(mergeChipLabel("Merge branch 'hydra/some-other-head'", 4, 'main')).toBe('Merged main - 4 commits')
  })

  it('falls back to the subject when it is not a merge subject', () => {
    expect(mergeChipLabel('Squashed everything', 3)).toBe('Squashed everything - 3 commits')
  })
})
