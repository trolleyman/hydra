import { createFileRoute, Outlet, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { NotFound } from '../components/NotFound'

export const Route = createFileRoute('/project/$projectId')({
  component: ProjectLayout,
  notFoundComponent: () => <NotFound />,
})

function ProjectLayout() {
  const { projectId } = useParams({ from: '/project/$projectId' })
  // Selector, not a whole-store subscribe: this layout wraps every project
  // page, so re-rendering it re-renders the whole route subtree.
  const setSelectedProjectId = useProjectStore((s) => s.setSelectedProjectId)

  // Sync URL projectId to store so other components can read it.
  useEffect(() => {
    setSelectedProjectId(projectId)
  }, [projectId, setSelectedProjectId])

  return <Outlet />
}
