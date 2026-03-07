interface IconProps { className?: string }

export function ChevronLeftIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 19-7-7 7-7"/>
    </svg>
  )
}
