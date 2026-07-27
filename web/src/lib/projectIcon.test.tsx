import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ProjectIcon } from './projectIcon'
import { loadLucideIcons } from './lucideIcons'

afterEach(cleanup)

// The box is one glyph wide, so whatever ProjectIcon falls back to has to fit
// inside `size` - the bug that started this was a whole icon name rendered as
// text, spilling across the project switcher row.
function box(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement
}

describe('ProjectIcon', () => {
  it('renders a lucide icon named in either spelling', async () => {
    for (const value of ['FolderDot', 'folder-dot', 'folder_dot']) {
      const { container } = render(<ProjectIcon icon={value} projectId="p" size={16} />)
      expect(container.querySelector('svg'), value).not.toBeNull()
      cleanup()
    }
  })

  it('renders an emoji as itself', () => {
    const { container } = render(<ProjectIcon icon="🚀" projectId="p" size={16} />)
    expect(box(container).textContent).toBe('🚀')
  })

  it('collapses an unresolvable name to a letter tile instead of overflowing', async () => {
    // Settle the lazy set first, so the component is past its pending state.
    await loadLucideIcons()
    const { container } = await act(async () => render(<ProjectIcon icon="NotARealIcon" projectId="p" size={16} />))
    const el = box(container)
    expect(el.textContent).toBe('N')
    expect(el.style.width).toBe('16px')
    expect(el.style.height).toBe('16px')
    expect(el.className).toContain('overflow-hidden')
  })

  it('renders an image icon through the backend route', () => {
    const { container } = render(<ProjectIcon icon="logo.png" projectId="my project" size={16} />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/project-icon/projects/my%20project')
  })

  it('falls back to the project initial with no icon set', () => {
    const { container } = render(<ProjectIcon icon="" projectId="_chat" size={16} />)
    // Built-in ids are underscore-prefixed; a lone "_" reads as a glitch.
    expect(box(container).textContent).toBe('c')
  })
})
