import { createRouter } from '@tanstack/react-router'
import { routeTree } from '../src/routeTree.gen'
import fs from 'node:fs/promises'

const router = createRouter({ routeTree })

// routesByPath keys are the actual route paths (e.g., '/', '/about', '/users/$userId')
const validPaths = Object.keys(router.routesByPath).filter(
  // Filter out internal root paths or pathless layout routes
  (path) => path !== '__root__' && !path.includes('_')
)

const pathPatterns = validPaths.map((path) => {
  // Escape standard regex characters to treat them literally in the final regex
  let pattern = path.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

  // Replace TanStack named parameters (e.g., \/$userId) with a regex matching any single path segment
  pattern = pattern.replace(/\\\$[a-zA-Z0-9_]+/g, '[^/]+')

  // Replace TanStack catch-all splats (e.g., \/$) with a wildcard match
  pattern = pattern.replace(/\\\$/g, '.*')

  return `^${pattern}$`
})

// Combine all individual patterns into a single OR group
const masterRegex = `(?:${pathPatterns.join('|')})`

console.log('--- Generated Regex for Go ---')
console.log(masterRegex)

console.log('--- Saving to routes-regex.txt ---')
await fs.writeFile('scripts/routes-regex.txt', masterRegex)
console.log('--- Done ---')
