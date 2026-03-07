interface IconProps { className?: string }

export function XIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18L18 6M6 6l12 12"/>
    </svg>
  )
}
