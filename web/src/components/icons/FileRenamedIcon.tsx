interface IconProps { className?: string }

export function FileRenamedIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-3 h-3"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 7l10 10M17 7v10H7"/>
    </svg>
  )
}
