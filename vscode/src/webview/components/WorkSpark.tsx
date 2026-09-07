import React from 'react'

const angles = [0, 60, 120, 180, 240, 300]

export function WorkSpark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" className="work-spark size-5 shrink-0 text-[var(--hydra-accent)]">{angles.map((angle, index) => {
    const long = index % 2 === 0
    return <g key={angle} transform={`rotate(${angle} 12 12)`}><line x1="12" y1={long ? 3.3 : 5.7} x2="12" y2="9.2" stroke="currentColor" strokeWidth={long ? 2.1 : 1.7} strokeLinecap="round" className="work-spark-spoke" style={{ animationDelay: `${(-(angles.length - 1 - index) * 0.22).toFixed(2)}s` }} /></g>
  })}</svg>
}
