import React, { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

interface InfoTooltipProps {
  title?: string
  children: React.ReactNode
}

export function InfoTooltip({ title, children }: InfoTooltipProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isTooltipHovered, setIsTooltipHovered] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0, arrowX: '50%' })
  const iconRef = useRef<SVGSVGElement>(null)
  const closeTimeoutRef = useRef<number | null>(null)

  const updateCoords = () => {
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const tooltipWidth = 384 // w-96
      const padding = 16

      let left = centerX
      if (left - tooltipWidth / 2 < padding) {
        left = tooltipWidth / 2 + padding
      } else if (left + tooltipWidth / 2 > window.innerWidth - padding) {
        left = window.innerWidth - tooltipWidth / 2 - padding
      }

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

  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        window.clearTimeout(closeTimeoutRef.current)
      }
    }
  }, [])

  const handleMouseEnterIcon = () => {
    if (closeTimeoutRef.current) {
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
    updateCoords()
    setIsOpen(true)
  }

  const handleMouseLeaveIcon = () => {
    closeTimeoutRef.current = window.setTimeout(() => {
      if (!isTooltipHovered) {
        setIsOpen(false)
      }
    }, 100)
  }

  const handleMouseEnterTooltip = () => {
    if (closeTimeoutRef.current) {
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
    setIsTooltipHovered(true)
  }

  const handleMouseLeaveTooltip = () => {
    setIsTooltipHovered(false)
    setIsOpen(false)
  }

  return (
    <div className="inline-block ml-1 align-middle">
      <Info
        ref={iconRef}
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help transition-colors"
        onMouseEnter={handleMouseEnterIcon}
        onMouseLeave={handleMouseLeaveIcon}
      />
      {isOpen && createPortal(
        <div
          className="fixed z-[9999] -translate-x-1/2 -translate-y-full w-96 p-3 bg-gray-900 dark:bg-gray-800 text-white text-[11px] rounded-lg shadow-xl animate-in fade-in zoom-in-95 duration-100 border border-gray-700"
          style={{
            top: coords.top - 8,
            left: coords.left,
            visibility: coords.top === 0 ? 'hidden' : 'visible'
          }}
          onMouseEnter={handleMouseEnterTooltip}
          onMouseLeave={handleMouseLeaveTooltip}
        >
          {title && <p className="font-bold mb-1.5 border-b border-gray-700 pb-1">{title}</p>}
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
