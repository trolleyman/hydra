interface IconProps { className?: string }

export function UpdateFromBaseIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17V11m0 0a3 3 0 110-6h4a3 3 0 110 6h-4zm0 0L8 7"/>
    </svg>
  )
}
