import React, { useState } from 'react'
import { Info } from 'lucide-react'

interface InfoTooltipProps {
  title: string
  children: React.ReactNode
}

export function InfoTooltip({ title, children }: InfoTooltipProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative inline-block ml-1 align-middle group">
      <Info 
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors" 
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      />
      {isOpen && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 p-3 bg-gray-900 dark:bg-gray-800 text-white text-[11px] rounded-lg shadow-xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 border border-gray-700">
          <p className="font-bold mb-1.5 border-b border-gray-700 pb-1">{title}</p>
          <div className="text-gray-300 space-y-2">
            {children}
          </div>
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-gray-900 dark:border-t-gray-800" />
        </div>
      )}
    </div>
  )
}
