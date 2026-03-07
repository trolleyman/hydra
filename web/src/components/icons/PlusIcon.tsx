interface IconProps { className?: string }

export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5v14"/>
    </svg>
  )
}
