import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useProjectStore } from '../stores/projectStore'

export const Route = createFileRoute('/')({
  component: RootRedirect,
})

function RootRedirect() {
  const { selectedProjectId } = useProjectStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (selectedProjectId) {
      navigate({ to: '/project/$projectId', params: { projectId: selectedProjectId }, replace: true })
    }
  }, [selectedProjectId, navigate])

  return (
    <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
      {selectedProjectId ? 'Redirecting...' : 'Select a project to get started'}
    </div>
  )
}
