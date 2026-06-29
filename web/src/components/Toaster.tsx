import React from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore, type ToastType } from '../stores/toastStore'
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

export const Toaster: React.FC = () => {
  const { toasts, dismiss } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 max-w-sm animate-in slide-in-from-right-4 fade-in duration-200"
        >
          {getIcon(toast.type)}
          <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{toast.message}</p>
          <IconButton onClick={() => dismiss(toast.id)}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
