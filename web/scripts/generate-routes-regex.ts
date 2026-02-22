/// <reference types="node" />
// Parses routeTree.gen.ts to extract route paths and generates a combined regex.
// This avoids loading React/browser dependencies at build time.
// Run directly with: bun scripts/generate-routes-regex.ts (from web/ directory)
import fs from 'fs/promises'

const source = await fs.readFile('src/routeTree.gen.ts', 'utf-8')

// Extract path: '...' strings from the route tree file
const pathMatches = [...source.matchAll(/path:\s*'([^']+)'/g)]
const rawPaths = pathMatches.map((m) => m[1])

// Deduplicate and filter internal paths
const validPaths = [...new Set(rawPaths)].filter(
  (p) => p !== '__root__' && !p.startsWith('/_'),
)

console.log('--- Generating path patterns ---')
const pathPatterns = validPaths.map((p) => {
  // Escape standard regex characters (but not $ which we handle specially)
  let pattern = p.replace(/[-/\\^*+?.()|[\]{}]/g, '\\$&')

  // Replace TanStack named parameters like $projectId with [^/]+
  pattern = pattern.replace(/\$[a-zA-Z0-9_]+/g, '[^/]+')

  // Replace remaining catch-all $ with .*
  pattern = pattern.replace(/\$/g, '.*')

  pattern = `^${pattern}$`
  console.log(`'${p}' -> '${pattern}'`)
  return pattern
})

console.log('--- Generated regex ---')
const masterRegex = `(?:${pathPatterns.join('|')})`
console.log(masterRegex)

console.log('--- Saving to routes-regex.txt ---')
await fs.writeFile('scripts/routes-regex.txt', masterRegex)
console.log('--- Done ---')
