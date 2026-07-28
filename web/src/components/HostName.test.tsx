import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { HostName, UrlText } from './HostName'
import { loadPublicSuffixList } from '../lib/publicSuffix'

// dimmed reads back the rendering as text with the lowlit runs bracketed, so a
// test asserts BOTH what is dimmed and that the full string survived.
function dimmed(el: HTMLElement): string {
  const walk = (n: Node): string =>
    Array.from(n.childNodes).map((c) => {
      if (c.nodeType === Node.TEXT_NODE) return c.textContent ?? ''
      const e = c as HTMLElement
      return e.classList.contains('opacity-55') ? `[${e.textContent}]` : walk(e)
    }).join('')
  return walk(el)
}

describe('HostName', () => {
  beforeAll(async () => {
    await loadPublicSuffixList()
  })

  it('lowlights the subdomain labels', async () => {
    const { container } = render(<span data-testid="h"><HostName host="registry.npmjs.org" /></span>)
    await waitFor(() => expect(container.querySelector('.opacity-55')).not.toBeNull())
    expect(dimmed(screen.getByTestId('h'))).toBe('[registry.]npmjs.org')
  })

  it('renders a host with nothing to lowlight as plain text', () => {
    render(<span data-testid="h"><HostName host="localhost" /></span>)
    expect(dimmed(screen.getByTestId('h'))).toBe('localhost')
  })
})

describe('UrlText', () => {
  beforeAll(async () => {
    await loadPublicSuffixList()
  })

  it('leaves only the registrable domain at full strength', async () => {
    const { container } = render(
      <span data-testid="u"><UrlText url="https://npmjs.org.evil.com/registry/express" /></span>,
    )
    await waitFor(() => expect(container.querySelector('.opacity-55')).not.toBeNull())
    expect(dimmed(screen.getByTestId('u'))).toBe('[https://][npmjs.org.]evil.com[/registry/express]')
  })
})
