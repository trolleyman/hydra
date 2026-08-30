import { useEffect, useState } from 'react'
import { api } from '../stores/apiClient'
import { useServerData } from '../lib/useServerData'
import { Tooltip } from './Tooltip'
import type { ClaudeUsageResponse, CodexUsageResponse } from '../api'

// Behind this endpoint is a real Claude CLI launched under a PTY, so the polling
// here is deliberately slack: the server serves a cached snapshot for ~10 minutes
// and only re-probes when a poll arrives after that, so a 5-minute poll costs one
// cheap JSON round-trip and, at worst, one probe per 10 minutes. Quota moves over
// hours - there is nothing to gain from asking faster. The poll is also paused
// while the tab is hidden (useServerData), and clicking forces a re-probe.
const POLL_MS = 5 * 60_000
// Claude can take a moment to roll the usage window over. Probe just after the
// advertised boundary, then retry at the server's forced-probe cadence if the
// returned snapshot still names the old reset. A new resetsAt value tears this
// schedule down through the effect dependency below.
const RESET_REFRESH_GRACE_MS = 5_000
const RESET_REFRESH_RETRY_MS = 31_000
const RESET_REFRESH_ATTEMPTS = 4

// fmtCountdown renders a millisecond remaining-time as "2d 2h 14m" / "2h 14m" /
// "14m" / "<1m".
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / (24 * 60))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h % 24}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

// remainingColor tints remaining capacity: calmer when there's headroom, hotter
// as the limit approaches.
function remainingColor(remaining: number | null | undefined): string {
	if (remaining == null) return 'text-gray-400 dark:text-gray-500'
	if (remaining <= 10) return 'text-red-600 dark:text-red-400'
	if (remaining <= 25) return 'text-amber-600 dark:text-amber-400'
	return 'text-gray-600 dark:text-gray-300'
}

function remaining(used: number | null | undefined): number | null {
	return used == null ? null : Math.max(0, Math.min(100, 100 - used))
}

function withoutTimezone(text: string): string {
	return text.replace(/\s+\([A-Za-z_]+\/[A-Za-z_]+\)\s*$/, '')
}

// One usage column: a small grey label over its value (e.g. "reset" / "2h 15m"),
// so the three stats line up as a compact mini-table in the sidebar footer.
function UsageStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <span className="flex min-w-0 flex-col items-start leading-tight">
      <span className="text-3xs text-gray-400 dark:text-gray-500">{label}</span>
      <span className={`max-w-full truncate tabular-nums ${valueClass ?? 'text-gray-600 dark:text-gray-300'}`}>{value}</span>
    </span>
  )
}

// UsageIndicator shows the selected chat provider's subscription usage in the
// sidebar footer. It only supports Claude and Codex: other agent types retain
// the last relevant provider so the footer does not flicker away while browsing.
export function ClaudeUsageIndicator({ agentType }: { agentType: 'claude' | 'codex' }) {
  // Current wall-clock time, refreshed by the countdown ticker below. Held in
  // state (rather than reading Date.now() during render) so render stays pure.
  const [now, setNow] = useState(() => Date.now())
  // Background poll (force=false → uses the server's ~30s cache); a click forces
  // a fresh re-probe. Transient errors keep the last good snapshot (no resetOnError).
  const { data, refetch: fetchUsage, loading } = useServerData<ClaudeUsageResponse | CodexUsageResponse | null, boolean>(
    `${agentType}-usage`,
    (_key, force) => agentType === 'codex'
      ? api.default.getCodexUsage(force ? true : undefined)
      : api.default.getClaudeUsage(force ? true : undefined),
    { intervalMs: POLL_MS, initial: null },
  )

  const resetsAt = data?.session_resets_at ? Date.parse(data.session_resets_at) : NaN

  // Tick once a second only while there's a live countdown to animate.
  useEffect(() => {
    if (Number.isNaN(resetsAt)) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [resetsAt])

  // The regular poll is intentionally relaxed, but that leaves an old, often
  // nearly-full usage value visible after its known reset. Force a few probes
  // around that boundary instead of waiting for the normal cache to expire.
  useEffect(() => {
    if (Number.isNaN(resetsAt)) return

    let attempts = 0
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      fetchUsage(true)
      attempts += 1
      if (attempts < RESET_REFRESH_ATTEMPTS) {
        timer = setTimeout(refresh, RESET_REFRESH_RETRY_MS)
      }
    }
    timer = setTimeout(refresh, Math.max(0, resetsAt + RESET_REFRESH_GRACE_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [fetchUsage, resetsAt])

  if (!data) return null
  const session = remaining(data.session_percent_used)
  const weekly = remaining(data.weekly_percent_used)
  // Probe ran but yielded no quota (e.g. API-billing account, CLI missing).
  if (!data.available && session == null && weekly == null) return null

  const rawReset = !Number.isNaN(resetsAt)
    ? fmtCountdown(resetsAt - now)
    : (agentType === 'claude' ? (data.session_reset_text ?? null) : null)
  // Strip the leading "Resets [in] ..." so only the value sits under the "reset"
  // label (the live countdown path is already bare; this normalizes the text
  // fallback, which the CLI writes either as a countdown - "Resets in 2h 15m" -
  // or as a wall clock time, "Resets 3:10pm (Europe/London)").
  const countdown = rawReset ? withoutTimezone(rawReset.replace(/^resets?\s+(in\s+)?/i, '')) : null

  const tip = (
    <div className="text-xs leading-relaxed">
      <div className="font-semibold">{agentType === 'codex' ? 'Codex' : 'Claude'} usage</div>
      {session != null && (
        <div>
          Session: {Math.round(session)}% left
          {data.session_reset_text && agentType === 'claude' ? ` · ${withoutTimezone(data.session_reset_text)}` : ''}
        </div>
      )}
      {weekly != null && (
        <div>
          Week: {Math.round(weekly)}% left
          {data.weekly_reset_text && agentType === 'claude' ? ` · ${withoutTimezone(data.weekly_reset_text)}` : ''}
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
        aria-label={`${agentType === 'codex' ? 'Codex' : 'Claude'} usage`}
        // The marker the sidebar footer's `group-has-[[data-usage]]` looks for:
        // this component renders nothing at all when usage can't be determined,
        // so its presence in the DOM is the honest answer to "is the strip
        // taking up the footer's right-hand side" - no second poll, no state
        // lifted out of here to say so.
        data-usage=""
        className="flex min-w-0 items-start gap-1.5 text-xs px-1 py-0.5 rounded-md cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-60"
      >
        {countdown && <UsageStat label="reset" value={countdown} />}
        {session != null && <UsageStat label={agentType === 'codex' ? (data.session_reset_text ?? 'limit') : '4h'} value={`${Math.round(session)}%`} valueClass={remainingColor(session)} />}
        {weekly != null && <UsageStat label={agentType === 'codex' ? (data.weekly_reset_text ?? 'week') : 'wk'} value={`${Math.round(weekly)}%`} valueClass={remainingColor(weekly)} />}
      </button>
    </Tooltip>
  )
}
