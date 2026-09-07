import { Clock3, MessageSquare, Trash2 } from 'lucide-react'
import React from 'react'
import { postMessage } from '../bridge'
import type { HistoryEntry } from '../types'
import { IconButton, PageHeading } from './ui'

export function HistoryView({ entries, labels }: { entries: HistoryEntry[]; labels: Record<string, string> }) {
  return <section className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
    <div className="mx-auto max-w-3xl">
      <PageHeading title="Chat history" detail="Resume a conversation from this workspace." />
      {entries.length ? <div className="overflow-hidden rounded-lg border border-[var(--hydra-border)] bg-[var(--hydra-surface)]">{entries.map(entry => <div className="group flex items-center border-b border-[var(--hydra-border-subtle)] last:border-b-0" key={entry.id}>
        <button className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--vscode-list-hoverBackground)]" onClick={() => postMessage({ type: 'openHistory', id: entry.id })}>
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-[var(--vscode-descriptionForeground)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1"><strong className="truncate text-xs font-medium">{entry.title}</strong><span className="flex flex-wrap items-center gap-x-1.5 text-3xs text-[var(--vscode-descriptionForeground)]"><span>{entry.provider}</span><span aria-hidden="true">/</span><span>{labels[entry.profile] ?? entry.profile}</span><span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{relativeTime(entry.updatedAt)}</span></span></span>
        </button>
        <IconButton className="mr-1 opacity-60 group-hover:opacity-100" label={`Delete ${entry.title}`} onClick={() => postMessage({ type: 'deleteHistory', id: entry.id })}><Trash2 className="size-3.5" /></IconButton>
      </div>)}</div> : <div className="rounded-lg border border-dashed border-[var(--hydra-border)] px-4 py-8 text-center"><MessageSquare className="mx-auto mb-2 size-5 text-[var(--vscode-descriptionForeground)]" /><p className="m-0 text-xs font-medium">No chats yet</p><p className="mt-1 mb-0 text-3xs text-[var(--vscode-descriptionForeground)]">Your conversations will appear here after you start one.</p></div>}
    </div>
  </section>
}

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return new Date(value).toLocaleDateString()
}
