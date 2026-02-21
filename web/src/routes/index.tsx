import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return (
    <div className="p-6 max-w-2xl mx-auto bg-white rounded-xl shadow-md space-y-4">
      <h1 className="text-3xl font-bold text-gray-800">Welcome Home</h1>
      <p className="text-gray-600">
        This is your index route, styled with Tailwind CSS.
      </p>
    </div>
  )
}