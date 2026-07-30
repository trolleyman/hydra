import { useEffect, useRef, useState } from 'react'
import { Check, Copy, EllipsisVertical, EyeOff, LoaderCircle, MessageSquare, Sparkles } from 'lucide-react'
import type { ReviewThread, ReviewThreadNote } from '../api'
import { Markdown } from '../lib/MarkdownRenderer'
import { Tooltip } from './Tooltip'
import { ProviderIcon } from './ReviewControls'
import { providerLabel } from '../lib/forgeDisplay'
import { formatStartedAgo } from '../lib/agentDisplay'
import { HighlightedTextarea } from './HighlightedTextarea'
import { copyWithToast } from '../lib/copyToast'

// The actions a thread card can perform, supplied by the diff viewer through
// context (see reviewThreadContext) so the memo'd hunks between them never need
// to thread these props through.
export interface ReviewThreadActions {
  // provider drives the origin badge + button labels ("github" | "gitlab").
  provider?: string
  // reply posts to the forge as the user; replyLocal keeps the note inside Hydra.
  reply: (threadId: string, body: string) => Promise<void>
  replyLocal: (threadId: string, body: string) => Promise<void>
  // commentOnLine starts a NEW thread on the PR from the diff's comment box.
  commentOnLine: (path: string, line: number, body: string) => Promise<void>
  // resolveWithAgent asks the head to address this thread (an agent-pull prompt,
  // the same pattern as "Fix the merge conflicts").
  resolveWithAgent: (thread: ReviewThread) => Promise<void>
  // setResolved marks a thread dealt with BY NUMBER - the same call a Hydra
  // comment takes, because they share one numbering. Local to Hydra; it is never
  // sent to the forge.
  setResolved?: (number: number, resolved: boolean) => Promise<void>
  // draft persists the in-progress reply for a thread, so a card that scrolls out
  // of view (unmounting it) or a reload doesn't lose a half-written reply.
  draft: {
    load: (threadId: string) => string
    save: (threadId: string, text: string) => void
    clear: (threadId: string) => void
  }
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
//
// For a forge note the provider mark IS the link out to that comment (with the
// URL in its tip, like the sidebar's repository link), so the common "take me to
// this on GitHub" move needs no menu.
function OriginBadge({ note, provider }: { note: ReviewThreadNote; provider?: string }) {
  if (note.origin === 'local_only') {
    return (
      <Tooltip content="Kept in Hydra - it was never posted to the pull request, so only you can see it.">
        <span className="inline-flex items-center gap-1 h-5 px-1 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 rounded cursor-help">
          <EyeOff className="w-3 h-3" />
          private
        </span>
      </Tooltip>
    )
  }
  const name = providerLabel(provider)
  if (!note.url) {
    return (
      <Tooltip content={`Posted on ${name} - everyone on the pull request can see this.`}>
        <span className="inline-flex items-center justify-center w-5 h-5 text-gray-500 dark:text-gray-400 cursor-help">
          <ProviderIcon provider={provider} className="w-3.5 h-3.5" />
        </span>
      </Tooltip>
    )
  }
  return (
    <Tooltip
      content={
        <>
          <div>Open on {name}</div>
          {/* The URL is the useful part - exactly which comment this opens. */}
          <div className="text-gray-500 dark:text-gray-400 break-all">{note.url}</div>
        </>
      }
    >
      <a
        href={note.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open this comment on ${name}`}
        className="inline-flex items-center justify-center w-5 h-5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors cursor-pointer"
      >
        <ProviderIcon provider={provider} className="w-3.5 h-3.5" />
      </a>
    </Tooltip>
  )
}

// ReviewThreadCard renders one forge review conversation inline under the diff
// line it anchors to: its notes (forge and local-only, in order), a reply box
// that can post to the forge or stay local, and a menu whose main act is handing
// the thread to the agent. See docs/review-threads.md.
export function ReviewThreadCard({ thread, actions }: { thread: ReviewThread; actions: ReviewThreadActions }) {
  const [text, setText] = useState(() => actions.draft.load(thread.id))
  const [replying, setReplying] = useState(() => !!actions.draft.load(thread.id))
  const [busy, setBusy] = useState<'forge' | 'local' | 'agent' | 'resolve' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const forge = providerLabel(actions.provider)
  // HighlightedTextarea has no autoFocus of its own (it forwards a ref to the
  // real textarea), so opening the box focuses it here - with the caret after a
  // restored draft rather than selecting it, so typing appends.
  const replyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!replying) return
    const el = replyRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [replying])

  const changeText = (v: string) => {
    setText(v)
    actions.draft.save(thread.id, v)
  }

  const run = async (kind: 'forge' | 'local' | 'agent' | 'resolve', fn: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
      // Only a REPLY clears the composer; the agent hand-off and the resolve
      // mark leave a half-written reply exactly where it was.
      if (kind === 'forge' || kind === 'local') {
        setText('')
        actions.draft.clear(thread.id)
        setReplying(false)
      }
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
                {/* The number is the handle you would quote ("fix #3"), and it is
                    the SAME sequence Hydra's own comments use - a gutter with two
                    numbering schemes in it would be worse than none. The unread
                    dot rides on it, so what is new and what to call it are one
                    glance. */}
                {n.number != null && (
                  <span className="flex items-center gap-1 shrink-0">
                    {n.read === false && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" title="Unread" />}
                    <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500">#{n.number}</span>
                  </span>
                )}
                <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200 truncate">
                  {n.author || 'someone'}
                </span>
                {noteAgo(n.created_at) && (
                  <span className="text-[10px] text-gray-400">{noteAgo(n.created_at)}</span>
                )}
                {/* Fixed-height row so the badge and the menu trigger share a
                    centre line whichever of them renders. */}
                <span className="ml-auto shrink-0 flex items-center gap-1 h-5">
                  <OriginBadge note={n} provider={actions.provider} />
                  {i === 0 && (
                    <div className="relative flex items-center">
                      <Tooltip content="Thread actions" side="top">
                        <button
                          type="button"
                          aria-label="Thread actions"
                          onClick={() => setMenuOpen((o) => !o)}
                          className="inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-violet-100 dark:hover:bg-violet-900/40 cursor-pointer"
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
                              <Sparkles className="w-3.5 h-3.5 mt-px shrink-0 text-violet-500" fill="currentColor" />
                              <span>
                                <span className="block text-xs text-gray-700 dark:text-gray-200">Resolve with agent</span>
                                <span className="block text-[10px] text-gray-400 leading-snug">Send this thread to the head and ask it to address the comment.</span>
                              </span>
                            </button>
                            {thread.url && (
                              <button
                                type="button"
                                // The menu closes on click, so the confirmation has to
                                // live outside it - the shared copy toast (title + the
                                // URL in a code block), like every other copy action.
                                onClick={() => { setMenuOpen(false); void copyWithToast(thread.url ?? '', { what: 'link to thread' }) }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 cursor-pointer"
                              >
                                <Copy className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                                Copy link to thread
                              </button>
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
              <Tooltip
                content={
                  thread.resolved_locally
                    ? `Resolved in Hydra only - ${providerLabel(actions.provider)} still shows this thread open. Hydra never writes a resolve to a pull request.`
                    : `Resolved on ${providerLabel(actions.provider)}.`
                }
              >
                <span className="flex items-center gap-1 text-[10px] text-green-700 dark:text-green-300 cursor-help">
                  <Check className="w-3 h-3" /> resolved{thread.resolved_locally ? ' here' : ''}
                </span>
              </Tooltip>
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
            {/* Resolving a forge thread is a LOCAL mark (the tooltip above says
                so). It still earns its place: it is what takes the thread out of
                the open count and the next/previous walk, which is the difference
                between a review you can work through and a wall of comments. */}
            {actions.setResolved && thread.notes[0]?.number != null && !thread.notes[0].url?.includes('#resolved') && (
              <button
                type="button"
                disabled={busy === 'resolve'}
                onClick={() => void run('resolve', () => actions.setResolved!(thread.notes[0].number!, !thread.resolved))}
                className="text-[10px] text-gray-500 dark:text-gray-400 hover:underline cursor-pointer disabled:opacity-50"
              >
                {thread.resolved ? 'Reopen' : 'Resolve here'}
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
              {/* The same live inline-markdown highlighting as the chat and spawn
                  composers - review replies are markdown on both forges, so what
                  you type should read like what will be posted. */}
              <HighlightedTextarea
                ref={replyRef}
                value={text}
                onChange={(e) => changeText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
                    e.preventDefault()
                    void run('forge', () => actions.reply(thread.id, text))
                  } else if (e.key === 'Escape') setReplying(false)
                }}
                placeholder={`Reply... (Ctrl+Enter to post on ${forge})`}
                wrapperClassName="w-full h-16 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded focus-within:ring-1 focus-within:ring-violet-500"
                textClassName="p-2 text-xs leading-5"
              />
              <div className="flex justify-end gap-2 mt-1.5">
                <button type="button" onClick={() => { setReplying(false) }} className={`${btn} text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700`}>
                  Cancel
                </button>
                <Tooltip content="Save the reply in Hydra only - the reviewer will never see it." side="top">
                  <button
                    type="button"
                    disabled={!text.trim() || busy !== null}
                    onClick={() => void run('local', () => actions.replyLocal(thread.id, text))}
                    className={`${btn} flex items-center gap-1 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20`}
                  >
                    <EyeOff className="w-3 h-3" />
                    {busy === 'local' ? 'Saving...' : 'Note in Hydra'}
                  </button>
                </Tooltip>
                <button
                  type="button"
                  disabled={!text.trim() || busy !== null}
                  onClick={() => void run('forge', () => actions.reply(thread.id, text))}
                  className={`${btn} flex items-center gap-1 text-white bg-violet-600 hover:bg-violet-700`}
                >
                  <ProviderIcon provider={actions.provider} className="w-3 h-3" />
                  {busy === 'forge' ? 'Posting...' : `Reply on ${forge}`}
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
