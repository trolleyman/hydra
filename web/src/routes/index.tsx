import { createFileRoute, redirect } from '@tanstack/react-router'
import { useProjectStore } from '../stores/projectStore'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { lastProjectId, fetchProjects } = useProjectStore.getState()
    await fetchProjects()
    const { projects } = useProjectStore.getState()

    if (lastProjectId && projects.some((p) => p.id === lastProjectId)) {
      throw redirect({ to: '/$projectId', params: { projectId: lastProjectId } })
    }
    if (projects.length > 0) {
      throw redirect({ to: '/$projectId', params: { projectId: projects[0].id } })
    }
    throw redirect({ to: '/new-project' })
  },
  component: () => null,
})
