// The whole lucide icon set, as its own module so it lands in its own chunk.
//
// This exists purely for code splitting. `import('lucide-react')` does NOT work
// here: the package's entry module is already reachable statically (every
// component that does `import { X } from 'lucide-react'` goes through it), so
// the bundler resolves the dynamic import to that same eager chunk and the
// namespace access pulls all ~1750 icons into it - half a megabyte on every page
// load. Re-exporting `icons` from a module nobody imports statically keeps the
// icon index reachable only through loadLucideIcons's dynamic import, so it gets
// a chunk of its own that is fetched on demand.
//
// Verify with `npm run build`: there must be a lucide-react-*.js chunk that the
// entry chunk only ever `import()`s, never imports statically.

export { icons } from 'lucide-react'
