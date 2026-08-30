import type { ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  disabled?: boolean
}

// A compact one-of-many selector for application controls such as Terminal / Chat,
// Worktree / Project checkout, and Edit / Read-only. These choices all have the
// same semantics, so their keyboard/accessibility and visual treatment belong in
// one component rather than in hand-built pairs of buttons.
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className = '',
}: {
  value: T
  options: SegmentedControlOption<T>[]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={`inline-flex h-7 items-center overflow-hidden rounded-lg border border-gray-200 text-xs dark:border-gray-600 ${className}`}>
      {options.map((option, index) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex h-full items-center gap-1.5 px-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${index > 0 ? 'border-l border-gray-200 dark:border-gray-600' : ''} ${active
              ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300'
              : 'cursor-pointer text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            {option.icon}
            <span className="whitespace-nowrap optical-center">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
