import React, { useEffect, useSyncExternalStore } from 'react'
import {
  loadPublicSuffixList,
  publicSuffixVersion,
  splitHostname,
  splitUrl,
  subscribeToPublicSuffixList,
} from '../lib/publicSuffix'

// Host and URL labels that lowlight everything except the registrable domain -
// `registry.` fades, `npmjs.org` stays. Which part is "the domain" comes from
// the Public Suffix List (see lib/publicSuffix.ts), so `bbc.co.uk` keeps both
// of its final labels and `npmjs.org.evil.com` highlights `evil.com` - the
// point of the treatment is that the part naming who you are really talking to
// is the part that reads loudest.

// DIM lowlights by opacity rather than by colour so one component works in
// every context it is dropped into: the neutral chip on an approval card, the
// already-muted caption under it, and a blue link in the chat transcript, which
// a fixed gray would knock out of its link colour.
const DIM = 'opacity-55'

// useHostParts loads the suffix list on mount and re-renders once it arrives.
// Everything renders undimmed until then - a deliberate "no answer" rather than
// a guessed one, since a mis-dimmed host on a security prompt would mislead.
function usePublicSuffixList(): void {
  useSyncExternalStore(subscribeToPublicSuffixList, publicSuffixVersion, publicSuffixVersion)
  useEffect(() => {
    void loadPublicSuffixList()
  }, [])
}

/**
 * HostName renders a hostname with its subdomain labels lowlit. Handles the
 * shapes a host string turns up in around here: bare (`registry.npmjs.org`),
 * with a port, and the allow-list wildcards (`*.npmjs.org` / `.npmjs.org`). An
 * IP literal or `localhost` renders plain.
 */
export const HostName: React.FC<{ host: string }> = ({ host }) => {
  usePublicSuffixList()
  const { prefix, domain } = splitHostname(host)
  if (!prefix) return <>{host}</>
  return (
    <>
      <span className={DIM}>{prefix}</span>
      {domain}
    </>
  )
}

/**
 * UrlText renders a URL with everything but the registrable domain lowlit - the
 * scheme, the subdomain labels, and the whole path. Same emphasis a browser's
 * address bar gives, so a long URL's real destination is readable at a glance.
 */
export const UrlText: React.FC<{ url: string }> = ({ url }) => {
  usePublicSuffixList()
  const { scheme, host, rest } = splitUrl(url)
  if (!host.prefix && !scheme && !rest) return <>{url}</>
  return (
    <>
      {scheme && <span className={DIM}>{scheme}</span>}
      {host.prefix && <span className={DIM}>{host.prefix}</span>}
      {host.domain}
      {rest && <span className={DIM}>{rest}</span>}
    </>
  )
}
