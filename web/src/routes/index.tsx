import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: RootPage,
})

// "/" is a redirect, not a destination: RootLayout sends you to the last project
// you had open, or to the built-in scratch project when there is nothing to
// restore. This renders only for the moment before that runs - and permanently
// only in the degraded case where the scratch project failed to bootstrap
// server-side, which is why the copy still tells you what to do.
function RootPage() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
      Select a project to get started
    </div>
  )
}
