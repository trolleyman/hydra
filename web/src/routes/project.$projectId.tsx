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
  const { setSelectedProjectId } = useProjectStore()

  // Sync URL projectId to store so other components can read it.
  useEffect(() => {
    setSelectedProjectId(projectId)
  }, [projectId, setSelectedProjectId])

  return <Outlet />
}
