import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Tooltip } from './Tooltip'

type HistoryUpdate = {
  location: { state: { __TSR_index: number } }
  action: { type: string }
}

export type DesktopNavigationHistory = {
  location: HistoryUpdate['location']
  subscribe: (callback: (update: HistoryUpdate) => void) => () => void
  back: () => void
  forward: () => void
}

// Native desktop windows do not have browser chrome, so the app bar supplies
// the missing history controls. TanStack numbers its history entries; retaining
// the highest known index lets Forward enable after Back while a new PUSH
// correctly discards the old forward branch.
export function DesktopHistoryControls({ history }: { history: DesktopNavigationHistory }) {
  const initialIndex = history.location.state.__TSR_index
  const [position, setPosition] = useState({ current: initialIndex, furthest: initialIndex })

  useEffect(() => history.subscribe(({ location, action }) => {
    const current = location.state.__TSR_index
    setPosition((previous) => ({
      current,
      furthest: action.type === 'PUSH' ? current : Math.max(previous.furthest, current),
    }))
  }), [history])

  const buttonClass =
    'w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:text-gray-300 dark:disabled:text-gray-600 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:cursor-default'

  return (
    <div className="shrink-0 flex items-center gap-0.5" aria-label="Navigation history">
      <Tooltip content="Back">
        <button
          type="button"
          aria-label="Back"
          disabled={position.current === 0}
          onClick={() => history.back()}
          className={buttonClass}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      </Tooltip>
      <Tooltip content="Forward">
        <button
          type="button"
          aria-label="Forward"
          disabled={position.current >= position.furthest}
          onClick={() => history.forward()}
          className={buttonClass}
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </Tooltip>
    </div>
  )
}
