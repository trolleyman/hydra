interface IconProps { className?: string }

export function FileAddedIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-3 h-3"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v16m8-8H4"/>
    </svg>
  )
}
