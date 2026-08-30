import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Dialog } from './Dialog'
import { useDialogStore } from '../stores/dialogStore'
import { loadPublicSuffixList } from '../lib/publicSuffix'

describe('Dialog: modal opacity', () => {
  afterEach(() => {
    useDialogStore.getState().hide()
  })

  it('does not fade the opaque panel together with its backdrop', () => {
    useDialogStore.getState().show({
      title: 'Tests still running',
      message: "Tests haven't finished on this commit yet.",
      variant: 'mergeGate',
      details: { fromBranch: 'hydra/fix', toBranch: 'main', testStatus: 'running' },
    })
    const { unmount } = render(<Dialog />)

    const layer = screen.getByRole('dialog').parentElement
    expect(layer).not.toHaveClass('fade-in')
    expect(layer).not.toHaveClass('animate-in')
    expect(document.documentElement).toHaveClass('hydra-dialog-open')
    unmount()
    expect(document.documentElement).not.toHaveClass('hydra-dialog-open')
  })
})

describe('Dialog: externalLink', () => {
  beforeAll(async () => {
    await loadPublicSuffixList()
  })
  afterEach(() => {
    useDialogStore.getState().hide()
  })

  it('shows the URL in full, with the registrable domain at full strength', async () => {
    useDialogStore.getState().show({
      title: 'Open external link?',
      message: 'A link in the terminal wants to open outside Hydra.',
      type: 'confirm',
      variant: 'externalLink',
      details: { url: 'https://docs.anthropic.com.cdn-assets-eu.net/agent-sdk' },
      confirmLabel: 'Open link',
    })
    const { container } = render(<Dialog />)
    await waitFor(() => expect(container.querySelector('.opacity-55')).not.toBeNull())

    // Nothing may be dropped from a URL you are being asked to approve.
    const box = container.querySelector('.font-mono') as HTMLElement
    expect(box.textContent).toBe('https://docs.anthropic.com.cdn-assets-eu.net/agent-sdk')

    // ...and the part that says where it really goes is the part left undimmed.
    const dim = Array.from(box.querySelectorAll('.opacity-55')).map((e) => e.textContent)
    expect(dim).toEqual(['https://', 'docs.anthropic.com.', '/agent-sdk'])

    expect(screen.getByRole('button', { name: 'Open link' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })
})

describe('Dialog: sendPrompt', () => {
  afterEach(() => {
    useDialogStore.getState().hide()
  })

  type ShowOptions = Parameters<ReturnType<typeof useDialogStore.getState>['show']>[0]
  const show = (extra: Partial<ShowOptions>) =>
    useDialogStore.getState().show({
      title: 'Ask the agent to fix this test?',
      message: 'This is sent to the agent as a new chat message.',
      variant: 'sendPrompt',
      confirmLabel: 'Send to agent',
      details: { prompt: 'fix it' },
      ...extra,
    })

  it('offers Spawn agent alongside the primary send, and runs it', () => {
    const onSecondary = vi.fn()
    show({ secondaryLabel: 'Spawn agent', onSecondary })
    render(<Dialog />)

    const spawn = screen.getByRole('button', { name: 'Spawn agent' })
    // The primary stays the filled indigo button; the alternative is an outline,
    // so the pair can't read as two primaries.
    expect(screen.getByRole('button', { name: 'Send to agent' }).className).toContain('bg-indigo-600')
    expect(spawn.className).not.toContain('bg-indigo-600')

    fireEvent.click(spawn)
    expect(onSecondary).toHaveBeenCalledTimes(1)
    // Acting closes the dialog, like the confirm path.
    expect(useDialogStore.getState().isOpen).toBe(false)
  })

  it('hides the spawn button when the call site offers no spawn', () => {
    show({})
    render(<Dialog />)
    expect(screen.queryByRole('button', { name: 'Spawn agent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send to agent' })).toBeTruthy()
  })
})
