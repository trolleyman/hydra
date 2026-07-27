// randomId returns a collision-resistant id (a v4 UUID when possible).
//
// crypto.randomUUID only exists in a *secure context* (https, or a localhost
// origin). Hydra is routinely reached over plain http via a LAN hostname
// (e.g. http://hades:26600), where the whole `crypto` object is present but
// `randomUUID` is not - calling it throws "crypto.randomUUID is not a
// function" and takes down whatever was mid-send. crypto.getRandomValues, by
// contrast, is available in insecure contexts too, so we build the UUID from it
// when randomUUID is missing, and only fall back to Math.random on the truly
// ancient path where neither exists.
export function randomId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // fall through to the getRandomValues path below
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    // RFC 4122 v4: set the version (4) and variant (10xx) bits.
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const hex: string[] = []
    for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
