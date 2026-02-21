import { createRootRoute, Outlet, useParams } from '@tanstack/react-router'
import { ProjectPicker } from '../components/ProjectPicker'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">404</h1>
        <p className="text-gray-500">Page not found</p>
      </div>
    </div>
  ),
})

function RootLayout() {
  // Extract projectId from any matched route (non-strict = reads from any active route)
  const { projectId: currentProjectId } = useParams({ strict: false })

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white font-bold text-xs">H</span>
          </div>
          <span className="font-semibold text-gray-900">Hydra</span>
        </div>
        <div className="w-px h-5 bg-gray-200" />
        <ProjectPicker currentProjectId={currentProjectId} />
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
