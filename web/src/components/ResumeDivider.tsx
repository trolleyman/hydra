import { RelativeTime } from './LiveTime'
import { Tooltip } from './Tooltip'

export function ResumeDivider({
  resumedAt,
  label = 'Resumed',
  ariaLabel = 'Agent resumed',
}: {
  resumedAt?: number
  label?: string
  ariaLabel?: string
}) {
  const labelNode = (
    <span className="optical-center text-2xs text-stone-400 dark:text-stone-500">
      {label}{resumedAt == null ? null : <> <RelativeTime createdAt={resumedAt / 1000} /></>}
    </span>
  )
  return (
    <div className="flex items-center gap-2.5 select-none" aria-label={ariaLabel}>
      <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
      {resumedAt == null ? labelNode : (
        <Tooltip content={new Date(resumedAt).toLocaleString()}>
          {labelNode}
        </Tooltip>
      )}
      <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
    </div>
  )
}
