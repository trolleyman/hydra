import { useContext, useMemo } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RotateCw } from 'lucide-react'
import { ToastDismissContext } from '../stores/toastStore'
import { PHASE_LABEL, useServerUpdateStore } from '../stores/serverUpdateStore'
import { LogView } from './ArtifactLogView'
import { ArtifactLogLine } from '../api'

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

  // The build log is real terminal output - `mage` colours its command echoes and
  // the toolchains colour their diagnostics - so it goes through the same xterm
  // view the artifact and test build logs use rather than a stack of divs, which
  // would render the escape sequences as literal garbage. Reusing LogView also
  // brings scrollback, selection and follow-the-tail for free.
  //
  // Stdout and stderr are one interleaved stream on the server (ordering matters
  // more than which pipe a line came from), so every line is tagged stdout; the
  // failure itself is reported above the log, not by colouring a line inside it.
  const logLines = useMemo(
    () => lines.map((text) => ({ text, stream: ArtifactLogLine.stream.STDOUT })),
    [lines],
  )

  const failed = outcome === 'failed'
  // "Restarting" is still work in progress - the server is re-execing and the
  // page is waiting for it to answer again - but `running` went false the moment
  // the socket dropped, which is what re-execing looks like. Keying the spinner
  // off `running` alone therefore froze it exactly when there was most to wait
  // for. Only the two terminal outcomes stop it.
  const busy = running || outcome === 'restarting'
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
        ) : busy ? (
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
        <p className="mt-1 text-2xs text-gray-500 dark:text-gray-400">
          The server keeps running until the build succeeds.
        </p>
      )}

      {failed && (
        <p className="mt-1 text-2xs text-gray-500 dark:text-gray-400">
          Nothing was changed - the server is still running the previous build.
        </p>
      )}

      {lines.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1.5 flex items-center gap-1 text-2xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span className="optical-center">
              {expanded ? 'Hide' : 'Show'} build log ({lines.length} line{lines.length === 1 ? '' : 's'})
            </span>
          </button>
          {expanded && (
            <div className="mt-1.5">
              <LogView log={logLines} emptyText="Waiting for output..." failed={failed} />
            </div>
          )}
        </>
      )}

      {failed && (
        <button
          type="button"
          onClick={dismiss}
          className="mt-2 rounded px-2 py-1 text-2xs font-medium bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 cursor-pointer"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}
