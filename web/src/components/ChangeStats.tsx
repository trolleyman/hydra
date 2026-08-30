export function ChangeStats({
  additions,
  deletions,
  className = '',
}: {
  additions?: number | null
  deletions?: number | null
  className?: string
}) {
  const showAdditions = additions != null && additions > 0
  const showDeletions = deletions != null && deletions > 0
  if (!showAdditions && !showDeletions) return null

  const label = [
    showAdditions ? `${additions} lines added` : null,
    showDeletions ? `${deletions} lines removed` : null,
  ].filter(Boolean).join(', ')

  return (
    <span
      className={`inline-flex shrink-0 items-baseline gap-1 font-mono text-2xs ${className}`}
      aria-label={label}
    >
      {showAdditions && <span className="text-green-600 dark:text-green-400">+{additions}</span>}
      {showDeletions && <span className="text-red-600 dark:text-red-400">-{deletions}</span>}
    </span>
  )
}
