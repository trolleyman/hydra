import React, { useEffect } from 'react'
import { AlertCircle, Info, HelpCircle, X } from 'lucide-react'
import { useDialogStore } from '../stores/dialogStore'

export const Dialog: React.FC = () => {
  const { isOpen, title, message, type, showCancel, hide, onConfirm, onCancel } = useDialogStore()

  // Handle escape key to close the dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const getIcon = () => {
    switch (type) {
      case 'error':
        return <AlertCircle className="w-6 h-6 text-red-500" />
      case 'warning':
        return <AlertCircle className="w-6 h-6 text-amber-500" />
      case 'confirm':
        return <HelpCircle className="w-6 h-6 text-blue-500" />
      case 'info':
      default:
        return <Info className="w-6 h-6 text-blue-500" />
    }
  }

  const handleConfirm = () => {
    if (onConfirm) onConfirm()
    hide()
  }

  const handleCancel = () => {
    if (onCancel) onCancel()
    hide()
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-3">
            {getIcon()}
            <h3 id="dialog-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h3>
          </div>
          <button 
            onClick={handleCancel}
            className="p-1 rounded-md text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="px-6 py-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
            {message}
          </p>
        </div>
        
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-3">
          {(showCancel || type === 'confirm') && (
            <button
              onClick={handleCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              type === 'error' 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {type === 'confirm' ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
