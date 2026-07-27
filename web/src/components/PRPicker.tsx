import { useCallback, useEffect, useRef, useState } from 'react'
import { GitPullRequest, LoaderCircle, Lock, Search } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { ReviewRef } from '../api/models/ReviewRef'
import { Badge } from './Badge'
import { Tooltip } from './Tooltip'
import { ProviderIcon } from './ReviewControls'
import { formatError } from '../api/format_error'

// prStateTone maps a normalized PR state to a Badge tone (mirrors MRStateChip).
function prStateTone(state: string): 'green' | 'yellow' | 'violet' | 'neutral' {
  switch (state) {
    case 'merged':
      return 'violet'
    case 'open':
      return 'green'
    case 'draft':
      return 'yellow'
    default:
      return 'neutral'
  }
}

// PRPicker is the "spawn onto an existing PR" trigger + dropdown: an icon button
// that opens a list of the project's open PRs/MRs (from GET .../reviews) so one
// can be adopted as a head. Fixed-positioned + anchored to the trigger like
// AgentModelPicker, because the spawn card clips its content. On selection it
// calls onSelect with the chosen ReviewRef; the parent owns the "adopting"
// chip + spawn wiring (docs/pr-adoption.md).
export function PRPicker({
  projectId,
  onSelect,
  compact = false,
}: {
  projectId: string | null
  onSelect: (ref: ReviewRef) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [reviews, setReviews] = useState<ReviewRef[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    // Right-align the wide menu to the trigger so it doesn't overflow off-screen.
    if (r) setCoords({ left: Math.max(8, r.right - 340), top: r.bottom + 4 })
  }, [])

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setNotice(null)
    try {
      const res = await api.default.listReviews(projectId, 'open')
      setReviews(res.reviews)
      if (!res.configured) setNotice(res.error || 'No forge is configured for this project.')
      else if (res.authenticated === false) setNotice(res.auth_status || 'The forge CLI is not authenticated. Run `gh auth login` / `glab auth login`.')
      else if (res.error) setNotice(res.error)
      else if (res.reviews.length === 0) setNotice('No open pull requests found.')
    } catch (err) {
      setReviews([])
      setNotice(formatError(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!open) return
    // Deferred (not called synchronously in the effect) so its setState doesn't
    // cascade during the same render pass.
    const t = setTimeout(() => void load(), 0)
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, load, place])

  const filtered = (reviews ?? []).filter((r) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return r.title.toLowerCase().includes(q) || String(r.id).includes(q) || (r.author ?? '').toLowerCase().includes(q)
  })

  return (
    <div ref={ref} className="relative flex shrink-0">
      <Tooltip content="Work on an existing pull request" className="shrink-0">
        <button
          ref={btnRef}
          type="button"
          aria-label="Work on an existing pull request"
          onClick={() => { if (!open) place(); setOpen((o) => !o) }}
          className={`flex items-center gap-1 rounded-lg border transition-colors cursor-pointer ${
            compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'
          } ${
            open
              ? 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200'
              : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <GitPullRequest className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
          {!compact && <span>PR</span>}
        </button>
      </Tooltip>
      {open && coords && (
        <div
          style={{ position: 'fixed', left: coords.left, top: coords.top, width: 340 }}
          className="max-h-[22rem] overflow-hidden flex flex-col bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
            <Search className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter open pull requests..."
              className="w-full bg-transparent text-xs outline-none placeholder-gray-400"
            />
          </div>
          <div className="overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-gray-500">
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> Loading pull requests...
              </div>
            )}
            {!loading && notice && (
              <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words">{notice}</div>
            )}
            {!loading && filtered.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => { onSelect(r); setOpen(false) }}
                className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer border-b border-gray-50 dark:border-gray-700/50 last:border-0"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <ProviderIcon className="w-3 h-3 shrink-0 text-gray-400" />
                  <span className="text-[11px] text-gray-400 shrink-0">#{r.id}</span>
                  <span className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">{r.title}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <Badge tone={prStateTone(r.state)}>{r.state}</Badge>
                  {r.can_push === false && (
                    <Badge tone="yellow" icon={<Lock className="w-3 h-3" />} title="You cannot push to this PR (the author has not enabled maintainer edits). It can still be adopted read-only.">
                      read-only
                    </Badge>
                  )}
                  <span className="text-[11px] text-gray-400 font-mono truncate">
                    {r.target_branch} &lt;- {r.head_ref}
                  </span>
                  {r.author && <span className="text-[11px] text-gray-400">by {r.author}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
