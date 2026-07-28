// Splitting a hostname into "who owns this" (the registrable domain, eTLD+1)
// and "everything in front of it" (the subdomain labels) cannot be done by
// counting dots: `registry.npmjs.org` is one subdomain deep, `bbc.co.uk` is
// none, and `foo.github.io` depends on which section of the list you honour.
// The only correct source is the Public Suffix List (https://publicsuffix.org/),
// which we get from `tldts` - it ships a compiled trie of the list and tracks
// upstream changes through normal dependency bumps.
//
// Two properties this module is built around, both because its main caller is a
// SECURITY prompt (the network / web-fetch approval card):
//
//  1. It never guesses. That trie is ~46KB gzipped, so it is loaded lazily (a
//     dynamic import Vite splits into its own chunk) and hosts render undimmed
//     until it lands. The failure mode is therefore "no dimming", never "the
//     wrong part dimmed" - dimming `npmjs.org.evil.com` down to `npmjs.org`
//     would be worse than plain text, since the whole point of the treatment is
//     that a lookalike host highlights `evil.com`.
//  2. It never drops characters. `prefix + domain` is always exactly the string
//     handed in, byte for byte, so no rendering of the split can hide part of a
//     host from the person approving it.

// getDomain is the Public Suffix List lookup, null until the chunk has loaded.
// It returns the registrable domain (eTLD+1) of a hostname, or null for an IP
// literal, a bare TLD, or anything that isn't a hostname at all.
let getDomain: ((host: string) => string | null) | null = null
let loading: Promise<void> | null = null

const listeners = new Set<() => void>()
// A counter rather than a boolean so useSyncExternalStore has a stable snapshot
// that changes exactly once, when the list arrives.
let version = 0

/**
 * loadPublicSuffixList pulls in the Public Suffix List chunk (once) and wakes
 * every mounted host label when it arrives. A failed load is swallowed: hosts
 * simply stay undimmed for the rest of the session.
 */
export function loadPublicSuffixList(): Promise<void> {
  if (loading) return loading
  loading = import('tldts')
    .then((m) => {
      // ICANN section only (tldts's default). The private section would make
      // `foo.github.io` register as its own domain, which is true of ownership
      // but not of the thing this list is being consulted for here - who you
      // are connecting to as a network peer.
      getDomain = (host) => m.getDomain(host, { allowPrivateDomains: false })
      version++
      for (const l of listeners) l()
    })
    .catch(() => {})
  return loading
}

export function subscribeToPublicSuffixList(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function publicSuffixVersion(): number {
  return version
}

export type HostParts = {
  /** The subdomain labels, including their trailing dot - "" when there are none. */
  prefix: string
  /** The registrable domain and anything after it (trailing dot, :port). */
  domain: string
}

/**
 * splitHostname splits a host into its subdomain prefix and its registrable
 * domain. `prefix + domain` always reconstitutes the input exactly; `prefix` is
 * "" whenever there is nothing to dim, the host isn't a name (an IP literal,
 * `localhost`), or the list hasn't loaded yet.
 */
export function splitHostname(host: string): HostParts {
  const whole: HostParts = { prefix: '', domain: host }
  const lookup = getDomain
  if (!lookup || !host) return whole

  // Trim what the list can't parse but the string may legitimately carry: a
  // leading allow-list wildcard (`*.npmjs.org` / `.npmjs.org`), a trailing
  // `:port`, and a fully-qualified trailing dot. Offsets are then mapped back
  // onto the ORIGINAL string, so nothing trimmed here is lost from the render.
  const head = host.startsWith('*.') ? 2 : host.startsWith('.') ? 1 : 0
  let end = host.length
  const port = /:\d+$/.exec(host)
  if (port) end -= port[0].length
  if (host[end - 1] === '.') end--

  const name = host.slice(head, end)
  const domain = lookup(name)
  if (!domain || domain.length > name.length) return whole

  const at = name.length - domain.length
  // The split has to land on a label boundary, and the tail has to be exactly
  // what the list answered (compared case-insensitively - the list lowercases).
  // The list normalises in ways we can't undo, notably punycoding an IDN; on
  // any mismatch the offset would be a guess, and this module does not guess.
  if (at > 0 && name[at - 1] !== '.') return whole
  if (name.slice(at).toLowerCase() !== domain) return whole
  // at === 0 means the whole name is the registrable domain: nothing to dim,
  // unless the entry led with a wildcard marker, which is itself the prefix.
  if (at === 0 && head === 0) return whole

  return { prefix: host.slice(0, head + at), domain: host.slice(head + at) }
}

export type UrlParts = {
  /** "https://" etc, including the slashes - "" if the URL has no scheme. */
  scheme: string
  /** The authority, split into its dimmable prefix and its registrable domain. */
  host: HostParts
  /** Path, query and fragment - everything after the authority. */
  rest: string
}

const URL_SHAPE = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i

/**
 * splitUrl breaks a URL into scheme / authority / path so the authority's
 * registrable domain can be the one part shown at full strength - the same
 * emphasis a browser's address bar gives it, and for the same reason: in
 * `https://npmjs.org.evil.com/registry`, `evil.com` is the only part that says
 * where the request actually goes. Concatenating the three parts (with the
 * host's own two) reproduces the input exactly.
 */
export function splitUrl(url: string): UrlParts {
  const m = URL_SHAPE.exec(url)
  if (!m) return { scheme: '', host: { prefix: '', domain: url }, rest: '' }
  return { scheme: m[1] ?? '', host: splitHostname(m[2]), rest: m[3] ?? '' }
}
