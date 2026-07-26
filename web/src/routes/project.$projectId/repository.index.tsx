import { createFileRoute } from '@tanstack/react-router'
import type { RepositorySearch } from './repository.$'

// Index route for the bare repository URL (/project/X/repository). Like the
// splat child (repository.$.tsx) it renders nothing - the parent repository
// route reads the path from the URL and renders the browser. It exists purely
// to give the empty path its own terminal match: without it, the catch-all
// splat `$` also matches the zero-segment case, so navigating to the bare URL
// resolves to the splat route and TanStack Router logs a "multiple route
// templates resolve to the same URL" warning. The index route claims the empty
// case unambiguously, silencing that warning.
function validateSearch(search: Record<string, unknown>): RepositorySearch {
  const out: RepositorySearch = {}
  if (typeof search.compare === 'string' && search.compare) out.compare = search.compare
  if (typeof search.dfile === 'string' && search.dfile) out.dfile = search.dfile
  return out
}

export const Route = createFileRoute('/project/$projectId/repository/')({
  validateSearch,
  component: () => null,
})
