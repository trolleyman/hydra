import { createFileRoute, Outlet, useLocation, useParams } from '@tanstack/react-router'
import { RepositoryView } from '../../components/RepositoryView'
import type { RepositorySearch } from './repository.$'

// The compare-diff search params (see repository.$.tsx) are validated here too so
// they survive and stay typed on the bare /project/X/repository URL, not just the
// deep splat form.
function validateSearch(search: Record<string, unknown>): RepositorySearch {
  const out: RepositorySearch = {}
  if (typeof search.compare === 'string' && search.compare) out.compare = search.compare
  if (typeof search.dfile === 'string' && search.dfile) out.dfile = search.dfile
  return out
}

// The repository browser. This parent route stays mounted for both the bare
// (/project/X/repository) and the deep (/project/X/repository/<ref>/<path>)
// URLs - the deep form is the splat child in repository.$.tsx, which renders
// nothing itself but keeps those URLs valid (PLAN.md #41f). Keeping a single
// mounted RepositoryView means clicking a file just updates the URL/params
// without remounting (and so without refetching the tree).
export const Route = createFileRoute('/project/$projectId/repository')({
  validateSearch,
  component: RepositoryPage,
})

function RepositoryPage() {
  const { projectId } = useParams({ from: '/project/$projectId/repository' })
  const { pathname } = useLocation()
  const prefix = `/project/${projectId}/repository/`
  const splat = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : ''
  return (
    <>
      <RepositoryView projectId={projectId} splat={splat} />
      <Outlet />
    </>
  )
}
