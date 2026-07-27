import { createFileRoute } from '@tanstack/react-router'

// Search params carried by the repository compare-diff so a selection is
// deep-linkable: `compare` is the head ref being diffed against
// the browsed ref (its presence turns on diff mode); `dfile` is the selected
// file in the one-file-at-a-time view. The line selection itself rides the URL
// hash (#L<n> old side / #R<n> new side). All optional - absent means normal
// file browsing.
export type RepositorySearch = { compare?: string; dfile?: string }

function validateSearch(search: Record<string, unknown>): RepositorySearch {
  const out: RepositorySearch = {}
  if (typeof search.compare === 'string' && search.compare) out.compare = search.compare
  if (typeof search.dfile === 'string' && search.dfile) out.dfile = search.dfile
  return out
}

// Splat route for deep repository URLs (/project/X/repository/<ref>/<path...>).
// It renders nothing - the parent repository route reads the path from the URL
// and renders the browser - but it must exist so these URLs are valid routes
// (and are served on a hard refresh; see web/scripts/generate-routes-regex.ts).
export const Route = createFileRoute('/project/$projectId/repository/$')({
  validateSearch,
  component: () => null,
})
