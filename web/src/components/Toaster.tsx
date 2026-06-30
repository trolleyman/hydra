import React from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore, type Toast, type ToastType } from '../stores/toastStore'
import { IconButton } from './IconButton'

const getIcon = (type: ToastType) => {
  switch (type) {
    case 'success':
      return <CheckCircle className="w-5 h-5 text-green-500" />
    case 'error':
      return <AlertCircle className="w-5 h-5 text-red-500" />
    case 'warning':
      return <AlertCircle className="w-5 h-5 text-amber-500" />
    case 'info':
    default:
      return <Info className="w-5 h-5 text-blue-500" />
  }
}

// Countdown-bar colour, matched to the icon tint for each type.
const getBarColor = (type: ToastType) => {
  switch (type) {
    case 'success':
      return 'bg-green-500'
    case 'error':
      return 'bg-red-500'
    case 'warning':
      return 'bg-amber-500'
    case 'info':
    default:
      return 'bg-blue-500'
  }
}

// Per-variant button styling for a toast action.
const actionClass = (variant?: 'primary' | 'danger') => {
  const base = 'text-xs px-2.5 py-1 rounded font-medium transition-colors'
  switch (variant) {
    case 'primary':
      return `${base} bg-blue-600 hover:bg-blue-500 text-white`
    case 'danger':
      return `${base} bg-red-600 hover:bg-red-500 text-white`
    default:
      return `${base} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200`
  }
}

const ToastItem: React.FC<{ toast: Toast; onDismiss: () => void }> = ({ toast, onDismiss }) => {
  // Only auto-expiring toasts (duration > 0) get a countdown bar, and it's hidden
  // once the toast starts leaving so it doesn't redraw during the exit animation.
  const showCountdown = toast.duration > 0 && !toast.exiting
  return (
    <div
      role="status"
      className={`relative overflow-hidden flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 max-w-sm ${
        toast.exiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      <div className="mt-0.5">{getIcon(toast.type)}</div>
      <div className="flex flex-col gap-2 min-w-0">
        <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{toast.message}</p>
        {toast.actions && toast.actions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {toast.actions.map((action) => (
              <button
                key={action.label}
                onClick={() => action.onClick(toast.id)}
                className={actionClass(action.variant)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <IconButton onClick={onDismiss}>
        <X className="w-4 h-4" />
      </IconButton>
      {showCountdown && (
        <div
          className={`toast-progress-bar absolute bottom-0 left-0 h-0.5 w-full opacity-60 ${getBarColor(toast.type)}`}
          style={{ animationDuration: `${toast.duration}ms` }}
        />
      )}
    </div>
  )
}

export const Toaster: React.FC = () => {
  const { toasts, dismiss } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}
