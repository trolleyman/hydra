import React, { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

interface InfoTooltipProps {
  title: string
  children: React.ReactNode
}

export function InfoTooltip({ title, children }: InfoTooltipProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0, arrowX: '50%' })
  const iconRef = useRef<SVGSVGElement>(null)

  const updateCoords = () => {
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const tooltipWidth = 320 // w-80
      const padding = 16
      
      let left = centerX
      if (left - tooltipWidth / 2 < padding) {
        left = tooltipWidth / 2 + padding
      } else if (left + tooltipWidth / 2 > window.innerWidth - padding) {
        left = window.innerWidth - tooltipWidth / 2 - padding
      }

      // Calculate arrow position relative to the tooltip center
      // left is the center of the tooltip in viewport coords
      // centerX is the center of the icon in viewport coords
      // arrowOffset is how much the icon is offset from the tooltip center
      const arrowOffset = centerX - left
      
      setCoords({
        top: rect.top,
        left: left,
        arrowX: `calc(50% + ${arrowOffset}px)`
      })
    }
  }

  useLayoutEffect(() => {
    if (isOpen) {
      updateCoords()
      window.addEventListener('scroll', updateCoords, true)
      window.addEventListener('resize', updateCoords)
    }
    return () => {
      window.removeEventListener('scroll', updateCoords, true)
      window.removeEventListener('resize', updateCoords)
    }
  }, [isOpen])

  return (
    <div className="inline-block ml-1 align-middle">
      <Info 
        ref={iconRef}
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors" 
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      />
      {isOpen && createPortal(
        <div 
          className="fixed z-[9999] -translate-x-1/2 -translate-y-full w-80 p-3 bg-gray-900 dark:bg-gray-800 text-white text-[11px] rounded-lg shadow-xl pointer-events-none animate-in fade-in zoom-in-95 duration-100 border border-gray-700"
          style={{ 
            top: coords.top - 8, 
            left: coords.left 
          }}
        >
          <p className="font-bold mb-1.5 border-b border-gray-700 pb-1">{title}</p>
          <div className="text-gray-300 space-y-2">
            {children}
          </div>
          {/* Arrow */}
          <div 
            className="absolute top-full -translate-x-1/2 border-8 border-transparent border-t-gray-900 dark:border-t-gray-800" 
            style={{ left: coords.arrowX }}
          />
        </div>,
        document.body
      )}
    </div>
  )
}
