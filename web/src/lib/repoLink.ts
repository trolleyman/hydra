// Helpers for the agent terminal's OSC 8 hyperlink handler (AgentTerminal).
// Agents such as Claude Code emit OSC 8 hyperlinks in their output: file://
// URLs for the files they touch (the underlined paths in tool-call headers) and
// https:// URLs for things like OAuth flows. xterm's built-in handler pops a
// browser `confirm()` for every one — and, unless allowNonHttpProtocols is set,
// won't surface file:// links at all. These helpers let the terminal instead
//   (a) turn a worktree file:// link into an in-app repository-view navigation
//       on the agent's own branch, and
//   (b) open a small set of trusted hosts without the confirm prompt.

// TRUSTED_LINK_HOSTS are opened straight away, skipping the "Do you want to
// navigate to…" confirm. Matched against the URL host exactly or as a parent of
// a subdomain (so `claude.com` also trusts `console.claude.com`). The app's own
// origin is always trusted (passed in at match time). Deliberately short — any
// other host still gets the confirm guard.
export const TRUSTED_LINK_HOSTS = [
  'claude.com',
  'claude.ai',
  'anthropic.com',
  'github.com',
  'localhost',
  '127.0.0.1',
]

function hostMatches(host: string, trusted: string): boolean {
  return host === trusted || host.endsWith('.' + trusted)
}

// isTrustedLinkUrl reports whether an http(s) URL points at a trusted host, so
// the terminal can open it without a confirm. Same-origin links are always
// trusted. Non-http(s) URLs are never trusted here (file:// links have their own
// path via fileUrlToWorktreeRelative).
export function isTrustedLinkUrl(url: string, selfOrigin?: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (selfOrigin) {
    try {
      // Same-origin includes the port (localhost:8080 !== localhost:9000).
      if (u.host === new URL(selfOrigin).host) return true
    } catch { /* malformed origin — fall through to the host list */ }
  }
  // Match the host list against the hostname (no port), so localhost:26662 and
  // any port on a trusted host still count.
  return TRUSTED_LINK_HOSTS.some((t) => hostMatches(u.hostname, t))
}

// fileUrlToWorktreeRelative maps an OSC 8 link target to a repo-relative path
// when it is a file:// URL (or a bare absolute path) that lives inside the
// agent's worktree. Returns null when it isn't a local file link, there is no
// worktree, it points outside the worktree, or it is the worktree root itself.
//
// The worktree lives at its real absolute path inside the sandbox (the agent's
// cwd), so the paths an agent prints match `worktreePath` verbatim. A file://
// URL's #fragment / ?query are dropped by URL parsing; for a bare path we also
// strip a trailing editor-style ":line[:col]" suffix, since the repository view
// addresses whole files.
export function fileUrlToWorktreeRelative(
  url: string,
  worktreePath: string | null | undefined,
): string | null {
  if (!worktreePath) return null
  let abs: string | null = null
  if (url.startsWith('file:')) {
    try {
      const u = new URL(url)
      // Only same-machine file URLs (empty host, or the conventional localhost).
      if (u.host && u.host !== 'localhost') return null
      abs = decodeURIComponent(u.pathname)
    } catch {
      return null
    }
  } else if (url.startsWith('/')) {
    abs = url.split('#')[0].split('?')[0].replace(/:\d+(?::\d+)?$/, '')
  }
  if (!abs) return null

  const root = worktreePath.replace(/\/+$/, '')
  if (abs === root) return null
  const prefix = root + '/'
  if (!abs.startsWith(prefix)) return null
  const rel = abs.slice(prefix.length).replace(/^\/+/, '')
  // Guard against a traversal segment sneaking back out of the worktree.
  if (!rel || rel.split('/').includes('..')) return null
  return rel
}
