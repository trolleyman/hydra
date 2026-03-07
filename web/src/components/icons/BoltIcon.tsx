interface IconProps { className?: string }

export function BoltIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
    </svg>
  )
}
