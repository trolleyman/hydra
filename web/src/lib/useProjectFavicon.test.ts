import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { attentionFaviconUrl, useProjectFavicon } from './useProjectFavicon'
import { useProjectStore } from '../stores/projectStore'

vi.mock('./projectIconUrl', () => ({
  ensureProjectIconUrl: vi.fn(() => Promise.resolve('/project-icon.png')),
}))

afterEach(() => {
  document.head.querySelectorAll('[data-test-favicon]').forEach((node) => node.remove())
  vi.restoreAllMocks()
})

describe('attentionFaviconUrl', () => {
  it('leaves an unbadged favicon unchanged', () => {
    expect(attentionFaviconUrl('/icon.png', null)).toBe('/icon.png')
  })

  it('draws the unread dot in blue at the bottom-right', () => {
    const svg = decodeURIComponent(attentionFaviconUrl('https://example.test/icon.png?a=1&b=2', 'unread').split(',')[1])
    expect(svg).toContain('cx="103" cy="103"')
    expect(svg).toContain('fill="#0ea5e9"')
    expect(svg).toContain('a=1&amp;b=2')
  })

  it('draws needs-input in red', () => {
    const svg = decodeURIComponent(attentionFaviconUrl('/icon.png', 'needs_input').split(',')[1])
    expect(svg).toContain('fill="#ef4444"')
  })

  it('updates favicon metadata and requests an installed-app badge', async () => {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    link.href = '/favicon-16x16.png'
    link.dataset.testFavicon = ''
    document.head.append(link)
    useProjectStore.getState().setProjects([
      { id: 'p', name: 'Project', path: '/tmp/project', icon: 'Rocket' },
    ])
    const setAppBadge = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true })

    const { unmount } = renderHook(() => useProjectFavicon('p', 'needs_input'))
    await waitFor(() => expect(link.href).toContain('data:image/svg+xml'))
    expect(link.type).toBe('image/svg+xml')
    expect(setAppBadge).toHaveBeenCalledOnce()

    unmount()
    expect(link.getAttribute('href')).toBe('/favicon-16x16.png')
    expect(link.type).toBe('image/png')
  })
})
