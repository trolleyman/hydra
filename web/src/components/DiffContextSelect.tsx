import { DIFF_CONTEXT_OPTIONS, parseDiffContextLines, type DiffContextLines } from '../lib/diffPrefs'

export function DiffContextSelect({
  value,
  onChange,
  className = '',
}: {
  value: DiffContextLines
  onChange: (value: DiffContextLines) => void
  className?: string
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${className}`}>
      <span className="text-xs text-gray-700 dark:text-gray-300">Context lines:</span>
      <select
        value={value}
        onChange={(event) => onChange(parseDiffContextLines(event.target.value))}
        aria-label="Context lines"
        className="h-7 min-w-14 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-1.5 text-xs text-gray-700 dark:text-gray-200 cursor-pointer"
      >
        {DIFF_CONTEXT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}
