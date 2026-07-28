import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttachmentChips } from './AttachmentChips'
import type { Attachment } from '../lib/spawnDrafts'
import { attachmentLightboxItems, openableAttachments } from '../lib/attachmentLightbox'

// Attachment chips used to be openable only when they were pictures: a .log or a
// .zip you had attached rendered an icon and a name and did nothing at all on
// click. Every chip with bytes behind it now opens the lightbox, so these pin
// both halves of that - the chip is an activatable control, and the entries it
// opens into cover the non-image files too.

const chip = (over: Partial<Attachment> & { id: number; filename: string }): Attachment => ({
  path: null,
  size: 0,
  uploading: false,
  ...over,
})

const attachments: Attachment[] = [
  chip({ id: 1, filename: 'signin.png', url: '/blob?name=signin.png', previewUrl: '/blob?name=signin.png', size: 2048 }),
  chip({ id: 2, filename: 'build.log', url: '/blob?name=build.log', size: 900 }),
  chip({ id: 3, filename: 'app.apk', url: '/blob?name=app.apk', size: 10 }),
  // Still uploading with nothing to serve yet: the one case that stays inert.
  chip({ id: 4, filename: 'pending.txt', uploading: true }),
]

describe('AttachmentChips', () => {
  it('makes every chip with bytes behind it an activatable control', () => {
    const onOpen = vi.fn()
    render(<AttachmentChips attachments={attachments} size="md" onOpen={onOpen} />)

    for (const name of ['signin.png', 'build.log', 'app.apk']) {
      fireEvent.click(screen.getByRole('button', { name: `View ${name}` }))
    }
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual([1, 2, 3])

    // The chip with no url yet isn't a button, and can't be tabbed to.
    expect(screen.queryByRole('button', { name: 'View pending.txt' })).toBeNull()
  })

  it('opens on Enter and Space, so the chips are reachable by keyboard', () => {
    const onOpen = vi.fn()
    render(<AttachmentChips attachments={attachments} size="sm" onOpen={onOpen} />)
    const log = screen.getByRole('button', { name: 'View build.log' })
    fireEvent.keyDown(log, { key: 'Enter' })
    fireEvent.keyDown(log, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})

describe('attachmentLightboxItems', () => {
  it('lines the entries up with the openable chips and types each one', () => {
    expect(openableAttachments(attachments).map((a) => a.id)).toEqual([1, 2, 3])
    expect(attachmentLightboxItems(attachments)).toEqual([
      { url: '/blob?name=signin.png', filename: 'signin.png', size: 2048, kind: 'image' },
      { url: '/blob?name=build.log', filename: 'build.log', size: 900, kind: 'text' },
      { url: '/blob?name=app.apk', filename: 'app.apk', size: 10, kind: 'binary' },
    ])
  })
})
