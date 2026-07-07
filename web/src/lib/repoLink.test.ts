import { describe, it, expect } from 'vitest'
import { fileUrlToWorktreeRelative, isTrustedLinkUrl } from './repoLink'

const WT = '/home/callum/code/hydra/.hydra/local/worktrees/my-task'

describe('fileUrlToWorktreeRelative', () => {
  it('maps a file:// URL inside the worktree to a repo-relative path', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/internal/sandbox/sandbox.go`, WT))
      .toEqual({ path: 'internal/sandbox/sandbox.go', line: null })
  })

  it('accepts a localhost-hosted file URL', () => {
    expect(fileUrlToWorktreeRelative(`file://localhost${WT}/main.go`, WT)).toEqual({ path: 'main.go', line: null })
  })

  it('rejects a file URL for another machine host', () => {
    expect(fileUrlToWorktreeRelative(`file://example.com${WT}/main.go`, WT)).toBeNull()
  })

  it('maps a bare absolute path inside the worktree', () => {
    expect(fileUrlToWorktreeRelative(`${WT}/web/src/index.tsx`, WT)).toEqual({ path: 'web/src/index.tsx', line: null })
  })

  it('decodes percent-encoded path segments', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/a%20b/c.txt`, WT)).toEqual({ path: 'a b/c.txt', line: null })
  })

  it('reads a line from an #L<n> / #<n> fragment', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/main.go#L115`, WT)).toEqual({ path: 'main.go', line: 115 })
    expect(fileUrlToWorktreeRelative(`file://${WT}/main.go#42`, WT)).toEqual({ path: 'main.go', line: 42 })
    // A range fragment takes the first line.
    expect(fileUrlToWorktreeRelative(`file://${WT}/main.go#L10-L20`, WT)).toEqual({ path: 'main.go', line: 10 })
  })

  it('reads a line from a trailing :line[:col] suffix (file URL and bare path)', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/main.go:42`, WT)).toEqual({ path: 'main.go', line: 42 })
    expect(fileUrlToWorktreeRelative(`${WT}/main.go:42:5`, WT)).toEqual({ path: 'main.go', line: 42 })
  })

  it('drops a ?query and prefers a fragment line over a colon suffix', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/main.go?x=1`, WT)).toEqual({ path: 'main.go', line: null })
    expect(fileUrlToWorktreeRelative(`${WT}/main.go#L7`, WT)).toEqual({ path: 'main.go', line: 7 })
  })

  it('tolerates a trailing slash on the worktree path', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/x.go`, WT + '/')).toEqual({ path: 'x.go', line: null })
  })

  it('returns null for a path outside the worktree', () => {
    expect(fileUrlToWorktreeRelative('file:///etc/passwd', WT)).toBeNull()
    // A sibling worktree whose path is a string prefix but not a path prefix.
    expect(fileUrlToWorktreeRelative(`file://${WT}-2/main.go`, WT)).toBeNull()
  })

  it('returns null for the worktree root itself', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}`, WT)).toBeNull()
    expect(fileUrlToWorktreeRelative(WT, WT)).toBeNull()
  })

  it('returns null without a worktree, for non-file schemes, or on garbage', () => {
    expect(fileUrlToWorktreeRelative(`file://${WT}/x.go`, null)).toBeNull()
    expect(fileUrlToWorktreeRelative('https://claude.com/x', WT)).toBeNull()
    expect(fileUrlToWorktreeRelative('not a url', WT)).toBeNull()
  })
})

describe('isTrustedLinkUrl', () => {
  it('trusts listed hosts and their subdomains', () => {
    expect(isTrustedLinkUrl('https://claude.com/cai/oauth/authorize?code=true')).toBe(true)
    expect(isTrustedLinkUrl('https://console.anthropic.com/foo')).toBe(true)
    expect(isTrustedLinkUrl('http://localhost:26600/x')).toBe(true)
  })

  it('trusts the app origin even when not in the host list', () => {
    expect(isTrustedLinkUrl('https://hydra.example.dev/path', 'https://hydra.example.dev')).toBe(true)
  })

  it('does not trust unknown hosts or a lookalike suffix', () => {
    expect(isTrustedLinkUrl('https://evil.example.com/x')).toBe(false)
    expect(isTrustedLinkUrl('https://notclaude.com/x')).toBe(false)
    expect(isTrustedLinkUrl('https://claude.com.evil.test/x')).toBe(false)
  })

  it('never trusts non-http(s) schemes or malformed URLs', () => {
    expect(isTrustedLinkUrl('file:///home/callum/x')).toBe(false)
    expect(isTrustedLinkUrl('javascript:alert(1)')).toBe(false)
    expect(isTrustedLinkUrl('nonsense')).toBe(false)
  })
})
