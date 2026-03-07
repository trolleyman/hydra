interface IconProps { className?: string }

export function MergeIcon({ className }: IconProps) {
  return (
    <svg className={className ?? "w-4 h-4"} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 11V5m0 6a3 3 0 100 6h4a3 3 0 100-6h-4zm0 0l4 4"/>
    </svg>
  )
}
