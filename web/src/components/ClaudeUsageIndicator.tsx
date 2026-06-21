import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, Loader2 } from 'lucide-react'
import { api } from '../stores/apiClient'
import { startVisibilityPolling } from '../lib/visibilityPolling'
import { Tooltip } from './Tooltip'
import type { ClaudeUsageResponse } from '../api'

// The server caches the probed snapshot for ~30s; we poll in the background a
// bit slower than that so each poll generally gets a fresh probe, and clicking
// forces an immediate re-probe.
const POLL_MS = 60_000

// fmtCountdown renders a millisecond remaining-time as "2h 14m" / "14m" / "<1m".
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

// usedColor tints a percent-used value: calmer when there's headroom, hotter as
// the limit is approached.
function usedColor(used: number | null | undefined): string {
  if (used == null) return 'text-gray-400 dark:text-gray-500'
  if (used >= 90) return 'text-red-600 dark:text-red-400'
  if (used >= 75) return 'text-amber-600 dark:text-amber-400'
  return 'text-gray-600 dark:text-gray-300'
}

// ClaudeUsageIndicator shows Claude Code subscription usage in the header: time
// until the next session ("4 hour") reset, the session limit % used, and the
// weekly limit % used. It polls in the background and re-probes on click. It
// renders nothing when usage can't be determined (no subscription, CLI missing,
// non-localhost, etc.), so it stays out of the way when not applicable.
export function ClaudeUsageIndicator() {
  const [data, setData] = useState<ClaudeUsageResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [, setTick] = useState(0)
  const mounted = useRef(true)

  const fetchUsage = useCallback(async (force: boolean) => {
    setLoading(true)
    try {
      const res = await api.default.getClaudeUsage(force ? true : undefined)
      if (mounted.current) setData(res)
    } catch {
      // Keep the last good snapshot; transient errors shouldn't blank the UI.
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const stop = startVisibilityPolling(() => void fetchUsage(false), POLL_MS)
    return () => {
      mounted.current = false
      stop()
    }
  }, [fetchUsage])

  const resetsAt = data?.session_resets_at ? Date.parse(data.session_resets_at) : NaN

  // Tick once a second only while there's a live countdown to animate.
  useEffect(() => {
    if (Number.isNaN(resetsAt)) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [resetsAt])

  if (!data) return null
  const session = data.session_percent_used
  const weekly = data.weekly_percent_used
  // Probe ran but yielded no quota (e.g. API-billing account, CLI missing).
  if (!data.available && session == null && weekly == null) return null

  const countdown = !Number.isNaN(resetsAt)
    ? fmtCountdown(resetsAt - Date.now())
    : (data.session_reset_text ?? null)

  const tip = (
    <div className="text-xs leading-relaxed">
      <div className="font-semibold">{data.account_tier ?? 'Claude'} usage</div>
      {session != null && (
        <div>
          Session (4h): {Math.round(session)}% used
          {data.session_reset_text ? ` · ${data.session_reset_text}` : ''}
        </div>
      )}
      {weekly != null && (
        <div>
          This week: {Math.round(weekly)}% used
          {data.weekly_reset_text ? ` · ${data.weekly_reset_text}` : ''}
        </div>
      )}
      {data.error && <div className="text-amber-400">{data.error}</div>}
      {data.captured_at && (
        <div className="text-gray-400 mt-1">
          Updated {new Date(data.captured_at).toLocaleTimeString()}
        </div>
      )}
      <div className="text-gray-400">Click to refresh</div>
    </div>
  )

  return (
    <Tooltip content={tip}>
      <button
        onClick={() => fetchUsage(true)}
        disabled={loading}
        aria-label="Claude usage"
        className="hidden md:flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
        {countdown && <span className="tabular-nums">{countdown}</span>}
        {session != null && (
          <span className={usedColor(session)}>
            <span className="text-gray-400 dark:text-gray-500">4h</span> {Math.round(session)}%
          </span>
        )}
        {weekly != null && (
          <span className={usedColor(weekly)}>
            <span className="text-gray-400 dark:text-gray-500">wk</span> {Math.round(weekly)}%
          </span>
        )}
      </button>
    </Tooltip>
  )
}
