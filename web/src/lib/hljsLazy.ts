// On-demand highlight.js language loading. Complements the eager common set in
// hljs.ts: any language NOT bundled there can be fetched and registered at runtime
// as its own small chunk (see hljsLazyRegistry). Used by the highlight worker, so
// the diff viewer colourises files in ~all of highlight.js's languages while the
// initial download stays lean.
import hljs from './hljs'
import { LAZY_LANGUAGES } from './hljsLazyRegistry'

// Languages that failed to load (unknown name, or import error) — don't retry.
const failed = new Set<string>()
// In-flight/settled loads, so concurrent requests for the same language share one
// import rather than fetching + registering it repeatedly.
const loading = new Map<string, Promise<boolean>>()

// ensureLanguage registers `name` if it isn't already, resolving true once it's
// available for hljs.highlight(). Returns false for the eager-or-unknown cases the
// caller should just render as plain text: already-failed, not a real highlight.js
// language, or an import failure. `name` may be an alias (e.g. 'toml', 'html') —
// those resolve through an eager language and short-circuit on the getLanguage check.
export function ensureLanguage(name: string): Promise<boolean> {
  if (!name || name === 'plaintext' || failed.has(name)) return Promise.resolve(false)
  if (hljs.getLanguage(name)) return Promise.resolve(true)
  const inflight = loading.get(name)
  if (inflight) return inflight
  const loader = LAZY_LANGUAGES[name]
  if (!loader) { failed.add(name); return Promise.resolve(false) }
  const p = loader()
    .then((mod) => {
      // Re-check: a concurrent load may have registered it already.
      if (!hljs.getLanguage(name)) hljs.registerLanguage(name, mod.default)
      return true
    })
    .catch(() => { failed.add(name); return false })
  loading.set(name, p)
  return p
}
