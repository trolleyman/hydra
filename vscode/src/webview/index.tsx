import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { postMessage, vscode } from './bridge'
import { ChatView } from './components/ChatView'
import { HistoryView } from './components/HistoryView'
import { ProfilesView } from './components/ProfilesView'
import { dedupe, foldStream, type Event, type Projection } from './model'
import type { Approval, HistoryEntry, HostFrame, QuestionResult, ViewState } from './types'

function App() {
  const [state, setState] = useState<ViewState>({ page: 'chat', profile: '', profiles: [], running: false, hasConversation: false })
  const [events, setEvents] = useState<Event[]>([])
  const [projection, setProjection] = useState<Projection>()
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [subagents, setSubagents] = useState<Record<string, Event[]>>({})
  const [draft, setDraft] = useState(() => String((vscode.getState() as { draft?: string } | undefined)?.draft ?? ''))
  const [error, setError] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [questionResults, setQuestionResults] = useState<Record<string, QuestionResult>>({})
  const [attachments, setAttachments] = useState<{ path: string; name: string }[]>([])

  useEffect(() => {
    const consume = (frame: HostFrame) => {
      if (frame.type === 'state_snapshot') setProjection(frame.projection)
      if (frame.type === 'chat_history') setEvents(current => dedupe([...frame.events, ...current]))
      if (frame.type === 'chat_event') {
        setEvents(current => dedupe([...current, frame.event]))
        if (frame.event.type.endsWith('_delta')) setProjection(current => foldStream(current, frame.event))
        if (['assistant_message', 'reasoning_completed', 'turn_completed', 'turn_failed', 'turn_interrupted'].includes(frame.event.type)) setProjection(current => current ? { ...current, stream: undefined } : current)
      }
      if (frame.type === 'subagent_events') setSubagents(current => ({ ...current, [frame.agent_id]: frame.events }))
      if (frame.type === 'approval_request') setApprovals(current => [...current.filter(item => item.request_id !== frame.request_id), frame])
      if (frame.type === 'operation_result') {
        setApprovals(current => current.filter(item => item.request_id !== frame.request_id))
        if (frame.request_id.startsWith('question-response:')) {
          const requestID = frame.request_id.slice('question-response:'.length)
          setQuestionResults(current => ({ ...current, [requestID]: { error: frame.ok ? undefined : frame.error || 'The provider did not accept this answer.', version: (current[requestID]?.version ?? 0) + 1 } }))
        }
      }
      if (frame.type === 'host_error') setError(frame.message)
    }
    const listener = (message: MessageEvent<any>) => {
      const data = message.data
      if (data.type === 'state') { setState(data); applyAppearance(data.appearance) }
      if (data.type === 'clearConversation') { setEvents([]); setProjection(undefined); setSubagents({}); setApprovals([]); setQuestionResults({}); setError('') }
      if (data.type === 'history') setHistory(data.entries)
      if (data.type === 'hostExit') setError(data.message)
      if (data.type === 'hostFrame') consume(data.frame as HostFrame)
      if (data.type === 'hostFrames') for (const frame of data.frames as HostFrame[]) consume(frame)
      if (data.type === 'selectedFiles') setAttachments(current => [...new Map([...current, ...data.files].map(file => [file.path, file])).values()])
    }
    window.addEventListener('message', listener)
    postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', listener)
  }, [])

  useEffect(() => { vscode.setState({ draft }) }, [draft])
  const send = (queued = false) => {
    const text = draft.trim()
    if (!text && !attachments.length) return
    postMessage({ type: 'sendMessage', text, attachments: attachments.map(file => file.path), queued })
    setDraft('')
    setAttachments([])
  }

  return <main className="flex h-full min-h-0 flex-col bg-[var(--vscode-sideBar-background,var(--vscode-editor-background))] text-[var(--vscode-foreground)]">
    {state.networkMode === 'advisory' && <Banner kind="warning">Network restrictions are advisory on this host and can be bypassed by child processes.</Banner>}
    {state.networkMode === 'unrestricted' && <Banner kind="warning">This profile allows unrestricted network access.</Banner>}
    {error && <Banner kind="error">{error}</Banner>}
    {state.page === 'history'
      ? <HistoryView entries={history} labels={state.profileLabels ?? {}} />
      : state.page === 'profiles'
        ? <ProfilesView state={state} />
        : <ChatView state={state} events={events} projection={projection} subagents={subagents} approvals={approvals} questionResults={questionResults} draft={draft} attachments={attachments} onRemoveAttachment={path => setAttachments(current => current.filter(file => file.path !== path))} onDraftChange={setDraft} onSend={send} />}
  </main>
}

function applyAppearance(value?: ViewState['appearance']): void {
  const style = document.getElementById('hydra-appearance')
  if (!style) return
  const family = (input: string | undefined, fallback: string) => input && /^[\w ,"'-]+$/.test(input) ? input : fallback
  const size = (input: number | undefined, fallback: number) => `${Number.isFinite(input) ? Math.max(10, Math.min(20, input!)) : fallback}px`
  style.textContent = `:root{--hydra-ui-font:${family(value?.interfaceFontFamily, 'Inter')},var(--vscode-font-family,sans-serif);--hydra-chat-font:${family(value?.chatFontFamily, 'Merriweather')},serif;--hydra-code-font:${family(value?.codeFontFamily, 'Fira Code')},var(--vscode-editor-font-family,monospace);--hydra-ui-size:${size(value?.interfaceFontSize, 13)};--hydra-chat-size:${size(value?.chatFontSize, 14)};--hydra-code-size:${size(value?.codeFontSize, 12)}}`
}

function Banner({ kind, children }: { kind: 'warning' | 'error'; children: React.ReactNode }) {
  return <div className={`border-b px-3 py-2 text-xs leading-relaxed ${kind === 'error' ? 'border-[var(--vscode-inputValidation-errorBorder)] bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-errorForeground)]' : 'border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)] text-[var(--vscode-inputValidation-warningForeground,var(--vscode-foreground))]'}`}>{children}</div>
}

createRoot(document.getElementById('root')!).render(<App />)
