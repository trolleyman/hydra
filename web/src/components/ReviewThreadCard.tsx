import { useState } from 'react'
import { Check, EllipsisVertical, ExternalLink, Laptop, LoaderCircle, MessageSquare, Sparkles } from 'lucide-react'
import type { ReviewThread, ReviewThreadNote } from '../api'
import { Markdown } from '../lib/MarkdownRenderer'
import { Tooltip } from './Tooltip'
import { ProviderIcon } from './ReviewControls'
import { formatStartedAgo } from '../lib/agentDisplay'

// The actions a thread card can perform, supplied by the diff viewer through
// context (see reviewThreadContext) so the memo'd hunks between them never need
// to thread these props through.
export interface ReviewThreadActions {
  // provider drives the origin badge on forge notes ("github" | "gitlab").
  provider?: string
  // reply posts to the forge as the user; replyLocal keeps the note inside Hydra.
  reply: (threadId: string, body: string) => Promise<void>
  replyLocal: (threadId: string, body: string) => Promise<void>
  // commentOnLine starts a NEW thread on the PR from the diff's comment box.
  commentOnLine: (path: string, line: number, body: string) => Promise<void>
  // resolveWithAgent asks the head to address this thread (an agent-pull prompt,
  // the same pattern as "Fix the merge conflicts").
  resolveWithAgent: (thread: ReviewThread) => Promise<void>
}

// noteAgo renders a note's timestamp as "3h ago". An unparseable/absent stamp
// renders nothing rather than "NaN ago".
function noteAgo(createdAt?: string): string {
  if (!createdAt) return ''
  const ms = Date.parse(createdAt)
  if (Number.isNaN(ms)) return ''
  return formatStartedAgo(ms / 1000)
}

// OriginBadge says where a note lives: on the forge for everyone to see, or only
// in Hydra. It sits at the top right of the note it describes - a thread can mix
// the two, so the badge is per note, not per thread.
function OriginBadge({ origin, provider }: { origin: ReviewThreadNote['origin']; provider?: string }) {
  if (origin === 'local_only') {
    return (
      <Tooltip content="Local to Hydra - only you can see this. It was never posted to the pull request." variant="card">
        <span className="flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 rounded px-1 py-px cursor-help">
          <Laptop className="w-3 h-3" />
          private
        </span>
      </Tooltip>
    )
  }
  const name = provider === 'gitlab' ? 'GitLab' : provider === 'github' ? 'GitHub' : 'the forge'
  return (
    <Tooltip content={`Posted on ${name} - everyone on the pull request can see this.`} variant="card">
      <span className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400 cursor-help">
        <ProviderIcon provider={provider} className="w-3 h-3" />
      </span>
    </Tooltip>
  )
}

