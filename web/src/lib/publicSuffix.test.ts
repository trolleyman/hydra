import { describe, it, expect, beforeAll } from 'vitest'
import { loadPublicSuffixList, splitHostname, splitUrl } from './publicSuffix'

describe('splitHostname (before the list loads)', () => {
  it('reports the whole host as the domain rather than guessing', () => {
    expect(splitHostname('registry.npmjs.org')).toEqual({ prefix: '', domain: 'registry.npmjs.org' })
  })
})

describe('splitHostname', () => {
  beforeAll(async () => {
    await loadPublicSuffixList()
  })

  const cases: Array<[string, string, string]> = [
    // host                              prefix              domain
    ['registry.npmjs.org', 'registry.', 'npmjs.org'],
    ['npmjs.org', '', 'npmjs.org'],
    // Every subdomain label dims, however deep.
    ['a.b.c.example.com', 'a.b.c.', 'example.com'],
    // A multi-label public suffix - the reason a dot count won't do.
    ['www.bbc.co.uk', 'www.', 'bbc.co.uk'],
    ['bbc.co.uk', '', 'bbc.co.uk'],
    // The list's wildcard rule `*.kawasaki.jp` makes `baz.kawasaki.jp` a public
    // suffix, and its exception `!city.kawasaki.jp` takes that back for `city`.
    ['foo.bar.baz.kawasaki.jp', 'foo.', 'bar.baz.kawasaki.jp'],
    ['foo.bar.city.kawasaki.jp', 'foo.bar.', 'city.kawasaki.jp'],
    // The private section is off, so a hosting suffix is not a domain of its own.
    ['someone.github.io', 'someone.', 'github.io'],
    // The whole point: a lookalike highlights where the request really goes.
    ['npmjs.org.evil.com', 'npmjs.org.', 'evil.com'],
    // Allow-list wildcard forms keep their marker in the dimmed prefix.
    ['*.npmjs.org', '*.', 'npmjs.org'],
    ['*.registry.npmjs.org', '*.registry.', 'npmjs.org'],
    ['.npmjs.org', '.', 'npmjs.org'],
    // A port and a fully-qualified trailing dot ride along with the domain.
    ['registry.npmjs.org:443', 'registry.', 'npmjs.org:443'],
    ['registry.npmjs.org.', 'registry.', 'npmjs.org.'],
    // A TLD not on the list still gets the list's default rule ("*").
    ['build.box.internal', 'build.', 'box.internal'],
    // Hosts are case-insensitive; the list's lowercased answer is matched back
    // onto the original spelling rather than replacing it.
    ['Registry.NPMJS.org', 'Registry.', 'NPMJS.org'],
  ]
  it.each(cases)('splits %s', (host, prefix, domain) => {
    expect(splitHostname(host)).toEqual({ prefix, domain })
  })

  const plain = [
    'localhost',
    'localhost:26600',
    '127.0.0.1',
    '192.168.1.5:8080',
    '[::1]',
    'org',
    'co.uk',
    '',
  ]
  it.each(plain)('leaves %s undimmed', (host) => {
    expect(splitHostname(host)).toEqual({ prefix: '', domain: host })
  })

  it('never drops characters', () => {
    for (const host of [...cases.map((c) => c[0]), ...plain]) {
      const { prefix, domain } = splitHostname(host)
      expect(prefix + domain).toBe(host)
    }
  })
})

describe('splitUrl', () => {
  beforeAll(async () => {
    await loadPublicSuffixList()
  })

  it('splits scheme, host and path', () => {
    expect(splitUrl('https://docs.anthropic.com/en/api?x=1#top')).toEqual({
      scheme: 'https://',
      host: { prefix: 'docs.', domain: 'anthropic.com' },
      rest: '/en/api?x=1#top',
    })
  })

  it('handles a scheme-stripped URL', () => {
    expect(splitUrl('registry.npmjs.org/express')).toEqual({
      scheme: '',
      host: { prefix: 'registry.', domain: 'npmjs.org' },
      rest: '/express',
    })
  })

  it('reproduces the input exactly', () => {
    for (const url of [
      'https://npmjs.org.evil.com/registry.npmjs.org',
      'http://localhost:26600/project/x',
      'https://bbc.co.uk',
      'not a url at all',
      '',
    ]) {
      const { scheme, host, rest } = splitUrl(url)
      expect(scheme + host.prefix + host.domain + rest).toBe(url)
    }
  })
})
