import { useContext, useEffect, useRef } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RotateCw } from 'lucide-react'
import { ToastDismissContext } from '../stores/toastStore'
import { PHASE_LABEL, useServerUpdateStore } from '../stores/serverUpdateStore'

// ServerUpdateToast is the body of the persistent toast shown while the server
// rebuilds and restarts itself. It reads the update store directly rather than
// taking props, so the toast is shown once and then follows the stream on its
// own - the store is the only thing re-rendering as several hundred build lines
// arrive.
//
// The log is collapsed by default (a rebuild is normally something you want to
// know is happening, not something you want to read) and opens itself on
// failure, which is the case you do have to read.
export function ServerUpdateToast() {
  const { running, phase, lines, error, outcome, restartOnly, expanded, setExpanded } =
    useServerUpdateStore()
  const dismiss = useContext(ToastDismissContext)
  const logRef = useRef<HTMLDivElement>(null)

  // Follow the tail while it streams, but only when the user is already at the
  // bottom - scrolling up to read an error should not be yanked back.
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [lines, expanded])

  const failed = outcome === 'failed'
  const title = failed
    ? 'Update failed'
    : outcome === 'restarting'
      ? 'Restarting...'
      : outcome === 'done'
        ? 'Update finished'
        : restartOnly
          ? 'Restarting the server...'
          : phase
            ? `${PHASE_LABEL[phase]}...`
            : 'Starting the update...'

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {failed ? (
          <AlertTriangle className="w-4 h-4 shrink-0 text-red-500" />
        ) : running ? (
          <Loader2 className="w-4 h-4 shrink-0 animate-spin text-blue-500" />
        ) : (
          <RotateCw className="w-4 h-4 shrink-0 text-blue-500" />
        )}
        <span className="optical-center font-medium">{title}</span>
      </div>

      {failed && error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">{error}</p>
      )}

      {!failed && !restartOnly && running && (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          The server keeps running until the build succeeds.
        </p>
      )}

      {failed && (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Nothing was changed - the server is still running the previous build.
        </p>
      )}

      {lines.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span className="optical-center">
              {expanded ? 'Hide' : 'Show'} build log ({lines.length} line{lines.length === 1 ? '' : 's'})
            </span>
          </button>
          {expanded && (
            <div
              ref={logRef}
              className="mt-1.5 max-h-48 overflow-auto rounded bg-gray-900 dark:bg-black/50 p-2 font-mono text-[10px] leading-4 text-gray-200 whitespace-pre-wrap break-words"
            >
              {lines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </>
      )}

      {failed && (
        <button
          type="button"
          onClick={dismiss}
          className="mt-2 rounded px-2 py-1 text-[11px] font-medium bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 cursor-pointer"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}
