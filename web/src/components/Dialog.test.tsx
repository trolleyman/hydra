import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Dialog } from './Dialog'
import { useDialogStore } from '../stores/dialogStore'
import { loadPublicSuffixList } from '../lib/publicSuffix'

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
