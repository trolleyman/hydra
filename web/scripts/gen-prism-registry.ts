// Regenerates src/lib/prismLazyRegistry.ts from what refractor actually ships:
// every grammar that prism.ts does NOT already register becomes a lazy dynamic
// import. Run from web/ after upgrading refractor:
//
//   node scripts/gen-prism-registry.ts
//
// "Does not already register" is the transitive closure, not just the import
// list: registering one grammar registers the ones it extends (php pulls in
// markup-templating, tsx pulls in jsx), and a lazy entry for one of those would
// be a chunk that can never be fetched.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { refractor } from 'refractor/core'

const eagerImports = [...readFileSync('src/lib/prism.ts', 'utf8')
  .matchAll(/from 'refractor\/([a-z0-9-]+)'/g)].map((m) => m[1]).filter((n) => n !== 'core')

for (const name of eagerImports) {
  const mod = await import(`refractor/${name}`)
  refractor.register(mod.default)
}
const eager = new Set(refractor.listLanguages())

const lazy = readdirSync('node_modules/refractor/lang')
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.replace(/\.js$/, ''))
  .filter((l) => !eager.has(l))
  .sort()

const lazyAliases = Object.fromEntries(await Promise.all(lazy.map(async (name) => {
  const mod = await import(`refractor/${name}`)
  return [name, mod.default.aliases ?? []] as const
})))

const key = (l: string) => (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(l) ? l : JSON.stringify(l))
const body = lazy.map((l) => `  ${key(l)}: () => import("refractor/${l}"),`).join('\n')

writeFileSync('src/lib/prismLazyRegistry.ts', `\
// AUTO-GENERATED lazy Prism (refractor) grammar registry - see prism.ts for the
// eager set. Each entry code-splits into its own on-demand chunk so the diff
// viewer can colourise files in languages beyond the common eager set WITHOUT
// bundling them into the initial download - the grammar is fetched only when a
// file needs it.
//
// Regenerate after a refractor upgrade with scripts/gen-prism-registry.ts.
import type { Syntax } from 'refractor/core'

export const LAZY_LANGUAGES: Record<string, () => Promise<{ default: Syntax }>> = {
${body}
}

export const LAZY_LANGUAGE_ALIASES: Record<string, string[]> = ${JSON.stringify(lazyAliases, null, 2)}
`)
console.log(`eager ${eager.size} (incl. aliases and transitive deps), lazy ${lazy.length}`)
