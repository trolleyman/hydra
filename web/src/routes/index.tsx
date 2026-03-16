import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: RootPage,
})

function RootPage() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
      Select a project to get started
    </div>
  )
}
