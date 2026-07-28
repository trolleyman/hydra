import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { withBranchPills, pillText } from './branchPills'

// A pill is the only <span> carrying the mono class, so counting those counts
// pills; reading them back gives what each one wrapped.
const pills = (node: React.ReactNode) => {
  const { container } = render(<div>{node}</div>)
  return [...container.querySelectorAll('span.font-mono')].map((el) => el.textContent)
}
const text = (node: React.ReactNode) => render(<div>{node}</div>).container.textContent

describe('withBranchPills', () => {
  it('passes plain text through untouched', () => {
    expect(withBranchPills('Auto-merge cancelled')).toBe('Auto-merge cancelled')
  })

  it('turns a backticked span into a pill', () => {
    const node = withBranchPills('Synced with `origin/main`')
    expect(pills(node)).toEqual(['origin/main'])
    expect(text(node)).toBe('Synced with origin/main')
  })

  it('handles several pills in one string', () => {
    expect(pills(withBranchPills('merge `feat` into `main`'))).toEqual(['feat', 'main'])
  })

  it('leaves an unpaired backtick literal instead of swallowing the rest', () => {
    const node = withBranchPills('a stray ` backtick here')
    expect(pills(node)).toEqual([])
    expect(text(node)).toBe('a stray ` backtick here')
  })

  it('tightens punctuation that follows a pill', () => {
    const { container } = render(<div>{withBranchPills('Merge into `main`?')}</div>)
    const tight = container.querySelector('span.-ml-1')
    expect(tight?.textContent).toBe('?')
  })
})

describe('pillText', () => {
  it('makes an interpolated value inert - it cannot open a pill', () => {
    // The shape that motivated this: an API error sentence carrying backticks.
    const detail = 'unknown flag `--foo`'
    const node = pillText`Request failed: ${detail}`
    expect(pills(node)).toEqual([])
    expect(text(node)).toBe('Request failed: unknown flag `--foo`')
  })

  it('a single stray backtick in a value stays literal', () => {
    const node = pillText`Commit failed: ${'bad ` quote'}`
    expect(pills(node)).toEqual([])
    expect(text(node)).toBe('Commit failed: bad ` quote')
  })

  it('still pills a value that the AUTHORED copy wraps in backticks', () => {
    const node = pillText`Merged into \`${'main'}\``
    expect(pills(node)).toEqual(['main'])
  })

  it('pills a value spanning one pair of authored backticks', () => {
    const node = pillText`Synced with \`${'origin'}/${'main'}\``
    expect(pills(node)).toEqual(['origin/main'])
  })

  it('keeps authored pills and inert values in the same string', () => {
    const node = pillText`Merge into \`${'main'}\` failed: ${'saw `weird` text'}`
    expect(pills(node)).toEqual(['main'])
    expect(text(node)).toBe('Merge into main failed: saw `weird` text')
  })

  it('renders a null or undefined value as nothing', () => {
    expect(text(pillText`value: ${null}${undefined}`)).toBe('value: ')
  })
})
