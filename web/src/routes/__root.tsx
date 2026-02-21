import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="flex items-center gap-4 p-4 bg-white shadow-sm">
        <Link
          to="/"
          className="font-medium hover:text-blue-600 [&.active]:text-blue-600 [&.active]:font-bold"
        >
          Home
        </Link>
        <Link
          to="/about"
          className="font-medium hover:text-blue-600 [&.active]:text-blue-600 [&.active]:font-bold"
        >
          About
        </Link>
      </nav>

      <main className="p-4">
        <Outlet />
      </main>
    </div>
  ),
//   notFoundComponent: () => {
//     <div>NOT FOUND NOT FOUND 123123</div>
//   }
})