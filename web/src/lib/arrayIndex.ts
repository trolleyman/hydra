// Build an index once for each array identity. Store lists are reconciled to
// retain their array identity when their contents do not change, so every
// selector sharing one of these indexers gets constant-time keyed lookup
// without duplicating the collection in store state.
export function createArrayIndex<T, K>(keyOf: (item: T) => K) {
  const cache = new WeakMap<readonly T[], ReadonlyMap<K, T>>()

  return (items: readonly T[]): ReadonlyMap<K, T> => {
    const cached = cache.get(items)
    if (cached) return cached

    const index = new Map<K, T>()
    for (const item of items) index.set(keyOf(item), item)
    cache.set(items, index)
    return index
  }
}
