import { Markdown } from '../lib/MarkdownRenderer'
import { ChangeStats } from './ChangeStats'

/* eslint-disable react-refresh/only-export-components -- the card's formatting and style tokens are deliberately shared with its callers */

export interface CommitCardCommit {
  shortSha: string
  message: string
  authorName?: string
  timestamp?: string
  additions?: number
  deletions?: number
}

export function formatCommitDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Split a commit message into its subject and body the way git does.
export function commitParts(message: string): { subject: string; body: string } {
  const nl = message.indexOf('\n')
  if (nl < 0) return { subject: message.trim(), body: '' }
  return { subject: message.slice(0, nl).trim(), body: message.slice(nl + 1).trim() }
}

export const COMMIT_CARD_WIDTH = 440

export const COMMIT_SHA_CHIP =
  'font-mono text-3xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded shrink-0'

// Shared by commit selectors and transcript chips so a commit always opens the
// same author/date/message card, wherever the user encounters it.
export function CommitCard({ commit }: { commit: CommitCardCommit }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-gray-500 dark:text-gray-400">
          <span className={COMMIT_SHA_CHIP}>{commit.shortSha}</span>
          {commit.authorName && <span className="text-gray-600 dark:text-gray-300">{commit.authorName}</span>}
          {commit.authorName && commit.timestamp && <span className="text-gray-400 dark:text-gray-500">&middot;</span>}
          {commit.timestamp && <span>{formatCommitDate(commit.timestamp)}</span>}
        </div>
        <ChangeStats additions={commit.additions} deletions={commit.deletions} />
      </div>
      <div className="border-t border-gray-200 pt-2 dark:border-gray-700">
        <Markdown
          text={commit.message}
          hardBreaks={false}
          className="text-xs leading-relaxed text-gray-700 dark:text-gray-200"
        />
      </div>
    </div>
  )
}
