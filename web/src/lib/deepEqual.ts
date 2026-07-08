// deepEqual compares two JSON-ish values (API response shapes: plain objects,
// arrays, primitives) structurally. Used to preserve object identity across
// server refetches: when a poll returns data that is structurally identical to
// what's already in state, the previous object is kept so React subscribers
// (selectors, memo()'d components) see an unchanged reference and skip
// re-rendering. Not general-purpose: Maps/Sets/Dates/functions compare by
// reference only, which is all the API DTOs need.

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) {
      if (!deepEqual(x[i], y[i])) return false
    }
    return true
  }
  // Only plain objects compare structurally; anything with a custom prototype
  // (Map, Set, Date, class instances) already failed the Object.is check above.
  const protoA = Object.getPrototypeOf(a)
  const protoB = Object.getPrototypeOf(b)
  if ((protoA !== null && protoA !== Object.prototype) || (protoB !== null && protoB !== Object.prototype)) return false
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

// reuseIfEqual returns `prev` when `next` is structurally identical to it, so
// state setters can hand React back the same reference and bail out of the
// update entirely.
export function reuseIfEqual<T>(prev: T, next: T): T {
  return deepEqual(prev, next) ? prev : next
}

// reconcileList merges a freshly-fetched list against the previous one by key:
// an element that is structurally unchanged keeps its previous object identity,
// and if EVERY element is unchanged (same length and order too) the previous
// array itself is returned - so memo()'d rows and array-selector subscribers
// skip re-rendering on a no-op refresh.
export function reconcileList<T>(prev: T[], next: T[], key: (item: T) => string): T[] {
  const prevByKey = new Map<string, T>()
  for (const p of prev) prevByKey.set(key(p), p)
  let allSame = prev.length === next.length
  const merged = next.map((n, i) => {
    const p = prevByKey.get(key(n))
    if (p !== undefined && deepEqual(p, n)) {
      if (allSame && prev[i] !== p) allSame = false
      return p
    }
    allSame = false
    return n
  })
  return allSame ? prev : merged
}
