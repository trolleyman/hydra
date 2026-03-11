import { Link } from '@tanstack/react-router'
import { FileQuestion, Home, ArrowLeft } from 'lucide-react'

interface NotFoundProps {
  title?: string
  message?: string
  showHome?: boolean
  showBack?: boolean
  errorCode?: string
}

export function NotFound({
  title = 'Page Not Found',
  message = "The page you're looking for doesn't exist or has been moved.",
  showHome = true,
  showBack = true,
  errorCode = '404',
}: NotFoundProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full text-center">
        <div className="mb-6 inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-white dark:bg-gray-800 shadow-sm border border-gray-100 dark:border-gray-700">
          <FileQuestion className="w-10 h-10 text-blue-500" />
        </div>

        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3 tracking-tight">
          {title}
        </h1>

        <p className="text-gray-500 dark:text-gray-400 mb-8 leading-relaxed">
          {message}
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          {showBack && (
            <button
              onClick={() => window.history.back()}
              className="w-full sm:w-auto px-5 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Back
            </button>
          )}

          {showHome && (
            <Link
              to="/"
              className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <Home className="w-4 h-4" />
              Return Home
            </Link>
          )}
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-800">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Error Code: {errorCode}
          </p>
        </div>
      </div>
    </div>
  )
}