// ReviewThreadCard renders one forge review conversation inline under the diff
// line it anchors to: its notes (forge and local-only, in order), a reply box
// that can post to the forge or stay local, and a menu whose main act is handing
// the thread to the agent. See docs/review-threads.md.
export function ReviewThreadCard({ thread, actions }: { thread: ReviewThread; actions: ReviewThreadActions }) {
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'forge' | 'local' | 'agent' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'forge' | 'local' | 'agent', fn: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
      if (kind !== 'agent') { setText(''); setReplying(false) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const btn = 'px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer disabled:opacity-50'

  return (
    <div className="border-y border-violet-200 dark:border-violet-900/60 bg-violet-50/40 dark:bg-violet-950/20 px-4 py-2">
      <div className="flex items-start gap-2">
        <MessageSquare className="w-3.5 h-3.5 mt-1 shrink-0 text-violet-500" />
        <div className="min-w-0 flex-1">
          {thread.notes.map((n, i) => (
            <div key={n.id} className={i > 0 ? 'mt-2 pt-2 border-t border-violet-200/60 dark:border-violet-900/40' : ''}>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200 truncate">
                  {n.author || 'someone'}
                </span>
                {noteAgo(n.created_at) && (
                  <span className="text-[10px] text-gray-400">{noteAgo(n.created_at)}</span>
                )}
                <span className="ml-auto shrink-0 flex items-center gap-1">
                  <OriginBadge origin={n.origin} provider={actions.provider} />
                  {i === 0 && (
                    <div className="relative">
                      <Tooltip content="Thread actions" side="top">
                        <button
                          type="button"
                          aria-label="Thread actions"
                          onClick={() => setMenuOpen((o) => !o)}
                          className="p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-violet-100 dark:hover:bg-violet-900/40 cursor-pointer"
                        >
                          <EllipsisVertical className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                      {menuOpen && (
                        <>
                          {/* Click-away layer: a thread card can sit anywhere in a long
                              diff, so the menu closes on any outside click. */}
                          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                          <div className="absolute right-0 top-5 z-50 w-56 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
                            <button
                              type="button"
                              disabled={busy === 'agent'}
                              onClick={() => { setMenuOpen(false); void run('agent', () => actions.resolveWithAgent(thread)) }}
                              className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/60 cursor-pointer disabled:opacity-50"
                            >
                              <Sparkles className="w-3.5 h-3.5 mt-px shrink-0 text-violet-500" />
                              <span>
                                <span className="block text-xs text-gray-700 dark:text-gray-200">Resolve with agent</span>
                                <span className="block text-[10px] text-gray-400 leading-snug">Send this thread to the head and ask it to address the comment.</span>
                              </span>
                            </button>
                            {thread.url && (
                              <a
                                href={thread.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={() => setMenuOpen(false)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 cursor-pointer"
                              >
                                <ExternalLink className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                                Open on the forge
                              </a>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </span>
              </div>
              <Markdown text={n.body} className="mt-0.5 text-xs text-gray-700 dark:text-gray-200 break-words" />
            </div>
          ))}

          <div className="mt-2 flex items-center gap-2">
            {thread.resolved && (
              <span className="flex items-center gap-1 text-[10px] text-green-700 dark:text-green-300">
                <Check className="w-3 h-3" /> resolved
              </span>
            )}
            {thread.outdated && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">outdated</span>
            )}
            {!replying && (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="text-[10px] text-violet-700 dark:text-violet-300 hover:underline cursor-pointer"
              >
                Reply
              </button>
            )}
            {busy === 'agent' && (
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <LoaderCircle className="w-3 h-3 animate-spin" /> sending to the agent...
              </span>
            )}
          </div>

          {replying && (
            <div className="mt-2">
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
                    e.preventDefault()
                    void run('forge', () => actions.reply(thread.id, text))
                  } else if (e.key === 'Escape') setReplying(false)
                }}
                placeholder="Reply... (Ctrl+Enter to post on the pull request)"
                className="w-full h-16 p-2 text-xs leading-5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded outline-none focus:ring-1 focus:ring-violet-500"
              />
              <div className="flex justify-end gap-2 mt-1.5">
                <button type="button" onClick={() => { setReplying(false); setText('') }} className={`${btn} text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700`}>
                  Cancel
                </button>
                <Tooltip content="Save the reply in Hydra only - the reviewer will not see it." side="top">
                  <button
                    type="button"
                    disabled={!text.trim() || busy !== null}
                    onClick={() => void run('local', () => actions.replyLocal(thread.id, text))}
                    className={`${btn} flex items-center gap-1 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20`}
                  >
                    <Laptop className="w-3 h-3" />
                    {busy === 'local' ? 'Saving...' : 'Keep private'}
                  </button>
                </Tooltip>
                <button
                  type="button"
                  disabled={!text.trim() || busy !== null}
                  onClick={() => void run('forge', () => actions.reply(thread.id, text))}
                  className={`${btn} text-white bg-violet-600 hover:bg-violet-700`}
                >
                  {busy === 'forge' ? 'Posting...' : 'Reply on PR'}
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-1 text-[10px] text-red-500 break-words">{error}</p>}
        </div>
      </div>
    </div>
  )
}
