import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatPane } from './AgentChat'

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
