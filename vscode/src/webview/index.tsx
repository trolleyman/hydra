import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { components } from '../generated/protocol'
import './style.css'

const vscode = acquireVsCodeApi()

type State = { page: 'chat' | 'history' | 'profiles'; profile: string; pendingProfile?: string; profiles: string[]; running: boolean; hasConversation: boolean }
type HostFrame = components['schemas']['HostFrame']
type Event = Extract<HostFrame, { type: 'chat_event' }>['event']

function App() {
  const [state, setState] = useState<State>({ page: 'chat', profile: '', profiles: [], running: false, hasConversation: false })
  const [events, setEvents] = useState<Event[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const listener = (message: MessageEvent<any>) => {
      const data = message.data
      if (data.type === 'state') setState(data)
      if (data.type === 'clearConversation') { setEvents([]); setError('') }
      if (data.type === 'history') setHistory(data.entries)
      if (data.type === 'hostExit') setError(data.message)
      if (data.type === 'hostFrame') {
        const frame = data.frame as HostFrame
        if (frame.type === 'chat_history') setEvents(current => dedupe([...frame.events, ...current]))
        if (frame.type === 'chat_event') setEvents(current => dedupe([...current, frame.event]))
        if (frame.type === 'host_error') setError(frame.message)
      }
    }
    window.addEventListener('message', listener)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', listener)
  }, [])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    vscode.postMessage({ type: 'sendMessage', text })
    setDraft('')
  }

  return <main>
    <header>
      <button className="profile" onClick={() => vscode.postMessage({ type: 'cycleProfile' })} title="Cycle profile (Shift+Tab)">{state.profile || 'Profile'}</button>
      <nav>
        <button aria-label="New chat" onClick={() => vscode.postMessage({ type: 'newChat' })}>＋</button>
        <button aria-label="History" onClick={() => vscode.postMessage({ type: 'showPage', page: 'history' })}>◷</button>
        <button aria-label="Profiles" onClick={() => vscode.postMessage({ type: 'showPage', page: 'profiles' })}>⚙</button>
      </nav>
    </header>
    {error && <div className="error">{error}</div>}
    {state.page === 'history' ? <History entries={history} /> : state.page === 'profiles' ? <Profiles state={state} /> : <>
      <section className="conversation">
        {!events.length && <div className="empty"><h2>What are we working on?</h2><p>Claude and Codex run inside the active Hydra profile.</p></div>}
        {events.map(event => <EventRow key={event.seq} event={event} />)}
      </section>
      <footer>
        <textarea value={draft} rows={3} placeholder="Ask Hydra..." onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); vscode.postMessage({ type: 'cycleProfile' }) }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
        }} />
        <div className="composerBar"><span>{state.pendingProfile ? `${state.profile} -> ${state.pendingProfile} after turn` : state.profile}</span>{state.running ? <button onClick={() => vscode.postMessage({ type: 'interrupt' })}>Stop</button> : <button onClick={send}>Send</button>}</div>
      </footer>
    </>}
  </main>
}

function EventRow({ event }: { event: Event }) {
  const payload = (event.payload ?? {}) as Record<string, any>
  if (event.type.endsWith('_delta') || event.type === 'usage_updated') return null
  if (event.type === 'user_message') return <article className="message user">{textFrom(payload)}</article>
  if (event.type === 'assistant_message') return <article className="message assistant">{String(payload.text ?? '')}</article>
  if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type.startsWith('reasoning_')) {
    return <details className="step" open={event.type === 'tool_started'}><summary>{stepTitle(event.type, payload)}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>
  }
  if (event.type.startsWith('subagent_')) return <details className="step subagent"><summary>{payload.description ?? payload.id ?? 'Sub-agent'} · {payload.status ?? event.type.replace('subagent_', '')}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>
  if (event.type === 'interaction_requested') return <article className="approval"><strong>Approval required</strong><p>{payload.question ?? payload.summary ?? 'The agent needs your input.'}</p></article>
  return null
}

function History({ entries }: { entries: any[] }) {
  return <section className="page"><h2>Chat history</h2>{entries.length ? entries.map(entry => <button className="historyRow" key={entry.id}><strong>{entry.title}</strong><span>{entry.provider} · {entry.profile}</span></button>) : <p>No historical chats yet.</p>}</section>
}

function Profiles({ state }: { state: State }) {
  return <section className="page"><h2>Profiles</h2><p>Profiles control sandboxed tools, paths, network access, MCP servers, prompts, and Git.</p>{state.profiles.map(name => <div className="profileRow" key={name}><strong>{name}</strong>{name === state.profile && <span>Active</span>}</div>)}<button onClick={() => vscode.postMessage({ type: 'openSettings' })}>Open profile settings</button></section>
}

function textFrom(payload: Record<string, any>): string {
  if (typeof payload.text === 'string') return payload.text
  if (Array.isArray(payload.content)) return payload.content.map(item => item?.text ?? '').join('')
  return ''
}

function stepTitle(type: string, payload: Record<string, any>): string {
  if (type.startsWith('reasoning_')) return 'Reasoning'
  return `${payload.name ?? 'Tool'}${payload.status ? ` · ${payload.status}` : ''}`
}

function dedupe(events: Event[]): Event[] {
  return [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)
}

createRoot(document.getElementById('root')!).render(<App />)
