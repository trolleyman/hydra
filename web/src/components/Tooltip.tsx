import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  delay?: number
  side?: 'top' | 'bottom'
  className?: string
}

export function Tooltip({ content, children, delay = 600, side, className }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(null)
  const timerRef = useRef<number | null>(null)
  const wrapperRef = useRef<HTMLSpanElement>(null)

  const show = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const padding = 8
    const tooltipHeight = 36
    const placement = side ?? (rect.top < tooltipHeight + padding ? 'bottom' : 'top')
    setPos({
      top: placement === 'top' ? rect.top - padding : rect.bottom + padding,
      left: rect.left + rect.width / 2,
      placement,
    })
    setVisible(true)
  }, [side])

  const handleMouseEnter = useCallback(() => {
    timerRef.current = window.setTimeout(show, delay)
  }, [delay, show])

  const handleMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
  }, [])

  return (
    <span
      ref={wrapperRef}
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && pos && content && createPortal(
        <div
          className={`fixed z-[9999] -translate-x-1/2 pointer-events-none px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-[11px] rounded shadow-lg whitespace-nowrap border border-gray-700 dark:border-gray-600 ${
            pos.placement === 'top' ? '-translate-y-full' : ''
          }`}
          style={{ top: pos.top, left: pos.left }}
        >
          {content}
          <div
            className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${
              pos.placement === 'top'
                ? 'top-full border-t-gray-900 dark:border-t-gray-700'
                : 'bottom-full border-b-gray-900 dark:border-b-gray-700'
            }`}
          />
        </div>,
        document.body,
      )}
    </span>
  )
}
